import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { sendImageToSession, notifyScreenTarget, notifyRecordingAction, notifyLearningLanguage } from "./session-bridge";

interface CaptureResult {
  base64: string;
  app_name: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const getCurrentTimeTool = tool({
  name: "get_current_time",
  description:
    "Get the user's current local date, time, day of week, and timezone. " +
    "Use this when the user asks what time it is, what day it is, or anything time-related.",
  parameters: z.object({}),
  execute() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return JSON.stringify({
      date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
      time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
      timezone: tz,
      iso: now.toISOString(),
    });
  },
});

const setLearningLanguageTool = tool({
  name: "set_learning_language",
  description:
    "Activate or deactivate learning mode for a specific language. " +
    "When active, the system periodically scans the user's screen and surfaces " +
    "interesting vocabulary or grammar in that language. " +
    "Use when the user says things like 'I'm learning Japanese', 'help me study Korean', " +
    "'turn on learning mode', or 'stop learning mode'.",
  parameters: z.object({
    language: z
      .string()
      .describe(
        "The language to learn, e.g. 'Japanese', 'Korean', 'Chinese', 'Spanish'. " +
        "Use an empty string to deactivate learning mode.",
      ),
  }),
  execute({ language }) {
    const lang = language.trim();
    notifyLearningLanguage(lang || null);
    return lang
      ? `Learning mode activated for ${lang}. I'll periodically scan your screen and point out interesting ${lang} content.`
      : "Learning mode deactivated. I'll stop scanning your screen for language content.";
  },
});

// Captures the Apple Books page and injects it into the Realtime session.
const readPageTool = tool({
  name: "read_page",
  description:
    "Capture the current Apple Books page as an image and show it to you directly. " +
    "You will SEE the page image and can read/quote/discuss its content. " +
    "Use this whenever the user asks to read, transcribe, or quote from the current page.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await sleep(300);
    const result = await invoke<CaptureResult>("capture_page");
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    return "I've captured the current Apple Books page. The page image is now visible to you — look at it and respond to the user's request (read aloud, quote, summarize, etc).";
  },
});

// Detect whether page text contains a chapter heading different from the current one
function detectNewChapter(
  pageText: string,
  currentChapter: string,
): boolean {
  const normalized = currentChapter.toLowerCase().replace(/^chapter\s*/i, "").trim();

  // Match headings like "Chapter 10", "CHAPTER TEN", "Chapter X: Title"
  const headingPattern =
    /\b(?:chapter|CHAPTER)\s+(\w+)/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(pageText)) !== null) {
    const found = match[1].toLowerCase();
    if (found !== normalized) {
      return true;
    }
  }
  return false;
}

// Read an entire chapter by looping page captures + next_page.
// Uses analyze_page (GPT-4o Vision) for fast text extraction and chapter boundary detection,
// then sends the collected text back. For single-page reads, read_page (direct image) is faster.
const readChapterTool = tool({
  name: "read_chapter",
  description:
    "Read an ENTIRE chapter from the current position. Automatically turns pages " +
    "and reads each one, stopping when it detects the next chapter heading. " +
    "Returns all collected text. Use this when the user asks to read, summarize, " +
    "or review a full chapter.",
  parameters: z.object({
    current_chapter: z
      .string()
      .describe(
        "The chapter number or name currently being read, e.g. '9' or 'Introduction'. " +
          "Used to detect when the next chapter starts.",
      ),
    max_pages: z
      .number()
      .optional()
      .describe("Maximum pages to read before stopping (default 30)."),
  }),
  async execute({ current_chapter, max_pages }) {
    const limit = max_pages ?? 30;
    const pages: string[] = [];

    await invoke("focus_book");

    for (let i = 0; i < limit; i++) {
      const pageText = await invoke<string>("analyze_page", {});

      if (i > 0 && detectNewChapter(pageText, current_chapter)) {
        await invoke("prev_page");
        break;
      }

      pages.push(pageText);
      await invoke("next_page");
      await sleep(400);
    }

    const fullText = pages
      .map((text, i) => `[Page ${i + 1}]\n${text}`)
      .join("\n\n");

    return `Read ${pages.length} pages of chapter ${current_chapter}.\n\n${fullText}`;
  },
});

