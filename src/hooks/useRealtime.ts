import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, debugLog } from "../lib/invoke-bridge";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from "@openai/agents/realtime";
import type { FunctionTool, RealtimeOutputGuardrail, RealtimeItem } from "@openai/agents/realtime";
import { samuelAgent } from "../lib/samuel";
import type { ScreenObservationMode } from "../lib/session-bridge";
import { registerSendImage, registerSendText, registerScreenTarget, registerSendSilentContext, registerSendTextAndRespond, registerReloadPlugins, notifyLearningLanguage, registerSetVolume, registerSetPassiveListening, registerSetScreenObservation, registerDiscardLastTurn, registerInjectCorrection } from "../lib/session-bridge";
import { loadAllPlugins } from "../lib/plugin-loader";

// ---------------------------------------------------------------------------
// Output Guardrails — monitor Samuel's speech in real-time and cut off if needed.
// Each guardrail runs periodically as transcript text accumulates.
// If tripwireTriggered=true, Samuel's audio is cancelled and the policyHint
// is fed back to the model so it self-corrects.
// ---------------------------------------------------------------------------

// "Don't volunteer language lessons" used to be enforced as a tripwire
// guardrail here, but it conflicted with the two paths the system prompt
// already permits — explicit user requests and watcher-fired vocabulary
// alerts.
//
// "no_hallucination_after_read" was also a tripwire guardrail — a regex
// scanner that extracted multi-word capitalized names + quoted phrases
// from Samuel's response and verified them against the latest tool
// result haystack. Removed 2026-05-14: the regex approach is fundamentally
// brittle. It caught some Gmail-sender hallucinations but also tripped on
// legitimate translations (綾小路清隆 → "Kiyotaka Ayanokoji"), romanizations,
// long quoted paraphrases, and any cross-language reading. The realtime
// model already gets the tool result text + screenshots and is the right
// judge of grounding; the prompt's "Truthfulness — never fabricate, always
// verify" + "CITE BEFORE YOU SPEAK" rules carry the policy. The SDK's
// tripwire response (cancel audio + apology+divert template) makes
// false-positives much worse than the occasional ungrounded claim.
//
// The remaining guardrail catches one hard failure mode regex IS reliable
// for: Samuel monologuing the same sentence three times in a row.
const outputGuardrails: RealtimeOutputGuardrail[] = [
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

// Continuous screen observation cadence. When the user flips Samuel into
// "continuous" mode via set_screen_observation, the hook polls the AX
// tree every CONTINUOUS_POLL_MS and pushes a fresh screenshot + AX block
// only when the screen has *materially* changed — both the hash differs
// AND either the length delta exceeds CONTINUOUS_DELTA_BYTES or a
// previously-unseen visible app/window appears. We deliberately do NOT
// push on every hash diff (cursor blink / hover / scroll-by-1px), and
// there is NO timed safety-tick: if nothing changed, we send nothing.
//
// Shipped values reflect bug postmortem 2026-05-14: 8s cadence + 60s
// safety-tick + multi-app dump made each push ~110 KB and accumulated
// ~1 MB of context in 2 minutes, eventually choking server-side VAD.
const CONTINUOUS_POLL_MS = 15_000;
const CONTINUOUS_MIN_PUSH_GAP_MS = 10_000;
const CONTINUOUS_DELTA_BYTES = 200;
// Pause continuous pushes after this much user silence — the user has
// either walked away or switched contexts. Resume on the next real
// user turn (transcribed audio, NOT echo / media noise).
const CONTINUOUS_USER_IDLE_MS = 90_000;
// AX payload truncation budget for continuous-mode pushes. ~16 KB ≈ 4 K
// tokens — tighter than the on-demand read_app limit because we push
// these repeatedly and each one stays in conversation context until
// the next push deletes it.
const CONTINUOUS_AX_BUDGET = 16_000;

// Hard stop phrases — short user utterances that mean "stop talking"
// rather than "ack, keep going". The realtime model's barge-in
// (interrupt_response: true) handles overlapping speech, but if the
// user says one of these BEFORE Samuel finishes a thought (e.g. small
// pause between sentences), barge-in alone won't fire. We catch the
// transcript here, send response.cancel, and refuse to let the model
// keep monologuing. This is the fix for the "Yes, I know. Stop." →
// "Let me explain again from the top!" loop.
const HARD_STOP_PATTERN =
  /^(?:stop|wait|enough|i\s+know|i\s+got\s+it|i\s+understand|got\s+it[,.\s!]+(?:thanks|thank\s+you)?|shut\s+up|quiet|that(?:'|\u2019)?s\s+enough|please\s+stop|no\s+more|never\s+mind|nevermind)[.!?\s]*$/i;

// Whisper-style bias prompt for gpt-4o-transcribe. Per OpenAI speech-to-text
// docs (https://developers.openai.com/api/docs/guides/speech-to-text#prompting):
// the prompt biases the decoder TOWARD phrases that appear in it.
//
// SCOPE — narrow on purpose. This list must contain ONLY terms Whisper
// genuinely struggles with: proper nouns, rare jargon, code-switched
// scripts. NEVER seed common English verbs or chitchat — they pull
// muddy audio toward the seeded token. Concrete failure: an earlier
// version seeded "batch / alert me / remind me / cooldown / debounce"
// to help with watcher commands. Result: "translate the second sentence"
// got transcribed as "Batch the alerts" on noisy audio because every
// watcher verb in the prompt slightly elevated those token logits.
//
// The realtime model (gpt-realtime-2) understands raw audio directly
// and never sees this string. This prompt only affects the side-channel
// transcript shown in chat UI / logs and consumed by the wake-phrase
// detector ("Sammy"). HARD_STOP, ECHO_PHRASES, media-noise, and saydo
// guards do not depend on this prompt.
//
// Allowed buckets:
//   1) Wake-word variants — "Sammy" is genuinely mistranscribed
//      ("Sam, he" / "salmon"); the wake-phrase detector reads this
//      transcript so the seed is load-bearing for that detector.
//   2) Language-study domain terms (JLPT levels, romaji, hiragana,
//      katakana, kanji, pitch accent) — these appear in the chat
//      panel and logs; Whisper otherwise emits "JLPT and 5",
//      "romanji", "pitch agent" etc. The realtime model itself
//      hears the audio directly and does not depend on this seed.
//   3) Latin-script anchor phrase (the leading sentence) to keep
//      the decoder committed to English on sub-second clips — it
//      falls back to random scripts otherwise (historically
//      produced gibberish like 我們馬幾咩?).
//
// App names are NOT seeded here. The realtime model sees apps like
// CapCut / WeChat / Chrome / Notes in its tool descriptions and emits
// the correct argument string regardless of how the side-channel
// transcript spells them. Seeding apps only earned cosmetic chat-UI
// spelling, which isn't worth the prompt budget.
//
// HARD LIMIT 1024 chars enforced by the Realtime API; if exceeded, the
// whole session.update is rejected and Samuel comes up as a generic
// assistant with no tools.
const TRANSCRIPTION_BIAS_PROMPT =
  "Samuel: Mac voice assistant for desktop control and language study. " +
  "Wake words: Samuel, Sam, Sammy. " +
  "Japanese study: JLPT N5 N4 N3 N2 N1, romaji, hiragana, katakana, kanji, " +
  "pitch accent, particle, conjugation.";

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

// Verbs that imply the user is asking Samuel to take an action / navigate.
// Used by the passive-listening exit logic and the media-noise filter to
// distinguish "user issued a command" from "transcriber drifted into
// background dialogue".
const COMMAND_VERB_PATTERN =
  /^(?:hey\s+(?:samuel|sammy|sam)[,.\s]+)?(?:can\s+you\s+|could\s+you\s+|please\s+|just\s+)?(?:play|open|launch|start|switch|navigate|go\s+to|find|search|pull\s+up|show\s+me|read\s+me|bring\s+up|check\s+(?:my|on)|tell\s+me\s+(?:about\s+)?(?:my|the\s+latest)|what(?:'?s| is)\s+(?:my|the)\s+(?:latest|new|next|most\s+recent))\b/i;

// Specific apps/services the user might reference. Mentioning any of these
// almost always means "user wants Samuel to act on that service" — used
// as a wake-word equivalent for auto-passive exit.
const SERVICE_PATTERN =
  /\b(gmail|email|inbox|youtube|spotify|doordash|uber\s*eats|amazon|github|calendar|wechat|telegram|slack|discord(?!\s+message)|reddit|twitter|linkedin|messages\s+app)\b/i;

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

  // Whisper / gpt-4o-transcribe hallucination signature: when the model
  // interprets audio as "quoted dialogue" (someone reading text aloud,
  // fuzzy non-speech segments, or media bleed it can't classify), it
  // returns the text wrapped in literal quotation marks. Real users
  // don't speak text wrapped in quotes. Drop these regardless of
  // learning mode — they ARE the false positives learning mode lets
  // through. Both straight (") and curly (" ") quotes count.
  if (/^["\u201C\u201D].+["\u201C\u201D][.!?]?$/.test(trimmed)) return true;

  // Language-learning mode legitimately wants foreign audio; skip the
  // remaining heuristics (which would over-drop legitimate vocab queries).
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
// Past-tense / present-continuous SELF-RECAP — the model is describing
// what it already did or is currently in the middle of doing for THIS
// turn ("I was checking the screen", "I just read the focused app",
// "I'm describing what I saw"). Followed by a purpose clause ("to
// answer", "so I can report"). These are valid replies to "what are you
// doing?" / "what just happened?" and require no fresh tool call —
// firing saydo here only loops the model into re-running its prior
// (already wrong) behavior.
const SAYDO_RECAP_RE =
  /\b(?:i\s+was\s+(?:checking|reading|looking|inspecting|opening|fetching|searching|describing|explaining|reporting)|i\s+(?:just\s+)?(?:read|checked|opened|fetched|searched|inspected|looked\s+at)|i(?:'|\u2019)m\s+(?:describing|explaining|reporting|telling|showing|inspecting)|i(?:'|\u2019)m\s+not\s+(?:starting|trying)|to\s+(?:answer|ground|confirm|address|clarify)\s+your)\b/i;
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
  // Self-recap explaining what just happened — also not a fresh
  // commitment. Without this, "what are you doing?" answers loop.
  if (SAYDO_RECAP_RE.test(stripped)) return false;
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
  // Bubble pacer: text deltas from gpt-realtime arrive at *generation* speed
  // (very fast), but the audio stream plays at *speech* speed (~15 chars/sec
  // for English, slower for languages with longer syllables). Painting the
  // full text immediately makes the chat bubble race ahead of Samuel's
  // voice — the user reads the punchline before he says it. We instead
  // accumulate deltas in `assistantBufferRef` and reveal them into the
  // visible bubble at a rate matched to TTS playback. On audio_stopped or
  // *_transcript.done we flush the remainder so the bubble never lags
  // behind a finished utterance.
  const assistantRevealedLenRef = useRef(0);
  const assistantRevealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ~16 chars/sec is a typical conversational TTS rate for English realtime
  // voices; CJK transcript characters carry more information per glyph and
  // tolerate a slower reveal, but a single rate is a reasonable approximation.
  const REVEAL_CHARS_PER_SEC = 16;
  const REVEAL_TICK_MS = 60;

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

  // Track the last continuous-mode screenshot item ID so we can delete
  // stale screenshots when a fresh one arrives. Only ONE screenshot
  // should exist in continuous-mode context at a time (prevents "this"
  // confusion).
  const lastScreenItemIdRef = useRef<string | null>(null);

  // ── Screen observation mode (OpenAI lazy-context-fetching pattern) ──
  // Default per session: "on_demand" — Samuel pulls screen context via
  // tools when he needs it, NOT pushed eagerly on every turn. The user
  // can flip this to "continuous" via the set_screen_observation tool
  // ("Samuel, watch what I'm reading"). Mode resets to "on_demand" on
  // every fresh session (Option A) — there's no cross-session persistence.
  const screenObservationModeRef = useRef<ScreenObservationMode>("on_demand");
  // App-scope filter for continuous mode. When set, the tick only reads
  // this single app (~75% smaller payload than the all-visible-apps
  // multi-dump). null → multi-app dump (only when user explicitly asks
  // for cross-app monitoring).
  const screenObservationAppRef = useRef<string | null>(null);
  const screenObservationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Hash + length of the last AX text we pushed in continuous mode.
  // We require BOTH hash to differ AND length-delta to exceed
  // CONTINUOUS_DELTA_BYTES before pushing — protects against
  // sub-pixel/hover/cursor diffs from spamming the session.
  const lastContinuousAxHashRef = useRef<string>("");
  const lastContinuousAxLengthRef = useRef<number>(0);
  // Wallclock of the last continuous-mode push (for the min-push-gap
  // throttle) and the last real user turn (for the idle self-pause).
  const lastContinuousPushAtRef = useRef<number>(0);
  const lastUserSpeechAtRef = useRef<number>(0);

  // Monotonic turn counter — bumped on every speech_started. Currently
  // only used as a defensive guard for any future async per-turn callbacks
  // (e.g. continuous-mode screen capture in flight when a new utterance
  // begins). Cheap to keep around.
  const turnIdRef = useRef(0);

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
  //
  // Threshold must be high enough that two unlucky bleeds from background
  // video don't silence Samuel for a user actively asking for help. Anime /
  // foreign-language audio can produce two non-Latin transcripts within
  // seconds of each other; raising to 4 means the user has to be in a
  // sustained noisy environment before we switch modes. The streak also
  // decays after MEDIA_NOISE_DECAY_MS of real time so an old drop can't
  // combine with a fresh one to silently push us past the threshold.
  const mediaNoiseStreakRef = useRef(0);
  const lastMediaNoiseAtRef = useRef(0);
  const MEDIA_NOISE_PASSIVE_THRESHOLD = 4;
  const MEDIA_NOISE_DECAY_MS = 30_000;
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
              // Auto-respond at speech_stopped (OpenAI canonical pattern).
              // The model decides whether it needs the screen and calls
              // observe_screen / read_app / list_browser_tabs as tools,
              // speaking a brief preamble in parallel to mask tool latency.
              // We no longer pre-inject AX + screenshot — that path added
              // 1-1.5s to every turn and required dozens of fragile
              // English-only heuristics (ACK / META / SERVICE / COMMAND
              // patterns) to skip the latency penalty for short turns. See
              // OpenAI's realtime-models-prompting guide and the WebRTC
              // low-latency post for the architectural rationale.
              create_response: true,
              // Barge-in: when the user speaks while Samuel is talking,
              // cancel his in-flight response immediately.
              interrupt_response: true,
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

    // Register passive-listening toggle. When passive=true, the transcript
    // handler cancels VAD-triggered auto-responses unless the user
    // addresses Samuel by name (or, in auto-passive, gives a clear
    // command/service intent).
    registerSetPassiveListening((passive: boolean) => {
      passiveListeningRef.current = passive;
      // Explicit toggle wins — clear the auto-passive flag either way so
      // the next wake-word turn doesn't accidentally cancel a deliberate
      // user choice.
      autoPassiveRef.current = false;
      clearInactivityTimer();
      debugLog("listening-mode", passive ? "PASSIVE (manual) — ignore mic until addressed" : "NORMAL — auto-respond to clear speech");
    });

    // ── Continuous screen observation (opt-in, off by default) ──────
    // Cheap djb2 hash for content-change detection.
    const cheapHash = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      }
      return h.toString(36);
    };

    // One tick of the continuous-mode pump. Tightly throttled — see
    // CONTINUOUS_* constants near the top of this module for the
    // rationale (postmortem: too-eager pushes choked server-side VAD).
    const continuousScreenTick = async () => {
      if (screenObservationModeRef.current !== "continuous") return;
      const s = sessionRef.current;
      if (!s) return;

      const now = Date.now();

      // Self-pause when the user has been silent for too long. We don't
      // tear down the timer (so the next user turn resumes immediately
      // without re-starting state), we just skip pushes until activity.
      if (
        lastUserSpeechAtRef.current > 0 &&
        now - lastUserSpeechAtRef.current >= CONTINUOUS_USER_IDLE_MS
      ) {
        return;
      }

      // Hard throttle — never more than one push per CONTINUOUS_MIN_PUSH_GAP_MS,
      // even if the screen is changing rapidly.
      if (
        lastContinuousPushAtRef.current > 0 &&
        now - lastContinuousPushAtRef.current < CONTINUOUS_MIN_PUSH_GAP_MS
      ) {
        return;
      }

      try {
        // Scope the AX read to the user-named app when available — much
        // cheaper than the multi-app dump. Falls back to multi only when
        // the user explicitly asked for cross-app monitoring.
        const scopedApp = screenObservationAppRef.current;
        const axText = await invoke<string>(
          "read_app_content",
          scopedApp
            ? { appName: scopedApp, multi: false }
            : { appName: null, multi: true },
        ).catch(() => "");
        const fullAx = axText ?? "";
        const axHash = fullAx ? cheapHash(fullAx) : "";

        // Push only when content changed AND the change is meaningful.
        // Hash diff alone fires on cursor blink / sub-pixel re-renders;
        // requiring a length delta filters those out. First-push and
        // any change at all when length was zero are also valid.
        const hashChanged = !!axHash && axHash !== lastContinuousAxHashRef.current;
        const lengthDelta = Math.abs(fullAx.length - lastContinuousAxLengthRef.current);
        const isFirstPush = lastContinuousPushAtRef.current === 0;
        const meaningfulChange =
          hashChanged && (isFirstPush || lengthDelta >= CONTINUOUS_DELTA_BYTES);
        if (!meaningfulChange) return;

        // Text-only ambient push. Earlier versions also bundled a JPEG
        // screenshot via `input_image`, but the Realtime API rejects that:
        //   - role:"system" content schema only allows ONE input_text entry
        //     (no images, max array length 1). API responds with
        //     `array_above_max_length` and the item is never created, which
        //     also breaks the next tick's rotation/delete (item not found).
        //   - role:"user" with an image is schema-legal, but it confused
        //     the server-side turn-boundary detector — see the VAD-stall
        //     postmortem on 2026-05-14.
        // We drop the ambient screenshot here. The model can still call
        // observe_screen(mode='full') on demand when a turn actually needs
        // visual context (charts, video frames, canvas-rendered apps).
        // For text reading (articles, email, Slack, Notes, code), the AX
        // tree already carries paragraph structure verbatim — paragraphs
        // arrive as separate [text]: nodes. Watchers also operate purely
        // on text classification, so no watcher path needed the image.
        if (!fullAx || fullAx.trim().length <= 20) return;

        // Drop the previous ambient context item so the conversation
        // only carries the latest screen snapshot at any time.
        if (lastScreenItemIdRef.current) {
          try {
            s.transport.sendEvent({
              type: "conversation.item.delete",
              item_id: lastScreenItemIdRef.current,
            });
          } catch { /* may already be gone */ }
        }

        const truncatedAx = fullAx.length > CONTINUOUS_AX_BUDGET
          ? fullAx.slice(0, CONTINUOUS_AX_BUDGET) + "\n...(truncated)"
          : fullAx;
        const itemId = `ctx_${now}`;
        const scopeLabel = scopedApp ?? "all visible apps";
        try {
          // role: "system" (not "user") so these silent updates don't
          // masquerade as user turns. role:"user" was confusing the
          // server-side turn boundary detector and contributed to the
          // VAD-stall postmortem on 2026-05-14.
          s.transport.sendEvent({
            type: "conversation.item.create",
            item: {
              id: itemId,
              type: "message",
              role: "system",
              content: [
                {
                  type: "input_text",
                  text:
                    `[System: Background screen update — Samuel is in continuous observation mode (` +
                    `scope: ${scopeLabel}). This is silent context; do NOT proactively speak about ` +
                    `it unless the user asks or a registered watcher trigger fires. Current screen ` +
                    `content (Accessibility Tree, exact text):\n${truncatedAx}]`,
                },
              ],
            },
          });
          lastScreenItemIdRef.current = itemId;
          lastContinuousAxHashRef.current = axHash;
          lastContinuousAxLengthRef.current = fullAx.length;
          lastContinuousPushAtRef.current = now;
          debugLog(
            "continuous-screen",
            `pushed scope=${scopeLabel} AX(${fullAx.length} chars, sent=${truncatedAx.length}, dLen=${lengthDelta}) | item_id=${itemId}`,
          );
        } catch (e) {
          debugLog("continuous-screen", `push failed: ${e}`, "warn");
        }
      } catch (e) {
        debugLog("continuous-screen", `tick failed: ${e}`, "warn");
      }
    };

    const stopContinuousObservation = () => {
      if (screenObservationTimerRef.current) {
        clearInterval(screenObservationTimerRef.current);
        screenObservationTimerRef.current = null;
      }
    };

    const startContinuousObservation = () => {
      stopContinuousObservation();
      // Seed lastUserSpeechAt to "now" so the user-idle self-pause
      // doesn't fire immediately on a fresh continuous-mode start.
      lastUserSpeechAtRef.current = Date.now();
      // Fire one push immediately so Samuel sees the current screen the
      // moment the user flips into continuous mode, then poll on cadence.
      void continuousScreenTick();
      screenObservationTimerRef.current = setInterval(
        () => { void continuousScreenTick(); },
        CONTINUOUS_POLL_MS,
      );
    };

    // Register screen-observation mode bridge. Default per session is
    // "on_demand" — the model uses tools (observe_screen / read_app /
    // list_browser_tabs) to fetch screen context when it needs it, no
    // ambient pushes. Switching to "continuous" starts the polling
    // pump above; an optional `app` scope reads only that one app
    // (much cheaper than the multi-app dump).
    registerSetScreenObservation((mode, opts) => {
      screenObservationModeRef.current = mode;
      const reason = opts?.reason;
      const app = opts?.app?.trim() || null;
      if (mode === "continuous") {
        // App switch mid-session: clear stale hash so the next tick
        // pushes the new scope's content immediately.
        if (app !== screenObservationAppRef.current) {
          lastContinuousAxHashRef.current = "";
          lastContinuousAxLengthRef.current = 0;
          lastContinuousPushAtRef.current = 0;
        }
        screenObservationAppRef.current = app;
        startContinuousObservation();
        debugLog(
          "screen-mode",
          `CONTINUOUS — scope=${app ?? "all-visible-apps"} polling every ${CONTINUOUS_POLL_MS}ms${reason ? ` (reason: ${reason})` : ""}`,
        );
      } else {
        stopContinuousObservation();
        screenObservationAppRef.current = null;
        // Drop any existing continuous-mode screenshot so a future
        // tool-driven screenshot doesn't conflict with stale ambient state.
        if (lastScreenItemIdRef.current) {
          try {
            sessionRef.current?.transport.sendEvent({
              type: "conversation.item.delete",
              item_id: lastScreenItemIdRef.current,
            });
          } catch { /* may already be gone */ }
          lastScreenItemIdRef.current = null;
          lastContinuousAxHashRef.current = "";
          lastContinuousAxLengthRef.current = 0;
          lastContinuousPushAtRef.current = 0;
        }
        debugLog("screen-mode", `ON_DEMAND — model fetches screen via tools${reason ? ` (reason: ${reason})` : ""}`);
      }
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

      // Tools that read or mutate screen state make any prior
      // continuous-mode screenshot stale (e.g. continuous-mode pushed
      // Chrome on Discord; switch_browser_tab moves to DoorDash; the
      // model then conflates the two and says "no DoorDash tab found").
      // Drop the stale screenshot — the tool result IS the truth.
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
          debugLog("ctx", `deleted stale continuous-mode screen (item=${staleId} after ${toolName})`);
        } catch { /* may already be gone */ }
        lastScreenItemIdRef.current = null;
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

    // ── Post-trigger transcript guard ─────────────────────────────────────
    // The session's server VAD now auto-responds at speech_stopped (see
    // session.config.audio.input.turnDetection.create_response above), so
    // by the time the transcript arrives the model is already speaking.
    // If the transcript reveals the audio was bogus (echo, media bleed,
    // passive-listening with no wake word), we cancel the in-flight
    // response via session.interrupt(). Otherwise we let it run.
    //
    // Returns true if the auto-response should be cancelled, false to let
    // it proceed.
    const shouldCancelAutoResponse = (transcript: string): { cancel: boolean; reason?: string } => {
      // Passive listening: drop turns that don't address Samuel (manual
      // passive) or aren't a clear command/service mention (auto-passive).
      if (passiveListeningRef.current && transcript) {
        const wakeMatched = addressesSamuel(transcript);
        const trimmed = transcript.trim();
        const commandIntent = autoPassiveRef.current
          && (COMMAND_VERB_PATTERN.test(trimmed) || SERVICE_PATTERN.test(trimmed));
        if (!wakeMatched && !commandIntent) {
          return {
            cancel: true,
            reason: `${autoPassiveRef.current ? "auto-passive" : "passive"}: no wake/command in "${transcript}"`,
          };
        }
        // Auto-disengage if it was the timer that armed passive.
        if (autoPassiveRef.current) {
          passiveListeningRef.current = false;
          autoPassiveRef.current = false;
          mediaNoiseStreakRef.current = 0;
          lastMediaNoiseAtRef.current = 0;
          debugLog(
            "listening-mode",
            `${wakeMatched ? "wake word" : "command-verb intent"} in "${transcript}" — exiting auto-passive`,
          );
        }
      }
      return { cancel: false };
    };


    // ── Bubble pacer helpers ─────────────────────────────────────────
    // Paint whatever portion of `assistantBufferRef.current` is currently
    // "revealed" into the assistant chat entry. Called by the reveal timer
    // and by flush-points (audio_transcript.done, response.done).
    const paintRevealedAssistantText = () => {
      const id = assistantEntryIdRef.current;
      if (!id) return;
      const text = assistantBufferRef.current.slice(0, assistantRevealedLenRef.current);
      setTranscript((prev) =>
        prev.map((e) => (e.id === id ? { ...e, text } : e)),
      );
    };

    const stopRevealTimer = () => {
      if (assistantRevealTimerRef.current) {
        clearInterval(assistantRevealTimerRef.current);
        assistantRevealTimerRef.current = null;
      }
    };

    const startRevealTimer = () => {
      if (assistantRevealTimerRef.current) return;
      const charsPerTick = (REVEAL_CHARS_PER_SEC * REVEAL_TICK_MS) / 1000;
      let acc = 0;
      assistantRevealTimerRef.current = setInterval(() => {
        const total = assistantBufferRef.current.length;
        if (assistantRevealedLenRef.current >= total) return;
        acc += charsPerTick;
        if (acc < 1) return;
        const step = Math.floor(acc);
        acc -= step;
        const next = Math.min(total, assistantRevealedLenRef.current + step);
        if (next === assistantRevealedLenRef.current) return;
        assistantRevealedLenRef.current = next;
        paintRevealedAssistantText();
      }, REVEAL_TICK_MS);
    };

    // Reveal everything immediately and stop the pacer (used on
    // audio_transcript.done / response.done so the bubble matches the
    // model's final text the moment audio finishes).
    const flushRevealAssistantText = () => {
      assistantRevealedLenRef.current = assistantBufferRef.current.length;
      paintRevealedAssistantText();
      stopRevealTimer();
    };
    // ─────────────────────────────────────────────────────────────────

    // Raw transport events for real-time transcript display
    session.transport.on("*", (event: Record<string, unknown>) => {
      const type = event.type as string;

      switch (type) {
        case "input_audio_buffer.speech_started": {
          debugLog("turn", "speech_started");
          // Bump turn counter — any in-flight per-turn async work (e.g.
          // continuous-mode screen capture) can use this to detect that
          // a newer utterance has started and abandon stale work.
          turnIdRef.current += 1;
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
          // Server VAD now auto-fires response.create at this point (see
          // session.config.audio.input.turnDetection.create_response). The
          // model decides whether it needs the screen and calls a tool;
          // we no longer pre-inject AX + screenshot. If the transcript
          // arrives and reveals echo / media bleed / passive-listening
          // without a wake word, we cancel via session.interrupt() in the
          // transcription.completed handler below.
          debugLog("turn", "speech_stopped — auto-response triggered by server VAD");
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
            // Server VAD already fired response.create at speech_stopped.
            // Cancel the in-flight auto-response so Samuel doesn't reply to
            // the bogus turn (echo / media bleed / pure noise).
            if (responseInProgressRef.current) {
              try {
                sessionRef.current?.interrupt();
                debugLog("turn", "auto-response cancelled (echo/noise/media)");
              } catch (e) {
                debugLog("turn", `interrupt failed: ${e}`, "warn");
              }
            }
            // Crucial: speech_stopped flipped agentState → "thinking". Without
            // this, the UI stays stuck on "thinking" forever after a drop.
            if (!responseInProgressRef.current) {
              setAgentState("listening");
            }
            // Auto-arm wake-word gate when media keeps interfering. Continuous
            // video/TV otherwise floods the mic with noise the user can't talk
            // through. A clear command-verb (Reason 0 below) or any clean
            // transcript exits auto-passive automatically.
            if (isMediaNoise) {
              const now = Date.now();
              // Decay the streak if too much real time has passed since the
              // last drop — a bleed from minutes ago shouldn't combine with
              // a fresh one to silently silence the assistant.
              if (
                lastMediaNoiseAtRef.current &&
                now - lastMediaNoiseAtRef.current > MEDIA_NOISE_DECAY_MS
              ) {
                mediaNoiseStreakRef.current = 0;
              }
              mediaNoiseStreakRef.current += 1;
              lastMediaNoiseAtRef.current = now;
              if (mediaNoiseStreakRef.current >= MEDIA_NOISE_PASSIVE_THRESHOLD) {
                armAutoPassive(
                  `${mediaNoiseStreakRef.current} media-noise drops`,
                  "Background media detected \u2014 say \u201cSamuel\u201d or use a clear command (\u201copen\u2026\u201d, \u201cexplain\u2026\u201d) to address me.",
                );
              }
            }
            break;
          }
          // Clean transcript reaching this point — reset the media streak so
          // a single intervening user turn re-enables auto-listen behaviour.
          mediaNoiseStreakRef.current = 0;
          lastMediaNoiseAtRef.current = 0;
          // Stamp the user-activity wallclock so continuous-mode's
          // self-pause clock resets. Echo / noise / media drops do NOT
          // count as user activity.
          lastUserSpeechAtRef.current = Date.now();

          recordTurn("user", text);
          if (pendingId) {
            setTranscript((prev) =>
              prev.map((e) => (e.id === pendingId ? { ...e, text } : e)),
            );
          } else {
            setTranscript((prev) => [...prev, makeEntry("user", text)]);
          }

          // Hard-stop phrases ("stop", "wait", "I know", "got it") need
          // to actually halt Samuel — not give him another turn to keep
          // explaining. server VAD's interrupt_response auto-cancels
          // overlapping audio, but if the user speaks during a pause
          // the model might already be between sentences (no audio to
          // interrupt). We send response.cancel directly to be safe.
          if (HARD_STOP_PATTERN.test(text.trim())) {
            debugLog("turn", `hard-stop "${text}" — cancelling response`);
            if (responseInProgressRef.current) {
              try {
                sessionRef.current?.interrupt();
              } catch (e) {
                debugLog("turn", `interrupt failed: ${e}`, "warn");
              }
            }
            // No response — set state directly so UI doesn't stick on "thinking"
            if (!responseInProgressRef.current) {
              setAgentState("listening");
            }
            break;
          }

          // Real transcript — server VAD already triggered the response
          // when speech_stopped fired. Check passive-listening here: if
          // it's engaged and the user didn't address Samuel, cancel the
          // in-flight auto-response.
          const passiveDecision = shouldCancelAutoResponse(text);
          if (passiveDecision.cancel) {
            debugLog("listening-mode", `dropping turn — ${passiveDecision.reason}`);
            if (responseInProgressRef.current) {
              try {
                sessionRef.current?.interrupt();
              } catch (e) {
                debugLog("turn", `interrupt failed: ${e}`, "warn");
              }
            }
            if (!responseInProgressRef.current) {
              setAgentState("listening");
            }
          }
          break;
        }

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta": {
          const delta = event.delta as string;
          if (delta) {
            setAgentState("speaking");
            assistantBufferRef.current += delta;
            // Create the bubble entry on first delta. Start with an empty
            // visible text and let the reveal timer fill it in at TTS rate
            // so the bubble doesn't sprint ahead of Samuel's voice.
            if (!assistantEntryIdRef.current) {
              const entry = makeEntry("assistant", "");
              assistantEntryIdRef.current = entry.id;
              assistantRevealedLenRef.current = 0;
              setTranscript((prev) => [...prev, entry]);
            }
            startRevealTimer();
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
            // Replace the buffer with the canonical final text (handles
            // any small drift between accumulated deltas and the official
            // transcript), then flush so the bubble shows the complete
            // utterance at the moment audio finishes.
            assistantBufferRef.current = finalText;
            if (assistantEntryIdRef.current) {
              flushRevealAssistantText();
            }
          }
          stopRevealTimer();
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          assistantRevealedLenRef.current = 0;
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
            // For cancelled responses (e.g. user interrupted Samuel mid-
            // sentence) keep the bubble at whatever the user actually heard
            // — flushing the unspoken tail would expose text the model
            // generated past the audio cutoff. For all other terminal
            // statuses, paint the full final text so the bubble matches
            // the spoken utterance exactly.
            if (respStatus === "cancelled") {
              paintRevealedAssistantText();
            } else {
              flushRevealAssistantText();
            }
          }
          stopRevealTimer();
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          assistantRevealedLenRef.current = 0;
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
      registerSetScreenObservation(null);
      stopContinuousObservation();
      // Reset to on_demand for the next session — Option A: continuous
      // mode never persists across sessions.
      screenObservationModeRef.current = "on_demand";
      screenObservationAppRef.current = null;
      lastContinuousAxHashRef.current = "";
      lastContinuousAxLengthRef.current = 0;
      lastContinuousPushAtRef.current = 0;
      lastUserSpeechAtRef.current = 0;
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
    registerSetScreenObservation(null);
    if (screenObservationTimerRef.current) {
      clearInterval(screenObservationTimerRef.current);
      screenObservationTimerRef.current = null;
    }
    screenObservationModeRef.current = "on_demand";
    screenObservationAppRef.current = null;
    lastContinuousAxHashRef.current = "";
    lastContinuousAxLengthRef.current = 0;
    lastContinuousPushAtRef.current = 0;
    lastUserSpeechAtRef.current = 0;
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
    const trimmed = text.trim();
    setTranscript((prev) => [...prev, makeEntry("user", trimmed)]);
    recordTurn("user", trimmed);
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
