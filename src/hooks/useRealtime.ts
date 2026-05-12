import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, debugLog } from "../lib/invoke-bridge";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from "@openai/agents/realtime";
import type { FunctionTool, RealtimeOutputGuardrail, RealtimeItem } from "@openai/agents/realtime";
import { samuelAgent } from "../lib/samuel";
import { registerSendImage, registerSendText, registerScreenTarget, registerSendSilentContext, registerSendTextAndRespond, registerReloadPlugins, notifyLearningLanguage, registerSetVolume, registerSetPassiveListening, registerDiscardLastTurn, registerInjectCorrection } from "../lib/session-bridge";
import { loadAllPlugins } from "../lib/plugin-loader";

// ---------------------------------------------------------------------------
// Output Guardrails — monitor Samuel's speech in real-time and cut off if needed.
// Each guardrail runs periodically as transcript text accumulates.
// If tripwireTriggered=true, Samuel's audio is cancelled and the policyHint
// is fed back to the model so it self-corrects.
// ---------------------------------------------------------------------------

// Module-level shared state for guardrails to access the latest tool result.
// The hook below updates this on every agent_tool_end event so the
// no_hallucination guardrail can verify specific factual claims.
let __latestToolResult: { name: string; text: string; ts: number } | null = null;
// When observe_screen runs, the actual content lives in an image we send to
// the session — text-based claim verification can't see it. Track the most
// recent vision pass so the guardrail can defer to vision instead of
// (incorrectly) flagging Boshen Feng / Amazon.com / etc as hallucinated.
let __latestVisionAtMs = 0;
function updateLatestToolResult(r: { name: string; text: string; ts: number }) {
  __latestToolResult = r;
  if (r.name === "observe_screen" || r.name === "computer_use" || r.name === "browser_use") {
    __latestVisionAtMs = r.ts;
  }
}

const outputGuardrails: RealtimeOutputGuardrail[] = [
  {
    name: "no_unprompted_teaching",
    policyHint:
      "Do not teach or explain language vocabulary unless the user explicitly asked for it " +
      "or there is confirmed audio/screen content in the target language. Stay silent about language unless prompted.",
    async execute({ agentOutput }) {
      const text = typeof agentOutput === "string" ? agentOutput : String(agentOutput);
      const teachingPatterns = [
        /\bin japanese\b.*\bmeans?\b/i,
        /\bthe word\b.*\b(means?|is)\b/i,
        /\bvocabulary\b.*\bword\b/i,
        /\bI (heard|noticed|detected|saw)\b.*\b(japanese|chinese|korean)\b/i,
        /\bN[1-5] level\b/i,
      ];
      const hasTeaching = teachingPatterns.some((p) => p.test(text));
      const isUnprompted = hasTeaching && text.length < 300 && !text.includes("[System:");
      return { tripwireTriggered: isUnprompted, outputInfo: { hasTeaching, length: text.length } };
    },
  },
  {
    name: "no_self_conversation",
    policyHint:
      "Stop talking to yourself. Only speak when responding to the user or delivering a tool result. " +
      "Do not narrate, monologue, or repeat yourself.",
    async execute({ agentOutput }) {
      const text = typeof agentOutput === "string" ? agentOutput : String(agentOutput);
      const sentences = text.split(/[.!?]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const unique = new Set(sentences);
      const isRepetitive = sentences.length > 3 && unique.size <= Math.ceil(sentences.length / 3);
      return { tripwireTriggered: isRepetitive, outputInfo: { sentences: sentences.length, unique: unique.size } };
    },
  },
  {
    name: "no_hallucination_after_read",
    policyHint:
      "STOP. You just claimed a specific name, subject, or detail that does NOT appear in " +
      "the most recent tool result. NEVER invent email senders, subjects, dates, amounts, " +
      "or any specific fact. If the AX tree didn't capture the content (Gmail/web apps " +
      "often have sparse AX), say 'I don't see specific email content in the page — let " +
      "me try a screenshot' and call observe_screen. NEVER hallucinate a plausible answer.",
    async execute({ agentOutput }) {
      const text = typeof agentOutput === "string" ? agentOutput : String(agentOutput);
      // Only run within ~30s of the last read-style tool — that's when
      // hallucination from AX-tree-was-thin is most likely.
      const t = __latestToolResult;
      if (!t) return { tripwireTriggered: false, outputInfo: { reason: "no tool result" } };
      const ageMs = Date.now() - t.ts;
      const RELEVANT_TOOLS = new Set([
        "read_app", "list_browser_tabs", "switch_browser_tab", "observe_screen",
        "browser_use", "computer_use", "web_browse",
      ]);
      if (!RELEVANT_TOOLS.has(t.name) || ageMs > 30_000) {
        return { tripwireTriggered: false, outputInfo: { reason: "no recent read tool" } };
      }
      // If the model just took a vision pass (observe_screen / computer_use /
      // browser_use), names and quoted strings it speaks should be coming
      // from the image we sent to the session — not from training data. We
      // can't verify image contents in text, so trust vision and skip
      // text-claim checking. (Without this, real readings like "Boshen Feng"
      // / "Amazon.com" got flagged because they're not in the placeholder
      // result string "Screenshot captured…".)
      if (Date.now() - __latestVisionAtMs < 30_000) {
        return { tripwireTriggered: false, outputInfo: { reason: "recent vision pass — trusting image" } };
      }
      // Only check responses long enough to plausibly contain a claim.
      if (text.length < 25) {
        return { tripwireTriggered: false, outputInfo: { reason: "too short" } };
      }
      const haystack = t.text.toLowerCase();
      // Detect specific factual claims that the model could hallucinate:
      // Two consecutive Capitalized words (likely a person/sender name)
      // or a quoted subject/title.
      const namePattern = /\b([A-Z][a-z]{1,15}) ([A-Z][a-z]{1,20})\b/g;
      const quotedPattern = /["“]([^"”]{4,80})["”]/g;
      // Common sentence-starting words that look capitalized but aren't names.
      // Without these, "My Calvin Rewards" trips because "My Calvin" gets
      // flagged as a sender name when only "Calvin Rewards" is real.
      const PRONOUN_OR_DEMONSTRATIVE = new Set([
        "the", "your", "a", "an", "my", "our", "his", "her", "their",
        "this", "that", "these", "those", "some", "each", "many", "few",
        "all", "any", "both", "either", "neither", "no", "another", "such",
        "what", "which", "whose", "i", "we", "you", "he", "she", "they", "it",
        "let", "one", "two", "good", "hello", "sir", "yes", "no", "ok", "okay",
      ]);
      const claims = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = namePattern.exec(text)) !== null) {
        const w1 = m[1].toLowerCase();
        // Skip if the first word is a pronoun/demonstrative — the second word
        // is the real candidate and will appear in a later regex iteration if
        // it's part of a multi-word name.
        if (PRONOUN_OR_DEMONSTRATIVE.has(w1)) continue;
        const candidate = `${m[1]} ${m[2]}`;
        // Filter conversational filler — but be careful not to swallow real
        // honorific names like "Sir Henry". The "sir" branch was previously
        // `sir [a-z]` which (case-insensitive) also dropped legit names.
        if (/^(let me|one moment|good (morning|evening|night)|hello sir)$/i.test(candidate)) continue;
        claims.add(candidate);
      }
      while ((m = quotedPattern.exec(text)) !== null) {
        if (m[1].length >= 4) claims.add(m[1]);
      }
      if (claims.size === 0) {
        return { tripwireTriggered: false, outputInfo: { reason: "no specific claims" } };
      }
      // Verify each claim. A claim is verified if EITHER the full phrase
      // appears verbatim, OR a strong majority of its salient words appear
      // in the haystack — paraphrasing "Calvin Klein Rewards" as "Calvin
      // Rewards" should not be flagged as a hallucination.
      const STOPWORDS = new Set([
        "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at",
        "is", "it", "as", "by", "be", "with", "from", "this", "that", "these",
        "those", "your", "my", "our", "his", "her", "their", "i", "you", "we",
        "new", "way", "earn", "subject", "from", "received", "pm", "am",
      ]);
      const unverified: string[] = [];
      for (const c of claims) {
        const lc = c.toLowerCase();
        if (haystack.includes(lc)) continue;
        const salient = lc.split(/\W+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
        if (salient.length === 0) continue;
        const found = salient.filter((w) => haystack.includes(w)).length;
        // Treat as paraphrase-verified if ≥60% of salient words are present.
        if (found / salient.length >= 0.6) continue;
        unverified.push(c);
      }
      const tripped = unverified.length > 0;
      return {
        tripwireTriggered: tripped,
        outputInfo: { tool: t.name, ageMs, unverified, claimCount: claims.size },
      };
    },
  },
];

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

/** Merge core + plugin tools, letting plugins override core tools by name. */
function mergeTools(coreTools: FunctionTool[], pluginTools: FunctionTool[]): FunctionTool[] {
  const pluginNames = new Set(pluginTools.map((t) => t.name));
  const filtered = coreTools.filter((t) => !pluginNames.has(t.name));
  return [...filtered, ...pluginTools];
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "status" | "approval";
  text: string;
  timestamp: number;
  /** Present only for role === "approval" */
  approval?: {
    toolName: string;
    args?: Record<string, unknown>;
    state: "pending" | "approved" | "denied";
  };
}

// Session keepalive & rotation constants
const HEARTBEAT_INTERVAL_MS = 30_000; // ping every 30s to prevent server-side idle timeout
const SESSION_ROTATION_MS = 25 * 60 * 1000; // reconnect every 25 min (before 60-min hard cap)
const CONTEXT_WINDOW_TURNS = 6; // carry this many turns across reconnections
const AUTO_SCREEN_COOLDOWN_MS = 5_000; // min 5s between auto-screen injections to prevent token flood
// When the AX content is identical to the previous inject AND we injected
// within this window, skip the inject entirely. The model already has the
// screenshot + AX in its conversation history. Larger window = less waste,
// but eventually the user does want a fresh look — 60s is a balance.
const CTX_DEDUP_WINDOW_MS = 60_000;
// If transcript hasn't arrived this long after speech_stopped, fall back to capturing
// context anyway — transcription is occasionally slow or fails.
const TRANSCRIPT_WAIT_MS = 2_500;
// Short utterances like "yes", "sounds good", "thanks" don't need a fresh screen
// capture — the prior turn's context is still in the conversation. Skipping the
// AX read + screenshot saves ~1-2s, ~150 KB of tokens, and a screenshot upload.
// Pure single-thought acks: short reactions to the *previous* reply where
// the current screen is NOT a new source of information. We intentionally
// EXCLUDE bare imperatives like "do it", "do that", "tell me", "say it" —
// those are either real commands (need fresh context) or mistranscriptions
// of questions ("how are you doing" → "do it"); skipping context on them
// produced the greeting-loop bug. The compositional form ("yes, do it" /
// "ok, tell me") is still caught by COMPOSITIONAL_ACK_RE below.
const ACK_PHRASES = new Set([
  "ok", "okay", "yes", "yeah", "yep", "yup", "no", "nope", "sure",
  "thanks", "thank you", "thx", "ty", "got it", "sounds good", "good",
  "great", "cool", "nice", "alright", "right", "correct", "exactly",
  "perfect", "awesome", "fine", "done", "stop", "wait",
  "go on", "go ahead", "continue", "please continue", "keep going",
  "carry on", "move on", "move along", "next",
  "tell me more", "more",
  "really", "interesting", "wow", "huh", "hmm", "ah", "oh",
  "i see", "makes sense", "noted", "understood", "agreed",
  "let me think", "hold on", "one second", "one moment",
]);