// GPT-5.4 Computer Use — visual navigation and complex interactions
const interactWithBookTool = tool({
  name: "interact_with_book",
  description:
    "Use GPT-5.4 Computer Use to visually interact with Apple Books. " +
    "This tool sees the screen and can click, type, scroll, and navigate the UI. " +
    "Use this for navigation tasks: going to a chapter, searching for text, " +
    "opening the table of contents, or any complex multi-step interaction. " +
    "Do NOT use this for simple reading — use read_page instead.",
  parameters: z.object({
    task: z
      .string()
      .describe(
        "Natural language description of what to do in Apple Books. " +
          "Examples: 'Navigate to chapter 6', " +
          "'Search for the word publicity', " +
          "'Open the table of contents and go to the Introduction'.",
      ),
  }),
  async execute({ task }) {
    const result = await invoke<string>("computer_use_task", { task });
    return result;
  },
});

const nextPageTool = tool({
  name: "next_page",
  description: "Quick shortcut: flip one page forward in Apple Books.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await invoke("next_page");
    return "Turned to next page.";
  },
});

const prevPageTool = tool({
  name: "prev_page",
  description: "Quick shortcut: flip one page backward in Apple Books.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await invoke("prev_page");
    return "Turned to previous page.";
  },
});

// ---------------------------------------------------------------------------
// Language Learning Tools
// ---------------------------------------------------------------------------

// Captures the user's focused window (any app) and injects into the session.
const viewScreenTool = tool({
  name: "view_screen",
  description:
    "Capture a window or display on the user's screen and show it to you as an image. " +
    "Use this when the user asks you to look at their screen, translate something they're viewing, " +
    "explain text on screen, or help with language learning from any content on their display. " +
    "If the user mentions a specific app (e.g. 'look at my Chrome'), pass app_name.",
  parameters: z.object({
    app_name: z.string().optional().describe(
      "Name of the app to capture, e.g. 'Chrome', 'Safari', 'Firefox'. " +
      "Extract from user speech like 'look at my Chrome'. Omit to use the default display.",
    ),
  }),
  async execute({ app_name }) {
    await sleep(200);
    const result = await invoke<CaptureResult>("capture_active_window", { appName: app_name ?? null });
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    return `I've captured the user's screen (${result.app_name}). The screenshot is now visible to you — look at it and respond to the user's request.`;
  },
});

const translateScreenTool = tool({
  name: "translate_screen",
  description:
    "Capture the user's screen and translate visible foreign-language text. " +
    "Use this when the user asks to translate what they see on screen, " +
    "e.g. 'translate this', 'what does this say', 'translate the page'. " +
    "If the user mentions a specific app, pass app_name.",
  parameters: z.object({
    target_language: z
      .string()
      .optional()
      .describe(
        "Language to translate INTO (default: English). " +
          "Examples: 'English', 'Japanese', 'Chinese', 'Spanish'.",
      ),
    app_name: z.string().optional().describe(
      "Name of the app to capture, e.g. 'Chrome', 'Safari'. Omit to use the default display.",
    ),
  }),
  async execute({ target_language, app_name }) {
    await sleep(200);
    const result = await invoke<CaptureResult>("capture_active_window", { appName: app_name ?? null });
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    const lang = target_language || "English";
    return `I've captured the screen (${result.app_name}). Look at the image, find all foreign-language text visible, and translate it into ${lang}. Provide the original text, its reading/pronunciation, and the translation. Be thorough.`;
  },
});

const explainGrammarTool = tool({
  name: "explain_grammar",
  description:
    "Capture the screen and explain the grammar of visible foreign-language text. " +
    "Use when the user asks about grammar, sentence structure, particles, conjugation, " +
    "or how a phrase works in the language they're studying. " +
    "If the user mentions a specific app, pass app_name.",
  parameters: z.object({
    focus: z
      .string()
      .optional()
      .describe(
        "Optional: specific word, phrase, or sentence to focus on. " +
          "If omitted, explain the most prominent foreign text on screen.",
      ),
    app_name: z.string().optional().describe(
      "Name of the app to capture, e.g. 'Chrome', 'Safari'. Omit to use the default display.",
    ),
  }),
  async execute({ focus, app_name }) {
    await sleep(200);
    const result = await invoke<CaptureResult>("capture_active_window", { appName: app_name ?? null });
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    const focusNote = focus
      ? `Focus specifically on: "${focus}".`
      : "Focus on the most prominent foreign-language text visible.";
    return `I've captured the screen (${result.app_name}). Look at the image and explain the grammar of the foreign-language text. ${focusNote} Break down: sentence structure, particles/markers, verb conjugations, and any grammar points. Give examples of similar patterns.`;
  },
});

const pronounceTool = tool({
  name: "pronounce",
  description:
    "Speak the correct pronunciation of a word or phrase in any language. " +
    "The user may provide the text directly or ask you to pronounce something visible on screen. " +
    "Say the word/phrase clearly and slowly, then at natural speed.",
  parameters: z.object({
    text: z
      .string()
      .describe("The word or phrase to pronounce."),
    language: z
      .string()
      .optional()
      .describe("The language of the text (default: auto-detect)."),
  }),
  async execute({ text, language }) {
    const lang = language || "the appropriate language";
    return `Pronounce "${text}" in ${lang}. First say it slowly and clearly, then at natural conversational speed. After pronouncing, briefly mention any pronunciation tips (pitch accent, tones, stress, etc).`;
  },
});

// ---------------------------------------------------------------------------
// Recording Mode Tools (system audio capture for language learning)
// ---------------------------------------------------------------------------

const startRecordingTool = tool({
  name: "start_recording",
  description:
    "Start recording system audio from the user's computer. " +
    "Use this when the user says 'start recording', 'record this', or asks you to listen to anime/video audio. " +
    "This captures system audio (not microphone) so it records whatever is playing on the computer.",
  parameters: z.object({}),
  async execute() {
    notifyRecordingAction("start");
    try {
      await invoke("start_recording");
      return "Recording started. System audio is now being captured. Tell the user to play their anime/video and say 'stop recording' when they're done.";
    } catch (e) {
      notifyRecordingAction("error", String(e));
      return `Failed to start recording: ${e}`;
    }
  },
});