// Compositional acks like "yes continue" / "no don't" / "ok go on" /
// "alright tell me now". Strict exact-match misses these because of the
// prefix word, but they are unambiguously acks/feedback against the
// previous turn — current screen is irrelevant.
const COMPOSITIONAL_ACK_RE =
  /^(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|alright|all\s+right|right|please|fine)[,.\s]+(?:continue|go\s+on|go\s+ahead|do\s+(?:it|that)|carry\s+on|keep\s+going|tell\s+me(?:\s+(?:now|more))?|move\s+on|don'?t|do\s+not|stop|next|please)\b/i;

// Reactive feedback / corrections about the previous reply. The screen
// hasn't changed; the user is just steering Samuel. Capturing fresh
// context here is wasted, AND the new context can pull the model back
// to the wrong answer (saw this in the log — repeated identical reply
// after "don't make this kind of mistake again").
const FEEDBACK_RE =
  /^(?:no[,.\s]+(?:that(?:'|\u2019)?s|that\s+is|don'?t|do\s+not|stop)|don'?t\s+(?:make|repeat|say|do|tell|use)|stop\s+(?:repeating|saying|doing)|that(?:'|\u2019)?s\s+(?:wrong|incorrect|not\s+(?:right|correct))|you(?:'|\u2019)?re\s+wrong|wrong\s+answer|come\s+on)\b/i;

// Whisper-style transcription bias. HARD LIMIT 1024 chars enforced by the
// Realtime API; if exceeded the whole session.update is rejected, which
// silently strips `instructions` + `tools` from the session — Samuel comes
// up as a generic assistant with no tools. Keep this terse, keyword-style.
// Buckets in priority order:
//   1) wake-word variants
//   2) ambient-watcher controls (most-misheard phrases — "watch for",
//      "trigger", "N2 level", "remind me less often")
//   3) UI nouns the user actually says (page/video/tab/monitor — not
//      "lane" or "meal")
//   4) common app commands
//   5) meta / takeover phrases
//   6) language-study terms + Japanese code-switching
// Whisper-style bias prompt for gpt-4o-transcribe. Per OpenAI speech-to-text
// docs (https://developers.openai.com/api/docs/guides/speech-to-text#prompting):
// the prompt biases the decoder TOWARD phrases that appear in it. So this
// list must contain ONLY terms Whisper genuinely struggles with — proper
// nouns, rare jargon, code-switched scripts. NEVER bait common English
// commands or chitchat: a phrase like "just do it" in the prompt makes
// "how are you doing" → "do it" plausible from a noisy/clipped clip.
//
// HARD LIMIT 1024 chars enforced by the Realtime API; if exceeded, the
// whole session.update is rejected and Samuel comes up as a generic
// assistant with no tools.
const TRANSCRIPTION_BIAS_PROMPT =
  "Samuel — Mac voice assistant: desktop control, language study, ambient watchers. " +
  "Wake: Samuel, Sam, Sammy. " +
  "Watchers: watch for, watch out for, trigger, alert me, notify me, remind me, " +
  "remind less often, batch, digest, once when, cooldown, debounce, classifier, " +
  "stop watching, pause it, drop unused, " +
  "JLPT N5 N4 N3 N2 N1 level vocabulary. " +
  "UI: page, video, tab, window, monitor, screen, link, sidebar, browser, app. " +
  "Apps: Gmail, Calendar, Cursor, Chrome, Notes, CapCut, Spotify, Finder, WeChat. " +
  "Language: translate, explain grammar, romaji, hiragana, katakana, kanji, " +
  "particle, conjugation, pitch accent. " +
  "Code-switch: 'how do you say X in Japanese' (X = Japanese phrase from screen).";

// Static guard — fail fast in dev so a future edit doesn't silently strip
// the whole session config again. Realtime API ceiling is 1024.
if (TRANSCRIPTION_BIAS_PROMPT.length > 1024) {
  throw new Error(
    `TRANSCRIPTION_BIAS_PROMPT is ${TRANSCRIPTION_BIAS_PROMPT.length} chars, ` +
      `must be <= 1024. Trim before shipping.`,
  );
}

// Wake-phrase detector for passive-listening mode. Matches typical Whisper
// transcriptions of "Samuel" / "Sammy" addressed at the start or middle of
// an utterance. Tuned to fire on real addressing, not coincidental mentions
// (e.g. somebody on a podcast saying the word "Samuel").
const WAKE_PATTERN = /\b(hey\s+)?(samuel|sammy|samly|sam(?:\s|,|$))\b/i;

function addressesSamuel(text: string): boolean {
  if (!text) return false;
  return WAKE_PATTERN.test(text);
}

function isConversationalAck(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[.!?,'"…]/g, "").trim();
  if (!normalized) return false;
  // 1) Exact phrase match (single-word + canonical multi-word acks).
  if (ACK_PHRASES.has(normalized)) return true;
  // 2) Compositional acks ("yes continue", "ok go on", "no don't").
  //    Bounded to short phrases (<=6 words) so genuinely-content-bearing
  //    sentences like "no don't open the email yet" are still caught
  //    later — those need a real answer, not just an ack.
  const wordCount = normalized.split(/\s+/).length;
  if (wordCount <= 6 && COMPOSITIONAL_ACK_RE.test(text)) return true;
  // 3) Reactive feedback / correction of the previous reply. Screen is
  //    not the source of new information here — the user is steering.
  if (wordCount <= 12 && FEEDBACK_RE.test(text)) return true;
  return false;
}

// Words that mean "talk about whatever is currently on my screen". If
// any of these appear, we MUST capture fresh AX + screenshot — the
// model needs current screen state to answer.
const REFERENTIAL_PATTERN =
  /\b(this|that|here|highlighted|selected|currently|on (?:the|my) screen|on (?:the|this) page|the (?:current|active) (?:tab|page|window))\b/i;

// Verbs that imply the model will call tools to navigate/fetch fresh data.
// For these, the auto-injected AX + screenshot is wasted ~1.3s of latency
// because the model is going to grab fresh data via tools regardless.
const COMMAND_VERB_PATTERN =
  /^(?:hey\s+(?:samuel|sammy|sam)[,.\s]+)?(?:can\s+you\s+|could\s+you\s+|please\s+|just\s+)?(?:play|open|launch|start|switch|navigate|go\s+to|find|search|pull\s+up|show\s+me|read\s+me|bring\s+up|check\s+(?:my|on)|tell\s+me\s+(?:about\s+)?(?:my|the\s+latest)|what(?:'?s| is)\s+(?:my|the)\s+(?:latest|new|next|most\s+recent))\b/i;

// Specific apps/services the user might reference. Mentioning any of these
// almost always means "use tools to access that app". Don't bother capturing
// the current screen.
const SERVICE_PATTERN =
  /\b(gmail|email|inbox|youtube|spotify|doordash|uber\s*eats|amazon|github|calendar|wechat|telegram|slack|discord(?!\s+message)|reddit|twitter|linkedin|messages\s+app)\b/i;

// Meta / self-referential / chitchat questions where the user's screen has
// nothing to do with the answer. Capturing AX + screenshot here is pure
// waste — ~1.3s of latency, ~150 KB of tokens, and a JPEG retry-loop just
// so the model can answer "I can do X, Y, Z" or "I'm doing well, sir."
//
// Conservative on purpose: only matches phrases that are obviously about
// Samuel himself, generic greetings, or ask-the-AI-for-content prompts.
// False positives here just answer without screen context — fine for these.
const META_QUESTION_PATTERN =
  /\b(?:what\s+(?:else\s+)?can\s+you\s+do|what(?:'?s| is| are)\s+your\s+(?:capabilit|featur|abilit|power|skill|tool|function|name|favorite)|what\s+do\s+you\s+do|how\s+do\s+you\s+work|who\s+(?:are|made)\s+you|what\s+are\s+you|tell\s+me\s+about\s+yourself|are\s+you\s+(?:an?\s+)?(?:ai|robot|human|real|there)|how\s+are\s+you(?:\s+doing)?|how(?:'?s| is)\s+it\s+going|how(?:'?s| is)\s+(?:your|things)|what(?:'?s| is)\s+up|good\s+(?:morning|afternoon|evening|night)|say\s+(?:hi|hello|something)|tell\s+me\s+a\s+(?:joke|story|fact)|sing\s+(?:me\s+)?a\s+song)\b/i;

/**
 * Decide whether to skip auto-injected AX + screenshot context for a turn.
 * Skipping saves ~1.3s of capture/encode/inject latency before the model
 * can begin speaking — important for command-intent utterances where the
 * model will use tools to fetch fresh data anyway. Always errs toward
 * keeping context (false → capture) when ambiguous.
 *
 * Priority: META > SERVICE > REFERENTIAL > COMMAND.
 *   - META questions ("what can you do", "how are you", "tell me a joke")
 *     are about Samuel himself or general chitchat — screen is irrelevant.
 *   - SERVICE always wins because mentioning Gmail/YouTube/etc means the
 *     model will navigate to that service via tools regardless of what's
 *     currently on screen. ("click on that YouTube tab" → list_browser_tabs)
 *   - REFERENTIAL ("translate this", "what does that say") keeps context
 *     because the user is pointing at the current screen.
 *   - COMMAND verbs (play/open/find/...) without a service skip — model
 *     will fetch fresh data via tools.
 */
function shouldSkipAutoContext(transcript: string): boolean {
  if (!transcript) return false;
  // META: "what can you do", "how are you", "tell me a joke" — pure
  // chitchat / self-referential questions. Current screen adds no value.
  if (META_QUESTION_PATTERN.test(transcript)) return true;
  // SERVICE mention — model will use tools to access that service.
  if (SERVICE_PATTERN.test(transcript)) return true;
  // COMMAND + referential ("translate this email" with no service) → keep
  // context because the user is pointing at the current screen.
  if (REFERENTIAL_PATTERN.test(transcript)) return false;
  if (COMMAND_VERB_PATTERN.test(transcript.trim())) return true;
  return false;
}

// Common English function words used to sanity-check that a transcript is
// actually English (not romanized foreign-language bleed from media).
const ENGLISH_SIGNAL_WORDS = new Set([
  "i", "me", "my", "you", "your", "we", "us", "our", "he", "she", "they",
  "it", "this", "that", "these", "those", "the", "a", "an", "and", "or",
  "but", "is", "are", "was", "were", "am", "be", "been", "have", "has",
  "had", "do", "does", "did", "can", "could", "will", "would", "should",
  "what", "where", "when", "why", "how", "who", "which", "in", "on", "at",
  "to", "for", "of", "with", "from", "by", "about", "as", "if", "so",
  "not", "no", "yes", "ok", "okay", "please", "thanks", "thank",
  "tell", "show", "read", "open", "check", "find", "look", "see",
  "play", "stop", "start", "make", "let", "give", "get", "go", "come",
  "say", "samuel",
  // Conversational acks, feedback, praise — these were causing real user
  // turns like "Perfect. Good job." to be misclassified as foreign-language
  // media noise (3 tokens with zero signal hits → dropped).
  "perfect", "good", "great", "nice", "awesome", "cool", "fine", "right",
  "wrong", "sure", "exactly", "true", "false", "correct", "wrong",
  "job", "work", "done", "try", "again", "now", "more", "less",
  "really", "very", "much", "many", "some", "all", "none", "always",
  "never", "just", "still", "even", "only", "back", "next", "first",
  "last", "well", "fix", "fixed", "bug", "thing", "stuff",
]);

/**
 * Detects transcripts that look like media bleed (anime dialogue, music
 * lyrics, foreign-language video) rather than a real English command.
 *
 * Returns true when:
 *   - >30% of the chars are non-Latin script (CJK / Cyrillic / Arabic /
 *     Thai / etc.) AND we're not in language-learning mode, OR
 *   - it's mostly Latin-but-not-English: zero recognized English signal
 *     words across 3+ tokens.
 *
 * False negatives are fine; false positives drop a real user turn, which
 * is worse — keep this conservative.
 */
function looksLikeMediaNoise(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Language-learning mode legitimately wants foreign audio; skip filter.
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("samuel-learning-language")) {
      return false;
    }
  } catch { /* ignore */ }

  // Service or command-verb mention is enough signal that this is a real
  // command, even when surrounding tokens got mistranscribed (Whisper
  // routinely hears French/Spanish words for English ones — e.g.
  // "Open my Gmail" → "pour ma Gmail.", "Show my email" → "Chao mi email.").
  // The service name alone is the intent; don't drop on signal-word counts.
  if (SERVICE_PATTERN.test(trimmed)) return false;
  if (COMMAND_VERB_PATTERN.test(trimmed)) return false;
  // Wake-word addressed turns are user intent regardless of signal words.
  if (WAKE_PATTERN.test(trimmed)) return false;

  // 1) Non-Latin script density check
  // Matches CJK, Hiragana, Katakana, Cyrillic, Arabic, Thai, Hebrew, Devanagari
  const nonLatinRe = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g;
  const nonLatinCount = (trimmed.match(nonLatinRe) ?? []).length;
  const letterCount = (trimmed.match(/\p{L}/gu) ?? []).length || 1;
  if (nonLatinCount / letterCount > 0.3) return true;

  // 2) Latin-script-but-no-English-signal-words check
  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length >= 3) {
    const hits = tokens.filter((t) => ENGLISH_SIGNAL_WORDS.has(t)).length;
    if (hits === 0) return true;
  }

  return false;
}

// Architectural backstop for the LLM say-do gap (the model emits "I'll do
// X" prose without the matching tool call). We detect forward-looking
// commitments paired with action verbs that map to real tools, so a turn
// finishing with commitment + tool_calls=0 can be nudged back to action.
// Pure descriptive answers ("here's what the article says") don't match.
const SAYDO_COMMIT_RE =
  /\b(?:i(?:'|\u2019)ll|i will|let me|let'?s|i(?:'|\u2019)m going to|here we go|here you go|on it|drafting|proposing|installing|fetching|building|creating|reading|opening|switching)\b/i;
const SAYDO_ACTION_RE =
  /\b(?:build|create|draft|propose|generate|install|fetch|read|open|focus|switch|send|write|search|look\s+up|look\s+for|check|watch|register|set\s+up|fix|repair|navigate|click|press|type|tool|plugin|article|url|inbox|tab|page|file|gmail|calendar|chrome|safari|notes|messages|slack|discord)\b/i;
// Memory / feedback acks — the model accepts a correction or commits to a
// future-behavior change. These look like commitments ("I'll remember")
// but require ZERO tool calls; they're a valid reply to "don't do that
// again". Without this exclusion, the say-do nudge fires a second
// response.create that re-runs the prior wrong answer (#repeated).
const SAYDO_MEMORY_ACK_RE =
  /\b(?:i(?:'|\u2019)ll\s+(?:remember|keep\s+(?:that|this)\s+in\s+mind|make\s+a\s+(?:mental\s+)?note|try|be\s+(?:more\s+)?careful|avoid|stop)|noted(?:,?\s+sir)?|understood(?:,?\s+sir)?|got\s+it|i\s+see|apologies|sorry|my\s+(?:mistake|apologies))\b/i;
// Phrases that frame what follows as descriptive analysis, not a future
// action. "Save" matched too aggressively on "saves time" / "savings" —
// hence dropped from SAYDO_ACTION_RE entirely; "remember" stays out for
// the same reason.
function looksLikeUnactedCommitment(text: string): boolean {
  if (!text || text.length < 8) return false;
  // Strip quoted spans — "I'll" inside a quote is reporting speech, not
  // a commitment by Samuel.
  const stripped = text.replace(/"[^"]*"|"[^"]*"/g, " ");
  // Memory/feedback acks are NOT action commitments — they finish the
  // turn correctly with zero tool calls.
  if (SAYDO_MEMORY_ACK_RE.test(stripped)) return false;
  return SAYDO_COMMIT_RE.test(stripped) && SAYDO_ACTION_RE.test(stripped);
}

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface UseRealtimeReturn {
  status: ConnectionStatus;
  transcript: TranscriptEntry[];
  agentState: "idle" | "listening" | "thinking" | "speaking";
  screenTarget: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  mute: (muted: boolean) => void;
  isMuted: boolean;
  setWakeWordMode: (on: boolean) => void;
  setSuppressIdle: (suppress: boolean) => void;
  prefetchKey: () => void;
  /** Stop Samuel mid-speech (e.g. "stop talking" button) */
  interrupt: () => void;
  /** Approve a pending tool call by its transcript entry ID */
  approveToolCall: (entryId: string) => void;
  /** Deny a pending tool call by its transcript entry ID */
  denyToolCall: (entryId: string) => void;
  /** Approve + remember per-app permission so this app is never asked again */
  alwaysAllowApp: (entryId: string, appName: string) => void;
  /** Deny + remember per-app permission so this app is always blocked */
  alwaysDenyApp: (entryId: string, appName: string) => void;
  /** Send a typed text message (shows in transcript + triggers model response) */
  sendText: (text: string) => void;
}

// Common hallucinations the transcriber produces from speaker echo / room reverb.
// Checked only within the echo guard window (first few seconds after agent speaks).
const ECHO_PHRASES = new Set([
  "thank you",
  "thanks",
  "you",
  "bye",
  "okay",
  "ok",
  "yes",
  "yeah",
  "no",
  "hmm",
  "hm",
  "hello",
  "hi",
  "hey",
  "good evening",
  "good morning",
  "good night",
  "good day",
  "good day sir",
  "good evening sir",
  "good morning sir",
  "sir",
  "chatgpt",
  "send me",
  "thank you sir",
  "thanks sir",
  "at your service",
  "how may i",
  "how may i assist",
  "how may i assist you",
  "how may i be of assistance",
  "how can i help",
  "how can i assist",
  "samuel",
  "samly",
  "kit",
]);

let entryCounter = 0;
function makeEntry(
  role: TranscriptEntry["role"],
  text: string,
): TranscriptEntry {
  return { id: String(++entryCounter), role, text, timestamp: Date.now() };
}

export function useRealtime(): UseRealtimeReturn {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [agentState, setAgentState] = useState<
    "idle" | "listening" | "thinking" | "speaking"
  >("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [screenTarget, setScreenTarget] = useState<string | null>(null);
  const screenTargetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const micStreamRef = useRef<Promise<MediaStream | undefined> | null>(null);

  // Pending tool approvals — maps transcript entry ID to the SDK approval item
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingApprovalsRef = useRef<Map<string, any>>(new Map());

  // Conversation context buffer — carried across reconnections
  const contextRef = useRef<ConversationTurn[]>([]);

  // Timers for keepalive and session rotation
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRotatingRef = useRef(false);
  // Promise chain that serializes session.updateAgent() calls so the
  // initial-connect path and plugin-reload path can't tangle if they overlap.
  const agentUpdateChainRef = useRef<Promise<void>>(Promise.resolve());

  // Pre-fetched ephemeral key — start the API call before connect() to overlap latency
  const prefetchedKeyRef = useRef<Promise<string> | null>(null);

  // Streaming assistant buffer
  const assistantBufferRef = useRef("");
  const assistantEntryIdRef = useRef<string | null>(null);

  // Placeholder entry for the user's speech (inserted early so ordering is correct)
  const userPendingIdRef = useRef<string | null>(null);

  // Track whether the user manually muted so we don't override their choice
  const userMutedRef = useRef(false);

  // Echo guard: timestamp when agent last finished speaking.
  // Transcriptions arriving shortly after are likely echo, not real user speech.
  const lastAgentSpeechEndRef = useRef(0);

  // Keep track of the last full agent response text — used to detect echo that
  // partially repeats what Samuel just said.
  const lastAgentTextRef = useRef("");

  // Count completed agent responses. The first response is always the greeting —
  // any VAD trigger immediately after it is guaranteed to be echo, not user speech.
  const agentResponseCountRef = useRef(0);

  // Rate-limit auto-screen injections to prevent flooding the session with images.
  const lastAutoScreenRef = useRef(0);
  // Track the last auto-screen item ID so we can delete stale screenshots.
  // Only ONE screenshot should exist in context at a time (prevents "this" confusion).
  const lastScreenItemIdRef = useRef<string | null>(null);
  // Hash of the last AX text we injected. We skip re-injection when the
  // screen hasn't materially changed — the model already has it.
  const lastAxHashRef = useRef<string>("");
  // Wallclock of the last successful context inject. When AX is unchanged
  // AND the previous inject is still recent, we skip re-injection entirely
  // (saves ~1.3s of capture+upload latency every turn). The screenshot is
  // still in conversation history; the model can reference it.
  const lastInjectAtRef = useRef<number>(0);

  // Deferred-context state: speech_stopped sets this up but waits for the
  // transcript before deciding whether to capture+inject screen data.
  // - pendingTurnRef.current is true between speech_stopped and the decision
  //   (transcript completed OR fallback timeout).
  // - pendingTurnTimerRef fires the fallback if transcription is silent.
  const pendingTurnRef = useRef(false);
  const pendingTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Forward declaration; the actual function is defined inside the session
  // setup closure (it needs access to sessionRef, etc.). We assign through
  // this ref so the speech_stopped fallback timer can call it.
  const decideAndRespondRef = useRef<((transcript: string) => void) | null>(null);

  // Passive-listening mode: when true, Samuel ignores VAD-triggered turns
  // unless the transcript explicitly addresses him by name. The user toggles
  // this via the set_listening_mode tool ("Hey Samuel, that's the video,
  // not me" → switch to passive). Chat input + wake-word reconnects always
  // bypass this gate.
  const passiveListeningRef = useRef(false);

  // True while a response is being generated (audio may still be playing).
  // Mic stays muted until this goes false + delay, preventing mid-sentence cutoff.
  const responseInProgressRef = useRef(false);

  // Wake word mode: after Samuel speaks, don't auto-unmute. Instead start an
  // inactivity timer. If user speaks within the window, keep going. If not,
  // mute mic and set agentState to "idle" (signals wake word should re-enable).
  const wakeWordModeRef = useRef(false);
  const suppressIdleRef = useRef(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether passive listening was auto-engaged by the idle timer (vs
  // explicitly via the set_listening_mode tool). Auto-engaged passive should
  // self-disengage on the next wake-word turn; explicit passive must be
  // turned off by the user.
  const autoPassiveRef = useRef(false);
  // Count of consecutive transcripts dropped as media noise. When this hits
  // MEDIA_NOISE_PASSIVE_THRESHOLD we auto-arm passive listening so background
  // video / TV doesn't keep eating the mic and freezing the UI on "thinking".
  // Any clean transcript resets the counter.
  const mediaNoiseStreakRef = useRef(0);
  const MEDIA_NOISE_PASSIVE_THRESHOLD = 2;
  // Say-do guard: true once we've nudged Samuel for a commitment-without-
  // tool-call this user-turn. Reset on the next speech_stopped so the
  // nudge fires at most once per turn (no infinite re-prompt loop).
  const saydoRetriedRef = useRef(false);
  const saydoNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-Reflexion: capture structural tool failures as long-term lessons.
  // Each entry keyed by `${tool}:${error_type}:${try_instead}` so the same
  // pattern persists once per session. Cap total auto-lessons to keep noise
  // out of the corrections store; transient/user-fault errors never persist.
  const autoLessonsThisSessionRef = useRef<Set<string>>(new Set());
  const AUTO_LESSON_CAP = 5;

  const clearInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  };

  // After AUTO_PASSIVE_TIMEOUT_MS of post-response idle, auto-arm the
  // wake-word gate so ambient speech (the user talking to someone else, a
  // video playing, room noise that survived VAD) doesn't get treated as a
  // command. Wake word ("Samuel") on the next turn auto-disengages it; the
  // user does not have to manually un-passive. Manual passive (the
  // set_listening_mode tool) is independent and left alone here.
  //
  // 30s is a deliberate balance: long enough not to interrupt natural
  // pause-then-follow-up, short enough that "you find the flight while I go
  // to the kitchen" actually catches the kitchen conversation.
  const AUTO_PASSIVE_TIMEOUT_MS = 30_000;

  // Single source of truth for engaging auto-passive (wake-word gate).
  // Both the idle timer and the media-noise streak detector funnel through
  // this so engagement never fires twice and the status message stays
  // consistent.
  const armAutoPassive = useCallback((reason: string, statusMessage?: string) => {
    if (passiveListeningRef.current) return false;
    passiveListeningRef.current = true;
    autoPassiveRef.current = true;
    debugLog("listening-mode", `auto-armed wake-word gate (${reason})`);
    if (statusMessage) {
      setTranscript((prev) => [...prev, makeEntry("status", statusMessage)]);
    }
    return true;
  }, []);

  const startInactivityTimer = () => {
    clearInactivityTimer();
    inactivityTimerRef.current = setTimeout(() => {
      inactivityTimerRef.current = null;
      armAutoPassive(`idle ${AUTO_PASSIVE_TIMEOUT_MS}ms`);
    }, AUTO_PASSIVE_TIMEOUT_MS);
  };

  const stopKeepalive = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
  }, []);

  // Single source of truth for building the updated agent (plugins + memory).
  // Both the initial-connect path and `doReloadPlugins()` route through this
  // so the two paths can't drift on prompt-suffix wording or memory-injection
  // logic. Concurrent updates are serialized through `agentUpdateChainRef`
  // so a plugin reload arriving mid-connect can't tangle with the initial
  // updateAgent() call.
  const buildUpdatedAgent = useCallback(async (
    reason: "connect" | "plugin-reload",
  ): Promise<{ agent: RealtimeAgent; pluginCount: number; memoryChars: number; learningLang: string | null }> => {
    const [pluginTools, memoryCtx] = await Promise.all([
      loadAllPlugins().catch((err) => { console.error("[plugins] load failed:", err); return [] as FunctionTool[]; }),
      invoke<string>("memory_get_context").catch(() => ""),
    ]);
    const coreTools = samuelAgent.tools as FunctionTool[];
    const tools = pluginTools.length > 0 ? mergeTools(coreTools, pluginTools) : coreTools;
    let instructions = samuelAgent.instructions as string;
    if (memoryCtx && memoryCtx !== "No prior context.") {
      instructions += `\n\n# Persistent Memory (from previous sessions)\n${memoryCtx}\nFollow these memories strictly. Do not repeat vocabulary marked as known.\nIMPORTANT: Regardless of any language content in memory above, you MUST speak in ENGLISH unless the user explicitly asks otherwise.`;
    }
    // Only the initial connect re-detects learning language — plugin reload
    // must not clobber whatever the user toggled mid-session.
    const learningLang = reason === "connect"
      ? (memoryCtx.match(/proficiency:(\w+)/i)?.[1] ?? null)
      : null;
    const agent = new RealtimeAgent({
      name: samuelAgent.name,
      instructions,
      tools,
      voice: "ash",
    });
    return { agent, pluginCount: pluginTools.length, memoryChars: memoryCtx.length, learningLang };
  }, []);

  const applyAgentUpdate = useCallback((reason: "connect" | "plugin-reload"): Promise<void> => {
    const next = agentUpdateChainRef.current.then(async () => {
      const target = sessionRef.current;
      if (!target) return;
      try {
        const built = await buildUpdatedAgent(reason);
        await target.updateAgent(built.agent);
        if (built.learningLang) {
          console.log(`[session] auto-detected learning language: ${built.learningLang}`);
          notifyLearningLanguage(built.learningLang);
        }
        console.log(`[session] agent updated (${reason}): ${built.pluginCount} plugin(s), memory=${built.memoryChars > 0 ? "yes" : "no"}`);
      } catch (err) {
        console.error(`[session] agent update failed (${reason}):`, err);
      }
    });
    agentUpdateChainRef.current = next;
    return next;
  }, [buildUpdatedAgent]);

  // Record a conversation turn into the rolling context buffer
  const recordTurn = useCallback((role: "user" | "assistant", text: string) => {
    if (!text.trim()) return;
    contextRef.current.push({ role, text });
    if (contextRef.current.length > CONTEXT_WINDOW_TURNS) {
      contextRef.current = contextRef.current.slice(-CONTEXT_WINDOW_TURNS);
    }
  }, []);

  // Managed audio element for Samuel's voice output — allows volume control.
  // Default volume is below 1.0 so Samuel sits BELOW any media the user is
  // playing (anime, music, video). User can override via the in-app slider
  // or the registerSetVolume() callback below.
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  if (!audioElementRef.current) {
    audioElementRef.current = document.createElement("audio");
    audioElementRef.current.autoplay = true;
    audioElementRef.current.volume = 0.65;
  }

  useEffect(() => {
    // Chromium WebRTC provides hardware-accelerated AEC — no mute workarounds needed.
    micStreamRef.current = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }).catch((e) => {
      console.warn("[session] mic request failed, will use SDK default:", e);
      return undefined;
    });

    const transport = new OpenAIRealtimeWebRTC({
      audioElement: audioElementRef.current!,
    });

    // Stable session ID for tracing — persists across reconnections
    const sessionGroupId = `samuel_${Date.now()}`;

    const session = new RealtimeSession(samuelAgent, {
      transport,
      // gpt-realtime-2 (released May 7, 2026) — GPT-5-class reasoning,
      // 128k context, configurable reasoning effort, stronger instruction
      // following, more reliable tool use, and trained specifically on
      // mid-conversation corrections (the "do it yourself" failure mode).
      // The bundled SDK type list lags but the model name string is accepted
      // via `(string & {})`. Cost: $4/$24 text, $32/$64 audio per 1M tokens.
      // Docs: https://developers.openai.com/api/docs/models/gpt-realtime-2
      //       https://developers.openai.com/api/docs/guides/realtime-models-prompting
      model: "gpt-realtime-2",
      // Output guardrails — cut off unsafe/unwanted speech mid-generation
      outputGuardrails,
      outputGuardrailSettings: { debounceTextLength: 150 },
      // Tracing — correlate all events for debugging
      groupId: sessionGroupId,
      workflowName: "samuel-voice",
      traceMetadata: { app: "samuel", version: "1.0" },
      // Custom tool error formatter — gives the model actionable hints instead of raw errors.
      toolErrorFormatter: ({ toolName, kind, defaultMessage }) => {
        if (kind === "approval_rejected") {
          return `Tool "${toolName}" was not approved by the user. Ask if they want to proceed differently.`;
        }
        return `Tool "${toolName}" error: ${defaultMessage}. Try a different approach or tell the user.`;
      },
      config: {
        // Reasoning effort for gpt-realtime-2. OpenAI's Realtime 2.0 prompting
        // guide: "Start with reasoning.effort: 'low'. Increase only for
        // workflows that require deeper planning." 'low' gives Samuel
        // GPT-5-class reasoning for tool selection / SAY-DO discipline /
        // entity capture without a meaningful latency hit. The SDK type
        // doesn't expose `reasoning` yet (clientMessages.d.ts:82-90), but
        // `providerData` is forwarded verbatim into the session payload
        // (openaiRealtimeBase.js:418). Bump to 'medium' if the agent still
        // commits without acting on multi-step requests.
        // Docs: https://developers.openai.com/api/docs/guides/realtime-models-prompting#set-reasoning-effort
        providerData: {
          reasoning: { effort: "low" },
        },
        audio: {
          input: {
            transcription: {
              // gpt-4o-transcribe is significantly more accurate than -mini on
              // short clips (1-3s commands), where -mini frequently hallucinates
              // non-English scripts even with `language: "en"` set. The cost
              // bump is small for a voice-first agent.
              model: "gpt-4o-transcribe",
              language: "en",
              // Whisper-style bias prompt. Without this, on very short or
              // noisy audio the transcriber ignores the language hint and
              // emits gibberish in random scripts (e.g. "我們馬幾咩?"). The
              // prompt anchors the decoder in our domain vocabulary so it
              // commits to English even when confidence is low.
              // Whisper bias prompt. HARD LIMIT: 1024 chars. If it overflows,
              // the entire session.update is rejected and Samuel comes up with
              // no tools and no instructions (default Realtime persona).
              // Keep terse keyword-style. Static-asserted below.
              prompt: TRANSCRIPTION_BIAS_PROMPT,
            },
            noiseReduction: { type: "far_field" },
            // Server-VAD tuning (OpenAI canonical defaults: threshold 0.5,
            // prefix_padding_ms 300, silence_duration_ms 500).
            // Docs: https://developers.openai.com/api/docs/guides/realtime-vad#server-vad
            //
            // We previously ran threshold:0.9 / silence:1200 to suppress
            // false positives, but combined with `far_field` noise reduction
            // (already aggressive) those values clipped low-energy onsets
            // ("how", "where", "what") and added 700ms of latency every turn.
            // With the front of the utterance gone, the bias prompt could
            // pull "...you doing" → "do it". Settle near canonical with a
            // small safety margin over the defaults.
            turnDetection: {
              type: "server_vad",
              threshold: 0.6,
              prefixPaddingMs: 400,
              silenceDurationMs: 700,
              // CRITICAL: do NOT auto-respond on speech_stopped.
              // We manually trigger response.create AFTER injecting AX tree + screenshot,
              // so the model has full context before generating its reply.
              create_response: false,
            },
          },
          output: {
            voice: "ash",
          },
        },
      },
    });

    sessionRef.current = session;

    // Register volume control so tools/preferences can adjust Samuel's voice
    registerSetVolume((pct: number) => {
      if (audioElementRef.current) {
        audioElementRef.current.volume = Math.max(0, Math.min(1, pct / 100));
      }
    });

    // Register passive-listening toggle. When passive=true, decideAndRespond
    // drops VAD-triggered turns that don't address Samuel by name.
    registerSetPassiveListening((passive: boolean) => {
      passiveListeningRef.current = passive;
      // Explicit toggle wins — clear the auto-passive flag either way so
      // the next wake-word turn doesn't accidentally cancel a deliberate
      // user choice.
      autoPassiveRef.current = false;
      clearInactivityTimer();
      debugLog("listening-mode", passive ? "PASSIVE (manual) — ignore mic until addressed" : "NORMAL — auto-respond to clear speech");
    });

    // Register discard-last-turn handler. The user said something like
    // "that wasn't me" / "that's not my voice" / "ignore that last one":
    // erase the bogus user turn AND any assistant response to it, both
    // from the live SDK history (so the model doesn't remember acting on
    // it) and from the visible transcript UI. We also interrupt any
    // in-flight TTS so Samuel stops talking immediately.
    registerDiscardLastTurn((reason: string) => {
      let cancelled = false;
      try {
        // Stop any in-progress audio response from the discard call itself
        // (Samuel will speak a short ack from the tool result instead).
        session.interrupt();
        cancelled = responseInProgressRef.current;
      } catch { /* no-op if no response in flight */ }

      let removedCount = 0;
      const removedItemIds: string[] = [];
      session.updateHistory((h: RealtimeItem[]) => {
        // Walk backwards to find the most recent user message that we
        // (mistakenly) acted on — skipping past Samuel's tool calls and
        // the immediately-prior discard tool call itself.
        let lastUserIdx = -1;
        for (let i = h.length - 1; i >= 0; i--) {
          const item = h[i];
          if (item.type === "message" && "role" in item && item.role === "user") {
            // Skip the discard request itself (current turn, possibly empty
            // because the transcript hasn't landed yet for this turn).
            if (lastUserIdx === -1) {
              lastUserIdx = i;
              continue;
            }
            // Found the prior user turn — that's the bogus one to discard.
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx < 0) return h;
        // Remove the bogus user turn and EVERYTHING after it up to (but not
        // including) the discard tool call we're currently servicing.
        // In practice, the SDK's tool-call item is appended after we return,
        // so dropping from lastUserIdx through end is correct.
        const toRemove = h.slice(lastUserIdx);
        for (const item of toRemove) {
          if (item.itemId) removedItemIds.push(item.itemId);
        }
        removedCount = toRemove.length;
        return h.slice(0, lastUserIdx);
      });

      // Mirror the same removal in the visible transcript UI. Match by
      // itemId where we have it; otherwise pop the most recent
      // user-then-assistant pair.
      if (removedItemIds.length > 0) {
        setTranscript((prev) => prev.filter((e) => !e.id || !removedItemIds.includes(e.id)));
      } else {
        // Fallback: pop the trailing assistant + last user entry from UI.
        setTranscript((prev) => {
          let endIdx = prev.length;
          while (endIdx > 0 && prev[endIdx - 1].role === "assistant") endIdx--;
          if (endIdx > 0 && prev[endIdx - 1].role === "user") endIdx--;
          return prev.slice(0, endIdx);
        });
      }

      debugLog("discard", `removed ${removedCount} item(s) — reason: ${reason}`);
      return { removed: removedCount, cancelled };
    });

    // Auto-mute mic while Samuel speaks to prevent echo feedback in WKWebView.
    // Mic stays muted until response.done + delay (not audio_stopped) so the
    // full sentence plays without risk of VAD-triggered cancellation mid-speech.
    session.on("audio_start", () => {
      setAgentState("speaking");
      responseInProgressRef.current = true;
      if (!userMutedRef.current) {
        session.mute(true);
      }
    });

    session.on("audio_stopped", () => {
      lastAgentSpeechEndRef.current = Date.now();
      // Don't unmute here — wait for response.done to ensure full playback
      if (!responseInProgressRef.current) {
        setAgentState("listening");
      }
    });

    let toolTimeoutId: ReturnType<typeof setTimeout> | null = null;
    session.on("agent_tool_start", (_ctx, _agent, tool, details) => {
      setAgentState("thinking");
      const toolName = tool?.name ?? (typeof tool === "string" ? tool : "unknown");
      let argsPreview = "";
      try {
        const args = (details as Record<string, unknown>)?.toolCall ?? details;
        const argsStr = typeof args === "string" ? args : JSON.stringify(args);
        argsPreview = argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr;
      } catch {
        argsPreview = "(could not stringify args)";
      }
      debugLog("tool-call", `START ${toolName} args=${argsPreview}`);
      if (toolTimeoutId) clearTimeout(toolTimeoutId);
      toolTimeoutId = setTimeout(() => {
        debugLog("tool-call", `TIMEOUT ${toolName} — recovering UI from stuck thinking`, "warn");
        setAgentState("listening");
        responseInProgressRef.current = false;
      }, 30_000);
    });
    session.on("agent_tool_end", (_ctx, _agent, tool, result) => {
      if (toolTimeoutId) { clearTimeout(toolTimeoutId); toolTimeoutId = null; }
      setAgentState("listening");
      const toolName = tool?.name ?? (typeof tool === "string" ? tool : "unknown");
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      // Use a much larger preview for read_app (Gmail inbox can have 1000s of
      // chars of email content we need to verify the model isn't hallucinating).
      const previewLen = toolName === "read_app" || toolName === "observe_screen" ? 4000 : 400;
      const preview = resultStr
        ? (resultStr.length > previewLen ? resultStr.slice(0, previewLen) + `...(+${resultStr.length - previewLen} more)` : resultStr)
        : "(empty)";
      debugLog("tool-call", `END   ${toolName} (${resultStr.length} chars) result=${preview}`);
      // Publish the latest tool result so the no-hallucination guardrail can
      // verify Samuel's spoken claims against actual content.
      updateLatestToolResult({ name: toolName, text: resultStr, ts: Date.now() });

      // Tools that read or mutate screen state make the auto-injected context
      // stale (e.g. AX captured Chrome on Discord; switch_browser_tab moves
      // to DoorDash; the model then conflates the two and says "no DoorDash
      // tab found"). Drop the stale context — the tool result IS the truth.
      const stateChangingTools = new Set([
        "read_app",
        "switch_browser_tab",
        "focus_app",
        "desktop_click",
        "press_element",
      ]);
      if (stateChangingTools.has(toolName) && lastScreenItemIdRef.current) {
        const staleId = lastScreenItemIdRef.current;
        try {
          sessionRef.current?.transport.sendEvent({
            type: "conversation.item.delete",
            item_id: staleId,
          });
          debugLog("ctx", `deleted stale auto-context after ${toolName} (item=${staleId})`);
        } catch { /* may already be gone */ }
        lastScreenItemIdRef.current = null;
        lastAxHashRef.current = "";
        lastInjectAtRef.current = 0;
      }

      // Auto-Reflexion: turn structural tool failures into a persisted lesson
      // so future sessions don't repeat the same dead-end. We only persist
      // architectural errors (permission denied, focus lost, action invalid,
      // capability unavailable, hard system/AX error) — never transient
      // not_found / network / timeout / empty / user-fault input errors,
      // because those are state-of-the-world artifacts, not learnable bugs.
      try {
        const trimmed = resultStr.trim();
        if (trimmed.startsWith("{") && trimmed.includes('"ok"')) {
          const parsed = JSON.parse(trimmed) as {
            ok?: boolean;
            error_type?: string;
            message?: string;
            try_instead?: string | null;
          };
          if (parsed.ok === false && typeof parsed.error_type === "string") {
            const STRUCTURAL_ERRORS = new Set([
              "permission",
              "unavailable",
              "system_error",
              "ax_error",
              "invalid_action",
              "focus_lost",
              "rejected",
            ]);
            const errType = parsed.error_type;
            const tryInstead = parsed.try_instead?.trim() ?? "";
            const shortMsg = (parsed.message ?? "").slice(0, 140);
            // Need a try_instead hint — without one there's no actionable
            // next step to encode as a lesson, just a state report.
            if (STRUCTURAL_ERRORS.has(errType) && tryInstead.length > 0) {
              const key = `${toolName}:${errType}:${tryInstead.slice(0, 60)}`;
              if (
                !autoLessonsThisSessionRef.current.has(key) &&
                autoLessonsThisSessionRef.current.size < AUTO_LESSON_CAP
              ) {
                autoLessonsThisSessionRef.current.add(key);
                const lesson =
                  `When ${toolName} returns ${errType}` +
                  (shortMsg ? ` ("${shortMsg}")` : "") +
                  `, prefer: ${tryInstead}.`;
                debugLog("reflexion", `auto-lesson from ${toolName}: ${lesson}`);
                invoke("memory_add_correction", {
                  what: lesson,
                  source: "auto-reflexion",
                }).catch((err: unknown) =>
                  console.warn("[reflexion] persist failed:", err),
                );
              }
            }
          }
        }
      } catch { /* non-JSON tool result — skip */ }
    });

    // Guardrail tripped — Samuel said something he shouldn't have.
    // Use session.interrupt() to immediately stop the audio output.
    session.on("guardrail_tripped", (_ctx, _agent, error) => {
      const name = error?.result?.guardrail?.name ?? "unknown";
      console.warn(`[guardrail] tripped: ${name}`, error.message);
      // Immediately cut off the unwanted speech
      try { session.interrupt(); } catch {}
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `[Guardrail: ${name} — correcting]`),
      ]);
    });

    // Tool approval — show an interactive card the user can approve or deny
    session.on("tool_approval_requested", (_ctx, _agent, request) => {
      if (request.type === "function_approval") {
        const toolName = request.tool.name;
        console.log(`[approval] tool '${toolName}' needs approval`);

        const entryId = String(++entryCounter);
        pendingApprovalsRef.current.set(entryId, request.approvalItem);

        setTranscript((prev) => [
          ...prev,
          {
            id: entryId,
            role: "approval" as const,
            text: `Use tool "${toolName}"`,
            timestamp: Date.now(),
            approval: { toolName, state: "pending" },
          },
        ]);
      } else {
        // MCP / non-function approvals — auto-approve silently
        session.approve(request.approvalItem).catch(() => {});
      }
    });

    // History events — keep SDK history as source of truth for debugging
    session.on("history_updated", (history: RealtimeItem[]) => {
      console.log(`[history] updated: ${history.length} items`);
    });
    session.on("history_added", (item: RealtimeItem) => {
      // Prune stale screenshots from SDK history when a new one arrives.
      // This prevents the model from referencing old "this" screenshots.
      if (item.type === "message" && "role" in item && item.role === "user") {
        const hasImage = ("content" in item) && Array.isArray(item.content) &&
          item.content.some((c: Record<string, unknown>) => c.type === "input_image");
        if (hasImage && lastScreenItemIdRef.current && item.itemId !== lastScreenItemIdRef.current) {
          // Use updateHistory to remove the stale screenshot
          const staleId = lastScreenItemIdRef.current;
          session.updateHistory((h: RealtimeItem[]) =>
            h.filter((i: RealtimeItem) => i.itemId !== staleId)
          );
          console.log(`[history] pruned stale screenshot ${staleId}`);
        }
      }
    });

    session.on("error", (error: unknown) => {
      console.error("[session] error:", error);
      const msg =
        typeof error === "object" && error !== null
          ? JSON.stringify(error, null, 2)
          : String(error);
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Error: ${msg}`),
      ]);
    });

    // Detect server-side session close (idle timeout, network drop, etc.)
    // so the next wake word triggers a fresh reconnect.
    // Handled via transport wildcard events ("session.closed" / "close").

    // ── Smart context-injection decision ──────────────────────────────────
    // Called ONCE per turn after we know the transcript (or fallback timeout).
    // Decides whether to refresh AX/screenshot context based on:
    //   1. Was it a conversational ack? ("sounds good", "ok", "thanks") → skip
    //   2. Has the screen materially changed since last injection? → skip if not
    //   3. Are we still in cooldown / pre-greeting? → skip
    // Always triggers response.create at the end so the model replies.
    const decideAndRespond = (transcript: string) => {
      // Cheap djb2 hash — used to detect whether AX content changed materially.
      const cheapHash = (s: string): string => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
          h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return h.toString(36);
      };

      const triggerResponse = () => {
        try {
          sessionRef.current?.transport.sendEvent({ type: "response.create" });
          debugLog("turn", "response.create triggered");
        } catch (e) {
          debugLog("turn", `response.create failed: ${e}`, "warn");
        }
      };

      const now = Date.now();
      const elapsed = now - lastAutoScreenRef.current;
      const pastGreeting = agentResponseCountRef.current >= 1;

      // Reason 0 (highest priority): passive listening — user told Samuel
      // "that's the video, not me", or the auto-arm timer engaged after
      // post-response idle. Drop the turn unless they explicitly address
      // him. The audio is still committed to conversation history, so when
      // they DO address him later, he can reference what was said.
      if (passiveListeningRef.current && transcript) {
        if (!addressesSamuel(transcript)) {
          debugLog(
            "listening-mode",
            `${autoPassiveRef.current ? "auto-passive" : "passive"}: dropping "${transcript}" (no wake phrase)`,
          );
          return;
        }
        // Wake word present — auto-disengage if it was the timer that
        // armed passive. Manual passive (user said "go quiet") stays on
        // until the user turns it off explicitly.
        if (autoPassiveRef.current) {
          passiveListeningRef.current = false;
          autoPassiveRef.current = false;
          debugLog("listening-mode", `wake word in "${transcript}" — exiting auto-passive`);
        }
      }

      // Reason 1: conversational ack — model has prior context, just respond
      if (transcript && isConversationalAck(transcript)) {
        debugLog("turn", `ack detected ("${transcript}") — skipping context refresh`);
        triggerResponse();
        return;
      }

      // Reason 1b: meta-question or command-intent — screen capture adds
      // no value. Skipping the AX read + screenshot trims ~1-1.5s before
      // the model starts speaking. Examples that skip:
      //   META:    "what else can you do" / "how are you" / "tell me a joke"
      //   SERVICE: "play music on YouTube" / "check my DoorDash order"
      //   COMMAND: "open Mail" / "find that email"
      // Falls back to capture if the user uses referential words ("this",
      // "that", "highlighted", etc.) — those genuinely need current screen.
      if (transcript && shouldSkipAutoContext(transcript)) {
        debugLog("turn", `no-context-needed ("${transcript}") — skipping AX+screenshot`);
        triggerResponse();
        return;
      }

      // Reason 2: still in pre-greeting or recent cooldown
      if (!pastGreeting || elapsed < AUTO_SCREEN_COOLDOWN_MS) {
        debugLog("turn", `skipping context inject (pastGreeting=${pastGreeting}, elapsed=${elapsed}ms)`);
        triggerResponse();
        return;
      }

      lastAutoScreenRef.current = now;

      const axPromise = invoke<string>("read_app_content", { appName: null, multi: true })
        .catch((e) => { debugLog("ctx", `AX read failed: ${e}`, "warn"); return ""; });
      const shotPromise = invoke<{ base64: string; app_name: string; display_context?: string }>("capture_screen_now")
        .catch((e) => { debugLog("ctx", `screenshot failed: ${e}`, "warn"); return null; });

      Promise.all([axPromise, shotPromise]).then(([axText, shot]) => {
        if (!sessionRef.current) return;

        // Hash the FULL AX payload, not just the prefix. The first 6KB of
        // a Chrome window is mostly toolbar / sidebar / tabs and rarely
        // changes; hashing only the prefix would hide real article-content
        // changes and falsely report "unchanged".
        const fullAx = axText ?? "";
        const axHash = fullAx ? cheapHash(fullAx) : "";
        const axChanged = !!axHash && axHash !== lastAxHashRef.current;

        // Truncate AFTER hashing so the model sees more actual content.
        // 24KB ≈ 6K tokens, well within Realtime context budget. The old
        // 6KB ceiling never let the article body through — the model was
        // reduced to OCR'ing the JPEG, which produced wrong-paragraph
        // hallucinations on long pages.
        const AX_INJECT_BUDGET = 24_000;
        const truncated = fullAx.length > AX_INJECT_BUDGET
          ? fullAx.slice(0, AX_INJECT_BUDGET) + "\n...(truncated)"
          : fullAx;

        // Reason 3a: AX is byte-identical to the last inject AND we injected
        // recently. Even if a screenshot is available, sending it again is
        // pure waste — the prior screenshot+AX is still in conversation
        // history and the model can reference it. Saves ~1.3s + ~150KB.
        const sinceLastInject = lastInjectAtRef.current === 0
          ? Number.POSITIVE_INFINITY
          : now - lastInjectAtRef.current;
        if (
          !axChanged &&
          lastScreenItemIdRef.current &&
          sinceLastInject < CTX_DEDUP_WINDOW_MS
        ) {
          debugLog(
            "ctx",
            `screen unchanged + recent inject (${Math.round(sinceLastInject)}ms ago) — skipping`,
          );
          triggerResponse();
          return;
        }

        // Reason 3b: nothing on screen at all (no AX, no screenshot)
        if (!axChanged && !shot?.base64) {
          debugLog("ctx", `screen unchanged (hash=${axHash}) — skipping inject`);
          triggerResponse();
          return;
        }

        // Delete previous context (single-image rule)
        if (lastScreenItemIdRef.current) {
          try {
            sessionRef.current.transport.sendEvent({
              type: "conversation.item.delete",
              item_id: lastScreenItemIdRef.current,
            });
          } catch { /* may already be gone */ }
        }

        const itemId = `ctx_${now}`;
        const content: Array<Record<string, string>> = [];

        if (truncated && truncated.trim().length > 20) {
          content.push({
            type: "input_text",
            text: `[Screen content from all visible apps (Accessibility Tree — exact text):\n${truncated}]`,
          });
        }

        if (shot?.base64) {
          content.push({
            type: "input_image",
            image_url: `data:image/jpeg;base64,${shot.base64}`,
          });
        }

        if (content.length > 0) {
          try {
            sessionRef.current.transport.sendEvent({
              type: "conversation.item.create",
              item: { id: itemId, type: "message", role: "user", content },
            });
            lastScreenItemIdRef.current = itemId;
            lastAxHashRef.current = axHash;
            lastInjectAtRef.current = now;
            debugLog(
              "ctx",
              `injected AX(${axText?.length ?? 0} chars, sent=${truncated.length}, changed=${axChanged}) + screenshot(${shot ? "yes" : "no"}) | item_id=${itemId}`,
            );
          } catch (e) {
            debugLog("ctx", `inject failed: ${e}`, "warn");
          }
        } else {
          debugLog("ctx", "both AX and screenshot empty — no context injected", "warn");
        }

        triggerResponse();
      }).catch((e) => {
        debugLog("ctx", `context promise failed: ${e}`, "warn");
        triggerResponse();
      });
    };
    decideAndRespondRef.current = decideAndRespond;

    // Raw transport events for real-time transcript display
    session.transport.on("*", (event: Record<string, unknown>) => {
      const type = event.type as string;

      switch (type) {
        case "input_audio_buffer.speech_started": {
          debugLog("turn", "speech_started");
          setAgentState("listening");
          // User is speaking — cancel any inactivity timer (keep conversation alive)
          clearInactivityTimer();
          // Insert a placeholder now so the user bubble appears before the agent reply
          const placeholder = makeEntry("user", "...");
          userPendingIdRef.current = placeholder.id;
          setTranscript((prev) => [...prev, placeholder]);
          break;
        }

        case "response.created": {
          const resp = event.response as Record<string, unknown> | undefined;
          debugLog("response", `CREATED id=${resp?.id ?? "?"} status=${resp?.status ?? "?"}`);
          break;
        }

        case "conversation.item.created": {
          const item = event.item as Record<string, unknown> | undefined;
          if (item) {
            const role = item.role as string | undefined;
            const itemType = item.type as string | undefined;
            const itemId = item.id as string | undefined;
            if (role === "user" || itemType === "function_call" || itemType === "function_call_output") {
              const content = item.content as Array<Record<string, unknown>> | undefined;
              const summary = content?.map((c) => `${c.type}:${typeof c.text === "string" ? (c.text as string).slice(0, 60) : ""}`).join("|") ?? "";
              debugLog("item-created", `role=${role ?? itemType} id=${itemId} content=${summary}`);
            }
          }
          break;
        }

        case "input_audio_buffer.speech_stopped":
          setAgentState("thinking");
          // Fresh user turn — clear the say-do retry flag so the next
          // commitment-without-tool case can trigger a single nudge.
          saydoRetriedRef.current = false;
          if (saydoNudgeTimerRef.current) {
            clearTimeout(saydoNudgeTimerRef.current);
            saydoNudgeTimerRef.current = null;
          }
          debugLog("turn", "speech_stopped — waiting for transcript to decide on context");
          // We DEFER the heavy AX read + screenshot until we know what the user
          // actually said. Conversational acks like "sounds good" don't need a
          // fresh screen capture; the prior turn's context is still available.
          // The transcript event normally arrives within a few hundred ms.
          // If it doesn't arrive within TRANSCRIPT_WAIT_MS, we fall back to
          // capturing context anyway (treat as "real query").
          pendingTurnRef.current = true;
          if (pendingTurnTimerRef.current) clearTimeout(pendingTurnTimerRef.current);
          pendingTurnTimerRef.current = setTimeout(() => {
            if (pendingTurnRef.current) {
              debugLog("turn", `no transcript after ${TRANSCRIPT_WAIT_MS}ms — capturing context anyway`);
              pendingTurnRef.current = false;
              decideAndRespondRef.current?.(""); // empty = treat as real query
            }
          }, TRANSCRIPT_WAIT_MS);
          break;

        case "conversation.item.input_audio_transcription.completed": {
          const text = (event.transcript as string)?.trim();
          const pendingId = userPendingIdRef.current;
          userPendingIdRef.current = null;

          debugLog("transcript", `user said: "${text}"`);

          const isNoise = !text || text.length <= 2;

          // Relaxed echo guard: rely on WebRTC AEC + post-speech mute (audio_stopped handler).
          // Only drop confirmed echoes (exact substring of Samuel's last reply or known phrase).
          const msSinceAgentSpoke = Date.now() - lastAgentSpeechEndRef.current;
          const echoWindow = 1500;
          const normalized = text ? text.toLowerCase().replace(/[.!?,'"]/g, "").trim() : "";

          const lastAgentLower = lastAgentTextRef.current.toLowerCase();
          const isPartialEcho = normalized.length > 3 && lastAgentLower.includes(normalized);

          const isLikelyEcho =
            msSinceAgentSpoke < echoWindow &&
            !!text &&
            (ECHO_PHRASES.has(normalized) || isPartialEcho);

          // Detect media bleed: anime dialogue, music lyrics, foreign-language
          // video where the transcript looks coherent but isn't an English
          // command. Without loopback AEC we can't subtract media at the mic,
          // so post-transcript filtering is the next best gate.
          const isMediaNoise = !!text && looksLikeMediaNoise(text);

          if (isNoise || isLikelyEcho || isMediaNoise) {
            if (isLikelyEcho) {
              debugLog("echo-guard", `DROPPED echo "${text}" (${msSinceAgentSpoke}ms after agent)`);
            } else if (isMediaNoise) {
              debugLog("echo-guard", `DROPPED media-noise "${text}"`);
            } else if (isNoise) {
              debugLog("echo-guard", `noise dropped: "${text}"`);
            }
            if (pendingId) {
              setTranscript((prev) => prev.filter((e) => e.id !== pendingId));
            }
            // Cancel any pending turn so the fallback timer doesn't fire and
            // we don't trigger a response for the dropped echo.
            if (pendingTurnRef.current) {
              pendingTurnRef.current = false;
              if (pendingTurnTimerRef.current) {
                clearTimeout(pendingTurnTimerRef.current);
                pendingTurnTimerRef.current = null;
              }
              debugLog("turn", "pending turn cancelled (echo/noise/media)");
            }
            // Crucial: speech_stopped flipped agentState → "thinking". Without
            // this, the UI stays stuck on "thinking" forever after a drop.
            if (!responseInProgressRef.current) {
              setAgentState("listening");
            }
            // Auto-arm wake-word gate when media keeps interfering. Continuous
            // video/TV otherwise floods the mic with noise the user can't talk
            // through. The next "Samuel" / "Sammy" addressing-phrase exits
            // passive automatically (see auto-passive logic above).
            if (isMediaNoise) {
              mediaNoiseStreakRef.current += 1;
              if (mediaNoiseStreakRef.current >= MEDIA_NOISE_PASSIVE_THRESHOLD) {
                armAutoPassive(
                  `${mediaNoiseStreakRef.current} media-noise drops`,
                  "Background media detected \u2014 say \u201cSamuel\u201d to address me.",
                );
              }
            }
            break;
          }
          // Clean transcript reaching this point — reset the media streak so
          // a single intervening user turn re-enables auto-listen behaviour.
          mediaNoiseStreakRef.current = 0;

          recordTurn("user", text);
          if (pendingId) {
            setTranscript((prev) =>
              prev.map((e) => (e.id === pendingId ? { ...e, text } : e)),
            );
          } else {
            setTranscript((prev) => [...prev, makeEntry("user", text)]);
          }

          // Now that we have a real transcript, decide whether to refresh
          // screen context and trigger the response.
          if (pendingTurnRef.current) {
            pendingTurnRef.current = false;
            if (pendingTurnTimerRef.current) {
              clearTimeout(pendingTurnTimerRef.current);
              pendingTurnTimerRef.current = null;
            }
            decideAndRespondRef.current?.(text);
          }
          break;
        }

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta": {
          const delta = event.delta as string;
          if (delta) {
            setAgentState("speaking");
            assistantBufferRef.current += delta;
            if (!assistantEntryIdRef.current) {
              const entry = makeEntry(
                "assistant",
                assistantBufferRef.current,
              );
              assistantEntryIdRef.current = entry.id;
              setTranscript((prev) => [...prev, entry]);
            } else {
              const id = assistantEntryIdRef.current;
              const text = assistantBufferRef.current;
              setTranscript((prev) =>
                prev.map((e) => (e.id === id ? { ...e, text } : e)),
              );
            }
          }
          break;
        }

        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done": {
          const finalText = event.transcript as string;
          if (finalText) {
            lastAgentTextRef.current = finalText;
            recordTurn("assistant", finalText);
            // Feed Samuel's spoken text to the self-voice filter so the
            // learning audio doesn't capture and re-process his own speech.
            invoke("record_samuel_speech", { text: finalText }).catch(() => {});
            if (assistantEntryIdRef.current) {
              const id = assistantEntryIdRef.current;
              setTranscript((prev) =>
                prev.map((e) =>
                  e.id === id ? { ...e, text: finalText } : e,
                ),
              );
            }
          }
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          break;
        }

        case "response.done": {
          // Log response details so we can see what the model decided
          const resp = event.response as Record<string, unknown> | undefined;
          const respStatus = resp?.status as string | undefined;
          const respOutput = resp?.output as Array<Record<string, unknown>> | undefined;
          const finalText = lastAgentTextRef.current || assistantBufferRef.current;
          const toolCalls = (respOutput ?? []).filter((o) => o.type === "function_call" || o.type === "tool_call");
          debugLog("response", `DONE status=${respStatus} text="${finalText.slice(0, 200)}${finalText.length > 200 ? "..." : ""}" tool_calls=${toolCalls.length}`);
          if (toolCalls.length > 0) {
            for (const tc of toolCalls) {
              const argsStr = typeof tc.arguments === "string" ? tc.arguments.slice(0, 200) : JSON.stringify(tc.arguments).slice(0, 200);
              debugLog("response", `  └─ tool: ${tc.name ?? "?"} args=${argsStr}`);
            }
          }

          if (assistantBufferRef.current && assistantEntryIdRef.current) {
            lastAgentTextRef.current = assistantBufferRef.current;
          }
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          agentResponseCountRef.current += 1;
          responseInProgressRef.current = false;
          setAgentState("listening");

          // SAY-DO BACKSTOP: prompt rules are fragile because the model
          // generates prose and tool calls in the same forward pass with
          // no binding between them (see "The Acknowledgment-Action Gap",
          // tianpan.co 2026). When a completed response committed to an
          // action ("I'll create that tool", "let me read the article",
          // "here we go") but emitted zero tool calls, we inject a
          // corrective system message and trigger a fresh response. Once
          // per user-turn — saydoRetriedRef resets on the next speech
          // event so we never enter a retry loop.
          if (
            respStatus === "completed" &&
            toolCalls.length === 0 &&
            !saydoRetriedRef.current &&
            looksLikeUnactedCommitment(finalText)
          ) {
            saydoRetriedRef.current = true;
            debugLog(
              "saydo",
              `commitment with tool_calls=0 detected: "${finalText.slice(0, 120)}"`,
            );
            // Wait for current audio to finish playing before nudging,
            // otherwise the user hears two responses overlap.
            if (saydoNudgeTimerRef.current) clearTimeout(saydoNudgeTimerRef.current);
            saydoNudgeTimerRef.current = setTimeout(() => {
              saydoNudgeTimerRef.current = null;
              // If the user has spoken / a new response is in flight,
              // skip the nudge — they're already correcting Samuel.
              if (responseInProgressRef.current) {
                debugLog("saydo", "skipping nudge — response in progress");
                return;
              }
              try {
                const id = `saydo_${Date.now()}`;
                sessionRef.current?.transport.sendEvent({
                  type: "conversation.item.create",
                  item: {
                    id,
                    type: "message",
                    role: "system",
                    content: [
                      {
                        type: "input_text",
                        text:
                          "[Say-do guard] Your last reply committed to an action " +
                          "but emitted zero tool calls. Either call the matching " +
                          "tool now (web_browse, plugin_manage, watch_for, read_app, " +
                          "etc. per the SAY-DO RULE) — or say in one short sentence " +
                          "why you can't and stop. Do NOT repeat your previous answer.",
                      },
                    ],
                  },
                });
                sessionRef.current?.transport.sendEvent({ type: "response.create" });
                debugLog("saydo", "nudge sent + response.create triggered");
              } catch (e) {
                debugLog("saydo", `nudge failed: ${e}`, "warn");
              }
            }, 1200);
          }

          // NOW unmute — the full response has been generated and audio
          // buffers are flushing. Delay lets remaining audio play out.
          if (!userMutedRef.current && session.muted === true) {
            const isGreeting = agentResponseCountRef.current <= 1;
            const unmuteDelay = isGreeting ? 3000 : 1500;
            setTimeout(() => {
              if (!userMutedRef.current && sessionRef.current) {
                try { sessionRef.current.mute(false); } catch {}
              }
              if (wakeWordModeRef.current) {
                startInactivityTimer();
              }
            }, unmuteDelay);
          }
          break;
        }

        case "response.cancelled": {
          // User interrupted mid-tool or mid-speech — reset state so UI
          // doesn't stay stuck on "thinking/working"
          responseInProgressRef.current = false;
          setAgentState("listening");
          if (!userMutedRef.current && session.muted === true) {
            setTimeout(() => {
              if (!userMutedRef.current && sessionRef.current) {
                try { sessionRef.current.mute(false); } catch {}
              }
            }, 500);
          }
          break;
        }

        case "error": {
          const err = event.error as Record<string, unknown>;
          const msg = (err?.message as string) ?? "Unknown error";
          const code = err?.code as string | undefined;
          const type = err?.type as string | undefined;
          debugLog("session-error", `type=${type} code=${code} msg=${msg}`, "error");
          setTranscript((prev) => [
            ...prev,
            makeEntry("status", `Error: ${msg}`),
          ]);
          break;
        }

        case "session.closed":
        case "close": {
          stopKeepalive();
          if (isRotatingRef.current) {
            // Planned rotation — reconnect() handles the rest
            console.log("[session] planned rotation close");
          } else {
            // Unexpected drop — auto-reconnect if we were connected
            console.log("[session] transport closed unexpectedly, will auto-reconnect");
            setStatus("disconnected");
            setAgentState("idle");
            // Auto-reconnect after a short delay
            setTimeout(() => {
              if (sessionRef.current) {
                console.log("[session] auto-reconnecting...");
                connectRef.current?.();
              }
            }, 2000);
          }
          break;
        }

        default:
          break;
      }
    });

    // Register screen target callback — shows a brief toast of which app was captured
    registerScreenTarget((appName: string) => {
      setScreenTarget(appName);
      if (screenTargetTimerRef.current) clearTimeout(screenTargetTimerRef.current);
      screenTargetTimerRef.current = setTimeout(() => setScreenTarget(null), 3000);
    });

    // Register text bridge so UI actions can prompt Samuel to speak.
    // Uses SDK's sendMessage() which handles item creation + response trigger.
    registerSendText((text: string) => {
      session.sendMessage(text);
    });

    // Plugin reload routes through the hook-level `applyAgentUpdate` so the
    // initial-connect path and reload path share the same builder + chain ref.
    registerReloadPlugins(() => applyAgentUpdate("plugin-reload"));

    // Register the image bridge so tools can inject screenshots.
    // Uses SDK's addImage() — cleaner, handles encoding and error recovery.
    registerSendImage((base64Jpeg: string) => {
      session.addImage(`data:image/jpeg;base64,${base64Jpeg}`, { triggerResponse: false });
    });

    // Silent context: inject background info Samuel can reference but won't speak about.
    // Uses updateHistory to prune the previous context, keeping conversation lean.
    let silentContextId: string | null = null;
    registerSendSilentContext((text: string) => {
      // Prune previous silent context from history
      if (silentContextId) {
        const oldId = silentContextId;
        session.updateHistory((h: RealtimeItem[]) =>
          h.filter((item: RealtimeItem) => item.itemId !== oldId)
        );
      }
      const id = `ctx_${Date.now()}`;
      silentContextId = id;
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
    });

    // Bridge for learning mode: inject a system hint and trigger Samuel to respond.
    // Skips if the model is already generating a response to avoid session saturation.
    // Uses SDK's sendMessage() for proper item creation + response trigger.
    registerSendTextAndRespond((text: string) => {
      if (responseInProgressRef.current) {
        console.log("[session] skipping sendTextAndRespond — model is busy");
        return;
      }
      session.sendMessage(text);
    });

    // In-session correction injection (Reflexion loop). When `record_correction`
    // fires, push the lesson onto the conversation timeline as a system message
    // so the model applies it on the very next turn — no full reconnect, no
    // prompt rebuild, no instruction-update reliability bug.
    //
    // Cap per-session lessons so a runaway loop (e.g. correction-of-correction)
    // can't balloon the context window. Persistent lessons are still re-injected
    // at session start via the system prompt prefix, so dropping in-session
    // duplicates here is purely a context-size guard.
    const SESSION_LESSON_CAP = 25;
    const sessionLessons = new Set<string>();
    registerInjectCorrection((lesson: string) => {
      const trimmed = lesson.trim();
      if (!trimmed) return;
      const fingerprint = trimmed.toLowerCase().replace(/\s+/g, " ").slice(0, 200);
      if (sessionLessons.has(fingerprint)) {
        console.log("[reflexion] dropped duplicate in-session lesson");
        return;
      }
      if (sessionLessons.size >= SESSION_LESSON_CAP) {
        console.log(`[reflexion] hit per-session lesson cap (${SESSION_LESSON_CAP}) — dropping`);
        return;
      }
      sessionLessons.add(fingerprint);
      const id = `lesson_${Date.now()}`;
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `LESSON LEARNED (apply going forward, do not repeat the mistake): ${trimmed}`,
            },
          ],
        },
      });
    });

    // PCM audio injection (sendAudioClip) was removed in commit dea376f after
    // it confused the model's language detection. The bridge slot is left
    // unfilled by design — restore only after the language issue is solved.

    return () => {
      registerSendImage(null);
      registerSendText(null);
      registerScreenTarget(null);
      registerSendSilentContext(null);
      registerSendTextAndRespond(null);
      registerReloadPlugins(null);
      registerDiscardLastTurn(null);
      registerInjectCorrection(null);
      stopKeepalive();
      session.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectRef = useRef<(() => Promise<void>) | null>(null);

  const prefetchKey = useCallback(() => {
    if (!prefetchedKeyRef.current) {
      console.log("[session] prefetching ephemeral key");
      prefetchedKeyRef.current = invoke<string>("create_ephemeral_key").catch((err) => {
        prefetchedKeyRef.current = null;
        throw err;
      });
    }
  }, []);

  const connect = useCallback(async () => {
    if (status === "connected" && !isRotatingRef.current) return;
    stopKeepalive();

    const session = sessionRef.current;
    if (!session) return;

    // If previous session died or rotating, close it cleanly
    try { session.close(); } catch {}

    const isReconnect = contextRef.current.length > 0;
    setStatus("connecting");
    if (!isReconnect) {
      setTranscript([makeEntry("status", "Connecting...")]);
    }

    try {
      // Use prefetched key if available, otherwise fetch with a 10s timeout
      let keyPromise = prefetchedKeyRef.current || invoke<string>("create_ephemeral_key");
      prefetchedKeyRef.current = null;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Ephemeral key request timed out")), 10_000),
      );
      let ephemeralKey: string;
      try {
        ephemeralKey = await Promise.race([keyPromise, timeout]);
      } catch (firstErr) {
        console.warn("[session] first key attempt failed, retrying:", firstErr);
        keyPromise = invoke<string>("create_ephemeral_key");
        ephemeralKey = await Promise.race([keyPromise, timeout]);
      }
      // Log the session config that will be sent to verify voice
      const initConfig = await session.getInitialSessionConfig();
      console.log(`[session] initial config voice: ${(initConfig as Record<string, unknown>).voice ?? "NOT SET"}`, JSON.stringify(initConfig));

      // Inject AEC-enabled mic stream before connecting.
      // The SDK reads transport.options.mediaStream during connect().
      if (micStreamRef.current) {
        const aecStream = await micStreamRef.current;
        if (aecStream) {
          const t = session.transport as unknown as { options: { mediaStream?: MediaStream } };
          t.options.mediaStream = aecStream;
          console.log("[session] using AEC-enabled mic stream (echoCancellation + noiseSuppression)");
        }
      }

      await session.connect({ apiKey: ephemeralKey });

      setStatus("connected");
      setAgentState("listening");
      isRotatingRef.current = false;

      agentResponseCountRef.current = 0;
      // Suppress auto-screen for the first few seconds so the model can greet
      // without being overwhelmed by an image on the very first speech_stopped.
      lastAutoScreenRef.current = Date.now();

      if (isReconnect) {
        // Replay context via updateHistory so Samuel remembers the conversation.
        // This is cleaner than manual sendEvent — the SDK tracks these items properly.
        const turns = contextRef.current.slice(-CONTEXT_WINDOW_TURNS);
        const historyItems: RealtimeItem[] = turns.map((turn, i) => {
          if (turn.role === "user") {
            return {
              itemId: `ctx_replay_${i}`,
              type: "message" as const,
              role: "user" as const,
              status: "completed" as const,
              content: [{ type: "input_text" as const, text: turn.text }],
            };
          }
          return {
            itemId: `ctx_replay_${i}`,
            type: "message" as const,
            role: "assistant" as const,
            status: "completed" as const,
            content: [{ type: "output_text" as const, text: turn.text }],
          };
        });
        session.updateHistory(historyItems);
        console.log(`[session] restored ${turns.length} context turns via updateHistory`);
        setTranscript((prev) => [...prev, makeEntry("status", "Session refreshed")]);

        // Don't re-greet — SDK keeps mic open natively
      } else {
        setTranscript([makeEntry("status", "Connected")]);

        // Inject local time so Samuel's greeting is time-appropriate.
        // Uses sendMessage which creates the item and triggers a response.
        const now = new Date();
        const timeCtx = `[System: Current local time is ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })} on ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Greet the user in ENGLISH with one short sentence. You MUST speak English.]`;

        // Load saved skills and inject summaries so Samuel knows what workflows are available.
        // Skill content is user-authored — sanitize before splicing into a system message
        // so backticks, brackets, or accidental newlines can't break the surrounding markup.
        const sanitizeForInline = (s: string) =>
          s.replace(/[\r\n]+/g, " ").replace(/[`\[\]]/g, "").trim();
        invoke<Array<{ id: string; title: string; trigger: string; summary: string }>>("skill_list_summaries")
          .then((skills) => {
            let fullCtx = timeCtx;
            if (skills.length > 0) {
              const listing = skills
                .map((s) => `- ${sanitizeForInline(s.title)} (id: ${sanitizeForInline(s.id)}): ${sanitizeForInline(s.summary)} (trigger: ${sanitizeForInline(s.trigger)})`)
                .join("\n");
              fullCtx += `\n[System: You have ${skills.length} saved skill(s). Before complex tasks, check if one applies:\n${listing}\nUse skill_manage(action="get", id="...") to load the full steps.]`;
              console.log(`[skills] injected ${skills.length} skill summaries into session`);
            }
            session.sendMessage(fullCtx);
          })
          .catch(() => {
            session.sendMessage(timeCtx);
          });
      }

      // Load plugins + inject persistent memory in one atomic updateAgent call.
      // Serialized through buildUpdatedAgent + applyAgentUpdate so any later
      // plugin reload can't race this initial setup.
      if (sessionRef.current) {
        applyAgentUpdate("connect");
      }

      // Start heartbeat — keeps the Realtime API connection alive during silence.
      // Also detects dead connections: if send throws, trigger auto-reconnect.
      //
      // Implementation note: we send a no-op `session.update` with only
      // `type: "realtime"` because the API now rejects `session: {}` with
      // missing_required_parameter. If a future SDK ships a dedicated ping,
      // swap this for it. Any rejection (rather than transport-level throw)
      // is logged loudly — silently absorbed errors caused us to ship a
      // brittle heartbeat in the past.
      heartbeatRef.current = setInterval(() => {
        const s = sessionRef.current;
        if (!s) return;
        try {
          s.transport.sendEvent({
            type: "session.update",
            session: { type: "realtime" },
          });
        } catch (err) {
          console.warn(
            `[heartbeat] send failed (${err instanceof Error ? err.message : String(err)}) — reconnecting`,
          );
          stopKeepalive();
          setStatus("disconnected");
          setAgentState("idle");
          setTimeout(() => { connectRef.current?.(); }, 1500);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Schedule session rotation before the 60-min hard cap
      rotationTimerRef.current = setTimeout(() => {
        console.log("[session] planned rotation at 25 min");
        isRotatingRef.current = true;
        connectRef.current?.();
      }, SESSION_ROTATION_MS);

    } catch (err) {
      console.error("[connect]", err);
      isRotatingRef.current = false;
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Connection failed: ${err}`),
      ]);
      setStatus("disconnected");
      setAgentState("idle");
    }
  }, [status, stopKeepalive, recordTurn]);

  // Keep connectRef current so auto-reconnect and rotation can call it
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    stopKeepalive();
    contextRef.current = [];
    registerSendImage(null);
    registerScreenTarget(null);
    sessionRef.current?.close();
    setStatus("disconnected");
    setAgentState("idle");
    setIsMuted(false);
    userMutedRef.current = false;
    setTranscript((prev) => [...prev, makeEntry("status", "Disconnected.")]);
  }, [stopKeepalive]);

  const mute = useCallback((muted: boolean) => {
    const session = sessionRef.current;
    userMutedRef.current = muted;
    if (session && session.muted !== null) {
      session.mute(muted);
    }
    setIsMuted(muted);
  }, []);

  const setWakeWordMode = useCallback((on: boolean) => {
    wakeWordModeRef.current = on;
    if (!on) clearInactivityTimer();
  }, []);

  const setSuppressIdle = useCallback((suppress: boolean) => {
    suppressIdleRef.current = suppress;
  }, []);

  // Programmatic interrupt — stops Samuel mid-speech immediately.
  // Useful for a "stop talking" button or when guardrails need to cut off.
  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (session) {
      try {
        session.interrupt();
        responseInProgressRef.current = false;
        setAgentState("listening");
        console.log("[session] interrupted by user/system");
      } catch {}
    }
  }, []);

  const approveToolCall = useCallback((entryId: string) => {
    const item = pendingApprovalsRef.current.get(entryId);
    if (!item) return;
    pendingApprovalsRef.current.delete(entryId);
    sessionRef.current?.approve(item).catch((err: unknown) =>
      console.error("[approval] approve failed:", err),
    );
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "approved" as const } }
          : e,
      ),
    );
  }, []);

  const denyToolCall = useCallback((entryId: string) => {
    const item = pendingApprovalsRef.current.get(entryId);
    if (!item) return;
    pendingApprovalsRef.current.delete(entryId);
    sessionRef.current?.reject(item, { message: "User denied this action." }).catch((err: unknown) =>
      console.error("[approval] reject failed:", err),
    );
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "denied" as const } }
          : e,
      ),
    );
  }, []);

  const alwaysAllowApp = useCallback((entryId: string, appName: string) => {
    // Approve the current request
    const item = pendingApprovalsRef.current.get(entryId);
    if (item) {
      pendingApprovalsRef.current.delete(entryId);
      sessionRef.current?.approve(item).catch((err: unknown) =>
        console.error("[approval] approve failed:", err),
      );
    }
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "approved" as const } }
          : e,
      ),
    );
    // Persist the "always allow" preference
    invoke("set_app_permission", { appName, permission: "always_allow" }).catch((err: unknown) =>
      console.error("[approval] set_app_permission failed:", err),
    );
    console.log(`[approval] always allow: ${appName}`);
  }, []);

  const alwaysDenyApp = useCallback((entryId: string, appName: string) => {
    const item = pendingApprovalsRef.current.get(entryId);
    if (item) {
      pendingApprovalsRef.current.delete(entryId);
      sessionRef.current?.reject(item, { message: `User permanently denied access to ${appName}.` }).catch((err: unknown) =>
        console.error("[approval] reject failed:", err),
      );
    }
    setTranscript((prev) =>
      prev.map((e) =>
        e.id === entryId && e.approval
          ? { ...e, approval: { ...e.approval, state: "denied" as const } }
          : e,
      ),
    );
    invoke("set_app_permission", { appName, permission: "always_deny" }).catch((err: unknown) =>
      console.error("[approval] set_app_permission failed:", err),
    );
    console.log(`[approval] always deny: ${appName}`);
  }, []);

  const sendText = useCallback((text: string) => {
    if (!text.trim()) return;
    setTranscript((prev) => [...prev, makeEntry("user", text.trim())]);
    recordTurn("user", text.trim());
    if (!sessionRef.current) return;
    if (responseInProgressRef.current) {
      console.log("[session] skipping sendText — model is busy");
      return;
    }
    sessionRef.current.sendMessage(text);
  }, [recordTurn]);

  return {
    status,
    transcript,
    agentState,
    screenTarget,
    connect,
    disconnect,
    mute,
    isMuted,
    setWakeWordMode,
    setSuppressIdle,
    prefetchKey,
    interrupt,
    approveToolCall,
    denyToolCall,
    alwaysAllowApp,
    alwaysDenyApp,
    sendText,
  };
}