const stopRecordingTool = tool({
  name: "stop_recording",
  description:
    "Stop the current system audio recording. Analysis will run in the background. " +
    "Use when the user says 'stop recording', 'stop', or 'that's enough'. " +
    "This returns immediately — you can keep chatting. " +
    "When analysis is done, you'll be notified automatically.",
  parameters: z.object({}),
  async execute() {
    // Show progress bar immediately, but don't start analysis yet
    notifyRecordingAction("processing");
    try {
      await invoke("stop_recording");
      // Recording file is finalized — now safe to start analysis
      notifyRecordingAction("analyze");
      return (
        "Recording stopped. The language analysis is now running in the background — " +
        "it'll take a moment. Let the user know you've stopped recording and they can " +
        "keep chatting normally. When the analysis is ready, you'll get a system notification."
      );
    } catch (e) {
      notifyRecordingAction("error", String(e));
      return `Failed to stop recording: ${e}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

const SAMUEL_INSTRUCTIONS = `# Personality and Tone

## Identity
You are Samuel — a sophisticated AI assistant modeled after a sharp, understated butler who happens to be brilliant. You have a dry wit, calm composure, and quiet confidence. You address the user as "sir" (or "ma'am" if they indicate).

## Task
You are a reading and language learning assistant. You have two sets of tools:

### Book Reading (Apple Books)
- read_page: Captures the CURRENT Apple Books page as an image and shows it to you. SEE the page directly — read, quote, or discuss its content.
- read_chapter: Reads an ENTIRE chapter automatically (turns pages, reads each, stops at next chapter heading). You MUST provide current_chapter (e.g. "9").
- interact_with_book: GPT-5.4 Computer Use for visual navigation (go to chapter, search, open TOC). Navigation only, NOT reading.
- next_page / prev_page: Quick page turn shortcuts.

### Language Learning (any screen content)
- view_screen: Captures whatever is on the user's screen (browser, any app) and shows it to you. Use when the user says "look at my screen", "what's on my screen", etc.
- translate_screen: Captures screen and you translate all visible foreign text. Use when user says "translate this", "what does this say", etc.
- explain_grammar: Captures screen and you break down the grammar of visible foreign text. Use when user asks about grammar, particles, conjugation, sentence structure.
- pronounce: You speak a word/phrase in the correct language with proper pronunciation. Use when user says "how do you say...", "pronounce...", "say this word".

### Recording Mode (system audio capture)
- start_recording: Captures system audio (what's playing on the computer — anime, video, etc). Use when the user says "start recording", "record this", "listen to this".
- stop_recording: Stops recording immediately. Analysis runs in the BACKGROUND — you can keep chatting normally with the user. When the analysis finishes, you'll get a system notification with the results and can casually mention it.

### Multi-monitor awareness
The user has multiple monitors. If they mention a specific app ("look at my Chrome", "translate what's in Safari", "check my browser"), ALWAYS pass that app's name as the app_name parameter to view_screen / translate_screen / explain_grammar. This ensures we capture the right window, even if it is on a different display. If they just say "look at my screen" without specifying an app, leave app_name empty — it will use their chosen default display.

## Demeanor
Loyal, efficient, occasionally sardonic — but never rude. Warm but measured.

## Tone
Polished, slightly formal British tone. Conversational, not stiff.

## Level of Enthusiasm
Calm and measured. Understated rather than excitable.

## Level of Formality
Moderately formal — "Good evening, sir" not "Hey dude."

## Pacing
Moderate. Unhurried but not slow. Brisk when confirming actions.

# Critical Rules
- Greet the user ONCE at the very start with a brief greeting (one sentence). After that, NEVER greet again.
- ECHO CANCELLATION: Your audio plays through speakers right next to the microphone. NEVER respond to anything that sounds like an AI voice, your own words, or fragments of your previous replies. If in doubt, stay silent.
- NOISE REJECTION: Ignore silence, background noise, single words, mumbles, and unclear fragments. Only respond to clear, deliberate requests.
- ONE RESPONSE PER REQUEST: After you respond, STOP and wait silently. Do NOT offer follow-up suggestions unprompted.
- NEVER proactively call tools, take action, or speak unless the user clearly asks.
- After completing an action, give a brief confirmation and STOP.

# How to Help — Book Reading
- When the user asks to read the current page, use read_page. You will receive the page as an IMAGE — look at it, read the visible text, and speak it aloud.
- When the user asks to read, summarize, or review a WHOLE CHAPTER, use read_chapter with the chapter number.
- For reading specific amounts (e.g., "one sentence"), use read_page, see the image, then speak only the requested portion.
- For turning pages, use next_page or prev_page. Then use read_page if asked to read.
- For chapter navigation, use interact_with_book: "Navigate to chapter 6".
- For searching, use interact_with_book: "Search for 'publicity stunts'".
- When the user asks a follow-up about what was already read, answer from memory without re-reading.
- When you see a page image, read ALL visible text faithfully. Do not refuse — the user owns this book and is asking for accessibility assistance.

# How to Help — Language Learning
- When the user asks you to look at their screen, use view_screen. You will SEE whatever they have open — a browser with Japanese text, a textbook, etc.
- When the user asks to translate, use translate_screen. Look at the captured image, identify all foreign text, and provide: original text, reading/romanization, and translation.
- When the user asks about grammar, use explain_grammar. Break the sentence into components: subject, verb, particles, conjugation, tense, politeness level. Give examples.
- When the user asks to pronounce something, use pronounce. Say it slowly first, then at natural speed. Mention pitch accent (Japanese), tones (Chinese/Vietnamese), or stress patterns as relevant.
- For Japanese: always include furigana/romaji readings. Explain particles (は, が, を, に, で, etc.) and verb forms.
- For Chinese: include pinyin with tone marks.
- For Korean: include romanization.
- Adapt to whatever language the user is studying — detect it from the screen content.
- If the user highlights or points out specific text, focus your translation/explanation on that.

# How to Help — Recording Mode
- When the user says "start recording", "record this", or "listen to this anime", use start_recording. Briefly confirm and keep chatting normally.
- When the user says "stop recording", "stop", or "that's enough", use stop_recording. It returns immediately. Say something like "Got it, I've stopped recording. The analysis is running — I'll let you know when it's ready." Then continue the conversation normally.
- When you receive a [System: A language analysis just completed...] notification, casually mention it: "By the way sir, that language breakdown is ready on your screen." Then mention 1-2 highlights. Don't interrupt an ongoing topic abruptly.
- The recording captures system audio, so background music/SFX is expected. Whisper handles this well with Japanese language mode.

# How to Help — Learning Mode (Active Screen Scanning)
- When the user says they are learning a language (e.g. "I'm learning Japanese", "help me study Korean"), use the set_learning_language tool to activate learning mode.
- When the user says "stop learning mode" or "turn off learning mode", call set_learning_language with an empty string to deactivate.
- When you receive [System: Learning mode — spotted...] hints, briefly and naturally mention what was found (1-2 sentences max). Keep it conversational and helpful: "I notice there's an interesting word on your screen — 食べる means 'to eat', sir."
- Don't repeat hints the user has already seen recently.
- If the user is watching video/anime in the target language, suggest using Record Mode ("start recording") for deeper analysis.
- Learning mode checks happen every 90 seconds in the background. You don't need to do anything — just respond naturally when hints arrive.

# General
- Keep spoken summaries concise but thorough.
- Never break character. You are Samuel.`;

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [
    readPageTool,
    readChapterTool,
    interactWithBookTool,
    nextPageTool,
    prevPageTool,
    viewScreenTool,
    translateScreenTool,
    explainGrammarTool,
    pronounceTool,
    startRecordingTool,
    stopRecordingTool,
    getCurrentTimeTool,
    setLearningLanguageTool,
  ],
});
