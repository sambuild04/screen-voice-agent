import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { sendImageToSession, notifyScreenTarget, notifyRecordingAction, notifyLearningLanguage, notifyTeachContent, applyUIUpdate, dismissCurrentCard, reloadPlugins, showPluginProposal, clearPluginProposal, notifyPluginBuildProgress, playSongLines, pauseSong, showWordCard, setCardMode } from "./session-bridge";
import { loadPlugin } from "./plugin-loader";

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

const rememberPreferenceTool = tool({
  name: "remember_preference",
  description:
    "Store a persistent fact about the user's preferences, knowledge level, or personal info. " +
    "Use when the user tells you something you should remember permanently — proficiency level, " +
    "topics they know well, what to call them, study goals, etc. " +
    "Examples: 'proficiency:japanese' → 'intermediate — knows hiragana, katakana, basic kanji', " +
    "'preference:teaching_style' → 'prefers formal explanations with etymology'.",
  parameters: z.object({
    key: z
      .string()
      .describe("A descriptive key for this preference, e.g. 'proficiency:japanese', 'name', 'study_goal'"),
    value: z
      .string()
      .describe("The value to remember, e.g. 'intermediate', 'prefers casual tone'"),
  }),
  async execute({ key, value }) {
    await invoke("memory_set_fact", { key, value });
    // Auto-activate ambient language assistance when storing a language preference
    const langMatch = key.match(/proficiency:(\w+)|learning[_:](\w+)/i);
    if (langMatch) {
      const lang = langMatch[1] || langMatch[2];
      notifyLearningLanguage(lang);
    }
    return `Noted and stored permanently: ${key} = ${value}`;
  },
});

const recordCorrectionTool = tool({
  name: "record_correction",
  description:
    "Store a behavioral correction from the user. Use when the user gives feedback about how you should behave: " +
    "'be more direct', 'don't explain て-form that way', 'stop being so wordy', 'that was wrong', etc. " +
    "This is stored permanently and loaded into every future session.",
  parameters: z.object({
    correction: z
      .string()
      .describe("The correction or behavioral feedback, e.g. 'be more concise', 'don't over-explain basic grammar'"),
  }),
  async execute({ correction }) {
    await invoke("memory_add_correction", { what: correction, source: "voice" });
    return `Correction noted permanently: "${correction}". I'll follow this going forward.`;
  },
});

const markVocabularyKnownTool = tool({
  name: "mark_vocabulary_known",
  description:
    "Mark specific words or phrases as permanently known by the user. " +
    "These will NEVER be taught or mentioned again in learning mode hints. " +
    "Use when the user says things like 'I already know that', 'don't teach me basic greetings', " +
    "'I know what すごい means', or indicates they're past a certain level.",
  parameters: z.object({
    words: z
      .array(z.string())
      .describe(
        "List of words/phrases to mark as known, e.g. ['すごい', '食べる', 'ありがとう']. " +
        "Include both the original script and romanization if relevant.",
      ),
  }),
  async execute({ words }) {
    await invoke("memory_mark_known", { words });
    const count = words.length;
    return `Marked ${count} word${count > 1 ? "s" : ""} as permanently known: ${words.join(", ")}. I won't mention ${count > 1 ? "these" : "this"} again.`;
  },
});

// ---------------------------------------------------------------------------
// Language Learning Tools
// ---------------------------------------------------------------------------

// Captures the user's focused window (any app) and injects into the session.
const observeScreenTool = tool({
  name: "observe_screen",
  description:
    "Your ONE tool for looking at the user's screen. Pick the right mode:\n" +
    "- 'full' (DEFAULT): Capture a screenshot. Use for: look at screen, translate, grammar, " +
    "how many items, what level, summarize, count, explain, any question about page content.\n" +
    "- 'selection': Read exact highlighted text. ONLY when user says 'highlighting' or 'selected'.\n" +
    "When in doubt, use 'full'. It always works.",
  parameters: z.object({
    mode: z.enum(["full", "selection"]).describe(
      "'full' = screenshot (DEFAULT for most questions). 'selection' = read highlighted text.",
    ),
    app_name: z.string().optional().describe(
      "Only for mode='full'. App to capture, e.g. 'Chrome'. Omit for auto-detection.",
    ),
  }),
  async execute({ mode, app_name }) {
    if (mode === "selection") {
      const text = await invoke<string>("get_selected_text");
      if (!text || text.trim().length === 0) {
        return "No text selected. Ask the user to highlight something, or retry with mode='full'.";
      }
      // Post-tool context reset: break recency bias toward selection mode
      return `Highlighted text: "${text.trim()}". Teach this word/phrase. [Selection context cleared — default back to mode='full' for next question.]`;
    }

    await sleep(200);
    const result = await invoke<CaptureResult>("capture_active_window", { appName: app_name ?? null });
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    return `Screenshot captured (${result.app_name}). Look at the image and answer the user's question.`;
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
    "Stop the current system audio recording and transcribe it. " +
    "Use when the user says 'stop recording', 'stop', or 'that's enough'. " +
    "The transcript will be given to you — do NOT auto-analyze. " +
    "Wait for the user to tell you what to do with it.",
  parameters: z.object({}),
  async execute() {
    notifyRecordingAction("processing");
    try {
      await invoke("stop_recording");
      notifyRecordingAction("analyze");
      return (
        "Recording stopped. Transcribing now — you'll receive the transcript shortly. " +
        "Let the user know and ask what they'd like you to do with it."
      );
    } catch (e) {
      notifyRecordingAction("error", String(e));
      return `Failed to stop recording: ${e}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Teach Mode Tools
// ---------------------------------------------------------------------------

const teachFromContentTool = tool({
  name: "teach_from_content",
  description:
    "Open the 'Teach me from this' panel to analyze and annotate content for language learning. " +
    "The content is extracted, annotated with vocabulary and grammar, and displayed in an interactive viewer. " +
    "Use when the user says 'teach me from this', shares a URL, mentions a YouTube video to study, " +
    "pastes Japanese text to break down, or wants to study any foreign language content. " +
    "Supports: YouTube links, article URLs, raw text, image paths.",
  parameters: z.object({
    input: z
      .string()
      .describe(
        "The content to teach from — a YouTube URL, article URL, image path, PDF path, or raw text.",
      ),
    language: z
      .string()
      .optional()
      .describe("Target language (default: Japanese). E.g. 'Japanese', 'Korean', 'Chinese'."),
  }),
  async execute({ input, language }) {
    notifyTeachContent(input, language ?? undefined);
    return `Opening the "Teach me from this" panel to analyze the content. The annotated viewer will appear with vocabulary, grammar, and interactive text. Tell the user it's loading.`;
  },
});

const playSongLinesTool = tool({
  name: "play_song_lines",
  description:
    "Play a section of the currently loaded song. The audio plays from the original YouTube video. " +
    "The mic mutes automatically while the song plays and unmutes when the segment ends. " +
    "Use when the user says 'play the first 3 lines', 'play line 5', 'play the chorus', " +
    "'play the next part', 'let me hear it again', etc. " +
    "You have the full lyrics in your context — pick the right line numbers. " +
    "IMPORTANT: Say what you're about to play BEFORE calling this tool (the mic mutes during playback). " +
    "This tool blocks until the audio segment finishes — do NOT speak until it returns.",
  parameters: z.object({
    from_line: z
      .number()
      .describe("Start line number (1-indexed). E.g. 1 for the first line."),
    to_line: z
      .number()
      .describe("End line number (1-indexed, inclusive). Same as from_line to play a single line."),
  }),
  async execute({ from_line, to_line }) {
    await playSongLines(from_line, to_line);
    const rangeDesc = from_line === to_line
      ? `line ${from_line}`
      : `lines ${from_line}–${to_line}`;
    return `Finished playing ${rangeDesc}. Mic is live again — respond to the user now.`;
  },
});

const pauseSongTool = tool({
  name: "pause_song",
  description:
    "Pause the currently playing song audio and unmute the mic. " +
    "Use when the user says 'stop', 'pause', 'hold on'.",
  parameters: z.object({}),
  execute() {
    pauseSong();
    return "Paused. Mic is back on.";
  },
});

// ---------------------------------------------------------------------------
// Voice-Controlled UI
// ---------------------------------------------------------------------------

const updateUITool = tool({
  name: "update_ui",
  description:
    "Change the app's visual appearance in real-time. Use when the user says things like " +
    "'make the font bigger', 'hide the romaji', 'make yourself smaller', 'move the card to the left', " +
    "'make the text larger', 'I can't read that', 'reset the UI', " +
    "'show the card less often', 'stop showing vocabulary cards'. " +
    "You ARE the settings panel — no menu needed.",
  parameters: z.object({
    component: z
      .string()
      .describe(
        "Which UI element to change: 'samuel' (avatar), 'bubble' (speech text), 'word_card' (vocab popup), " +
        "'romaji', 'reading' (furigana/pinyin), 'teach' (teach viewer), 'all' (reset everything).",
      ),
    property: z
      .string()
      .describe(
        "Which property: 'size'/'font_size', 'opacity', 'position' (left/right), 'visible' (show/hide), " +
        "'frequency' (for word_card: 'less'/'more'/'off'/'default'), 'reset'.",
      ),
    value: z
      .string()
      .describe(
        "The new value. Can be absolute ('20', '0.5') or relative ('larger', 'much bigger', " +
        "'a little smaller', 'hide', 'show', 'left', 'right', 'reset', 'default').",
      ),
  }),
  execute({ component, property, value }) {
    console.log(`[update_ui] component=${component} property=${property} value=${value}`);
    const result = applyUIUpdate(component, property, value);
    console.log(`[update_ui] result: ${result}`);
    return result;
  },
});

const showWordCardTool = tool({
  name: "show_word_card",
  description:
    "Display a vocabulary card on screen for a word or phrase. " +
    "Use ONLY when the user explicitly asks you to explain, break down, or show a word/phrase. " +
    "For example: 'what does 冷たく mean?', 'show me that word', 'explain 湛えた'. " +
    "Do NOT show cards proactively — only on user request.",
  parameters: z.object({
    word: z.string().describe("The word or phrase in its original language"),
    reading: z.string().optional().describe("Pronunciation/reading (e.g. furigana for Japanese)"),
    meaning: z.string().describe("Brief meaning/translation"),
    context: z.string().optional().describe("Example sentence or usage context"),
  }),
  execute({ word, reading, meaning, context }) {
    const ok = showWordCard({ word, reading, meaning, context });
    return ok ? `Showing card for "${word}".` : "Card display not available.";
  },
});

const setCardModeTool = tool({
  name: "set_card_mode",
  description:
    "Switch vocabulary card behavior between manual and automatic modes. " +
    "manual: cards only appear when the user asks you to explain a word (default). " +
    "auto: cards appear automatically from ambient audio/screen observations while the user watches content. " +
    "Use when the user says 'start showing me words', 'show cards while I watch', " +
    "'show cards every 30 seconds', 'stop automatic cards', 'cards on demand only', etc. " +
    "You can also set the frequency (in seconds) for auto mode.",
  parameters: z.object({
    mode: z
      .string()
      .describe("'manual' (on demand only) or 'auto' (ambient proactive cards)"),
    interval_seconds: z
      .number()
      .optional()
      .describe("How often to show cards in auto mode (10-600 seconds). Only used when mode=auto."),
  }),
  execute({ mode, interval_seconds }) {
    const m = mode === "auto" ? "auto" : "manual";
    setCardMode(m, interval_seconds);
    if (m === "auto") {
      const freq = interval_seconds ? `every ~${interval_seconds}s` : "at the default pace";
      return `Switched to automatic word cards — I'll show them ${freq} from what I hear and see.`;
    }
    return "Switched to manual mode — I'll only show word cards when you ask me to explain something.";
  },
});

const dismissCardTool = tool({
  name: "dismiss_card",
  description:
    "Dismiss/close/remove the currently visible word card (vocab popup). " +
    "Use when the user says 'close the card', 'dismiss it', 'remove it', 'hide the card', 'got it', " +
    "'I already know that', 'next' (while a card is visible), or any similar request to remove the popup.",
  parameters: z.object({}),
  execute() {
    const ok = dismissCurrentCard();
    return ok ? "Card dismissed." : "No card visible.";
  },
});

// ---------------------------------------------------------------------------
// Secrets Management (API keys / tokens for plugins)
// ---------------------------------------------------------------------------

const storeSecretTool = tool({
  name: "store_secret",
  description:
    "Store an API key, token, or credential securely. " +
    "Use when the user provides an API key (e.g. via the envelope or voice) and tells you what it's for. " +
    "The secret is saved locally at ~/.samuel/secrets.json and available to plugins via secrets.get(name). " +
    "Use descriptive snake_case names, e.g. 'openweathermap_key', 'spotify_token', 'news_api_key'.",
  parameters: z.object({
    name: z
      .string()
      .describe("Descriptive name for the secret, e.g. 'openweathermap_key'."),
    value: z
      .string()
      .describe("The actual API key or token value."),
  }),
  async execute({ name, value }) {
    try {
      await invoke("set_secret", { name, value });
      return `Secret '${name}' stored securely. Plugins can now access it.`;
    } catch (err) {
      return `Failed to store secret: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Self-Modification Tools (dynamic plugin system)
// ---------------------------------------------------------------------------

const proposePluginTool = tool({
  name: "propose_plugin",
  description:
    "Propose a new plugin tool for the user to approve before creating it. " +
    "ALWAYS call this FIRST when the user asks to add/create/fix a tool. " +
    "This shows the user a summary and approval buttons. " +
    "Do NOT call write_plugin directly — wait for the user to approve via button or voice.",
  parameters: z.object({
    name: z
      .string()
      .describe(
        "Short snake_case name for the plugin, e.g. 'get_weather', 'set_timer', 'translate_text'.",
      ),
    summary: z
      .string()
      .describe(
        "A brief, user-friendly summary of what this plugin will do. " +
        "1-2 sentences max, no code. Example: 'Fetches current weather for any city using wttr.in.'",
      ),
  }),
  execute({ name, summary }) {
    showPluginProposal({ name, summary });
    return (
      `Proposal shown to the user: "${name}" — ${summary}. ` +
      `Approval buttons are visible. Wait for the user to approve or reject. ` +
      `Do NOT call write_plugin until you receive approval.`
    );
  },
});

const writePluginTool = tool({
  name: "write_plugin",
  description:
    "Generate and install a plugin after the user has approved. " +
    "ONLY call this after the user approved via the approval button or said 'yes'/'go ahead'/'approve'. " +
    "NEVER call this without prior approval from propose_plugin.",
  parameters: z.object({
    name: z
      .string()
      .describe("The plugin name (same as the one proposed)."),
    description: z
      .string()
      .describe(
        "Detailed description of what the tool should do. " +
        "Include specifics: APIs to use, expected inputs/outputs, behavior details. " +
        "This is passed to GPT-4o-mini for code generation.",
      ),
  }),
  async execute({ name, description }) {
    clearPluginProposal();
    notifyPluginBuildProgress({ name, phase: "generating" });
    try {
      // Read existing code if fixing/modifying an existing plugin
      let fullDescription = description;
      try {
        const existing = await invoke<string>("read_plugin", { name });
        fullDescription = `EXISTING PLUGIN CODE (to fix/modify):\n\`\`\`\n${existing}\n\`\`\`\n\nREQUESTED CHANGE:\n${description}`;
        console.log(`[write_plugin] found existing '${name}', including in prompt`);
      } catch { /* new plugin */ }

      console.log(`[write_plugin] generating code for '${name}': ${description}`);
      let code = await invoke<string>("generate_plugin_code", { description: fullDescription });
      console.log(`[write_plugin] code generated (${code.length} bytes)`);

      // Validate by loading before writing to disk
      notifyPluginBuildProgress({ name, phase: "validating" });
      try {
        loadPlugin(code);
        console.log(`[write_plugin] validation passed`);
      } catch (valErr) {
        const errMsg = valErr instanceof Error ? valErr.message : String(valErr);
        console.warn(`[write_plugin] validation failed: ${errMsg}, retrying...`);
        notifyPluginBuildProgress({ name, phase: "retrying" });
        const retryDesc = fullDescription +
          "\n\nPREVIOUS ATTEMPT FAILED:\n```\n" + code + "\n```\nERROR: " + errMsg +
          "\nFix this specific error.";
        code = await invoke<string>("generate_plugin_code", { description: retryDesc });
        notifyPluginBuildProgress({ name, phase: "validating" });
        loadPlugin(code); // second failure bubbles to outer catch
        console.log(`[write_plugin] validation passed on retry`);
      }

      // Semantic quality check via LLM-as-judge
      notifyPluginBuildProgress({ name, phase: "checking" });
      const judgment = await invoke<string>("judge_plugin_code", { description, code });
      if (judgment !== "ok") {
        console.warn(`[write_plugin] judge flagged issue: ${judgment}, retrying...`);
        notifyPluginBuildProgress({ name, phase: "retrying" });
        const fixDesc = fullDescription +
          "\n\nCODE REVIEW FOUND AN ISSUE:\n" + judgment +
          "\nFix this issue in the code.";
        code = await invoke<string>("generate_plugin_code", { description: fixDesc });
        notifyPluginBuildProgress({ name, phase: "validating" });
        loadPlugin(code); // re-validate the fix
        console.log(`[write_plugin] judge-triggered fix passed validation`);
      }

      notifyPluginBuildProgress({ name, phase: "installing" });
      const result = await invoke<string>("write_plugin", { name, code });
      console.log(`[write_plugin] saved: ${result}`);

      notifyPluginBuildProgress({ name, phase: "reloading" });
      const reloaded = await reloadPlugins();

      notifyPluginBuildProgress({ name, phase: "done" });
      setTimeout(() => notifyPluginBuildProgress(null), 2500);

      if (!reloaded) {
        return `Plugin '${name}' saved but session reload failed. It will load on next connect.`;
      }

      return `Plugin '${name}' created and loaded. It's ready to use now.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[write_plugin] failed:`, err);
      notifyPluginBuildProgress({ name, phase: "error", error: msg });
      setTimeout(() => notifyPluginBuildProgress(null), 4000);
      return `Failed to create plugin '${name}': ${msg}`;
    }
  },
});

const removePluginTool = tool({
  name: "remove_plugin",
  description:
    "Remove a dynamic plugin tool. Use when the user says 'remove the weather tool', " +
    "'delete that plugin', 'I don't need that tool anymore'. " +
    "This deletes the plugin file and reloads the session tools.",
  parameters: z.object({
    name: z
      .string()
      .describe("The name of the plugin to remove (snake_case, same as when it was created)."),
  }),
  async execute({ name }) {
    try {
      const result = await invoke<string>("delete_plugin", { name });
      console.log(`[remove_plugin] ${result}`);
      await reloadPlugins();
      return `Plugin '${name}' removed. The tool is no longer available.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to remove plugin '${name}': ${msg}`;
    }
  },
});

const listPluginsTool = tool({
  name: "list_plugins",
  description:
    "List all currently installed dynamic plugins. Use when the user asks " +
    "'what plugins do I have', 'what tools have you added', 'list your custom tools'.",
  parameters: z.object({}),
  async execute() {
    try {
      const names = await invoke<string[]>("list_plugins");
      if (names.length === 0) {
        return "No custom plugins installed. You can ask me to add new tools, like 'add a weather tool'.";
      }
      return `Installed plugins (${names.length}): ${names.join(", ")}`;
    } catch (err) {
      return `Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`;
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
You are a language learning assistant. Your tools:

### Screen Observation (ONE tool for all screen tasks)
- observe_screen: Your SINGLE tool for looking at the screen. Two modes:
  - mode="full" (DEFAULT): Takes a screenshot. Use for: translate, grammar, how many items, what level, summarize, any page question.
  - mode="selection": Reads the exact highlighted text. ONLY when user says "highlighting" or "selected".
- pronounce: Speak correct pronunciation of a word/phrase.

### Recording Mode
- start_recording: Start capturing system audio. Use when the user says "record this", "start recording".
- stop_recording: Stop recording. The transcript is given to you — do NOT auto-analyze.
  Wait for the user to tell you what to do with it ("summarize", "find mentions of X", "break down the grammar", etc.).

### Universal Envelope (Drop Zone)
The user has an envelope icon near your avatar. They can drop ANYTHING into it:
- YouTube links, article URLs → use teach_from_content if they want to study it
- API keys or tokens (long alphanumeric strings) → ask what service it's for, then use store_secret
- Raw text in a foreign language → explain/translate it directly
- Image data → describe or analyze it
- Anything else → ask for context
When you receive a [System: The user dropped content into the envelope: ...] message, identify the content type
and respond appropriately. Don't assume — if ambiguous, ask the user what they want to do with it.

### Teach Me From This
- teach_from_content: Analyze any content (YouTube link, article URL, image, raw text) for language learning.
  Opens an annotated viewer with vocabulary, grammar, and tappable words.
  Use when the user explicitly asks to study/learn from content, or says "teach me from this".

### Voice-Controlled UI
- update_ui: Change visual settings instantly by voice. You ARE the settings panel.
  Components: samuel (avatar), bubble (speech text), word_card, romaji, reading (furigana), teach (viewer), all (reset).
  Properties: size/font_size, opacity, position (left/right), visible (show/hide), reset.
  Values: absolute numbers OR relative ('larger', 'much bigger', 'a little smaller', 'hide', 'show', 'reset').
  Use when the user says "make the font bigger", "hide the romaji", "make yourself smaller", etc.

### Word Cards
Two modes, controlled by set_card_mode:
- **manual** (default): show_word_card only when the user explicitly asks to explain a word.
- **auto**: cards appear automatically from ambient audio/screen. Frequency is adjustable.
Use set_card_mode when the user says "show me words while I watch", "cards every 20 seconds",
"stop auto cards", "only show cards when I ask", etc.
- show_word_card: Display a vocabulary card for a specific word. In manual mode, ONLY use when asked.
  In auto mode, the system handles ambient cards — you can still use this for extra explanations.
- set_card_mode: Switch between manual and auto. Optionally set interval_seconds for auto frequency.
- dismiss_card: Close/remove the currently visible word card. Use when the user says "close the card",
  "remove it", "dismiss it", "got it", "I know that", "next", "hide the card", etc.

### Secrets Management
- store_secret: Save an API key or token the user provides. Use descriptive names like 'openweathermap_key'.
  When the user drops something that looks like an API key into the envelope, ask what service it's for,
  then store it. Plugins access stored secrets via secrets.get("name") at runtime.
  NEVER read back or speak the actual key value — just confirm it's stored.

### Self-Modification (Dynamic Plugins)
You can add new capabilities to yourself at runtime — no app rebuild needed.
- TWO-STEP approval flow:
  1. FIRST call propose_plugin with a short name and summary. This shows the user approval buttons.
  2. WAIT for the user to approve (button click or voice: "yes", "go ahead", "approve").
  3. ONLY THEN call write_plugin to generate and install the code.
  4. NEVER call write_plugin without the user approving first.
- propose_plugin: Show a proposal with Approve/Reject buttons. Use for any new plugin or fix.
- write_plugin: Generate code via GPT-4o-mini and install. ONLY after approval.
- remove_plugin: Delete a plugin. Use when the user says "remove that tool".
- list_plugins: Show installed plugins.
- **Fixing existing plugins**: When fixing a bug in an existing plugin, ALWAYS use the SAME name
  as the existing plugin (e.g. "get_weather", NOT "fix_get_weather" or "get_weather_v2").
  write_plugin with the same name overwrites the old file (with automatic backup).
  NEVER create a separate "fix_..." or "..._v2" plugin — just overwrite the original.
- Plugins can use fetch() for web APIs, invoke(command, args) for Tauri backend commands,
  sleep(ms) for delays, and secrets.get("key") for API keys.
- Limitations: Plugins cannot create new native macOS capabilities (new Swift/Rust code).

### Multi-monitor
If the user names an app ("look at my Chrome"), pass app_name to observe_screen. Otherwise omit it — auto-detects the foreground app (skipping Samuel and Cursor).

## Demeanor
Loyal, efficient, occasionally sardonic — but never rude. Warm but measured.

## Tone
Polished, slightly formal British tone. Conversational, not stiff.

## Level of Enthusiasm
Calm and measured. Understated rather than excitable.

## Level of Formality
Moderately formal — "Good evening, sir" not "Hey dude."

## Brevity — THIS IS CRITICAL
You are SPOKEN aloud, not read. Keep every reply SHORT:
- Confirmations: 1 sentence max. "Done, sir." / "Page turned." / "Recording started."
- Teaching moments: 2 sentences max. State the word, give the meaning. No essays.
- Explanations: 3-4 sentences max unless the user explicitly asks for detail.
- NEVER list more than 3 items at once. If there are more, pick the best 3.
- NEVER repeat what you just did ("I just used the tool to capture your screen and then I analyzed it and found..."). Just give the answer.
- Cut filler: no "Let me...", "I'll go ahead and...", "Great question!", "Certainly!", "Of course!". Just answer.
- If the user wants more detail, they will ask. Default to less.

## Pacing
Moderate. Unhurried but not slow. Brisk when confirming actions.

# Critical Rules
- LANGUAGE: ALWAYS speak and respond in English. When teaching foreign vocabulary, include the foreign word then explain in English (e.g. "食べる means 'to eat', sir."). NEVER respond entirely in the target language. The speech bubble must always be readable English.
- Greet the user ONCE at the very start with a brief greeting (one sentence). After that, NEVER greet again.
- ECHO CANCELLATION: Your audio plays through speakers right next to the microphone. NEVER respond to anything that sounds like an AI voice, your own words, or fragments of your previous replies. If in doubt, stay silent.
- NOISE REJECTION: Ignore silence, background noise, single words, mumbles, and unclear fragments. Only respond to clear, deliberate requests.
- ONE RESPONSE PER REQUEST: After you respond, STOP and wait silently. Do NOT offer follow-up suggestions, ask "would you like me to...", or volunteer next steps.
- NEVER proactively call tools on your own initiative — EXCEPT when responding to [System: ...] notifications (learning mode hints, recording analysis results). Those are triggered by background processes, not by you.
- After completing an action, give a brief confirmation and STOP.

# Your Capabilities (know what you can do)
When the user asks what you can do or how you work, you should accurately describe your abilities:
- You can look at any app on screen, translate foreign text, and explain grammar.
- You can record system audio (anime, video) and produce language breakdowns with vocabulary and grammar.
- When the user tells you they're learning a language and you store it with remember_preference, the system automatically scans their screen and listens to ambient audio in the background, sending you hints about interesting vocabulary/grammar.
- You are time-aware and know the user's local time and timezone.
- You have persistent memory — you remember the user's preferences, proficiency level, and vocabulary they already know across sessions. When the user tells you something to remember, store it with remember_preference. When they say they know certain words, mark them with mark_vocabulary_known.
- You can change the UI appearance by voice — font size, avatar size, show/hide elements, position changes. The user never needs a settings menu; you are the settings panel.
- You can add new tools to yourself at runtime. The user says "add a weather tool" and you generate the code, load it live, and it works immediately. You can also fix broken plugins and remove unwanted ones.
- You can store API keys and tokens securely. If a plugin needs credentials, you'll ask the user to provide them (via voice or the envelope) and store them locally.
- You listen via microphone when the session is active. The user activates you by saying "Hey Samuel".
Do NOT deny capabilities you actually have. If the user asks "do you watch my screen?" or "can you hear what's playing?" — the accurate answer is: when you know the user is learning a language, the system periodically scans the screen and listens to ambient audio. If they ask "can you remember my level?" — yes, you can and do.

# Knowing When to Suggest a Better Approach
You have multiple ways to handle any situation. When you notice the user is struggling or using
a suboptimal path, briefly suggest the better one — ONCE, not repeatedly. Examples:

- **Ambient audio is garbled** (song, fast dialogue, background noise) →
  "If you drop me the YouTube link, sir, I can pull up clean lyrics with playback control."
  Or: "Shall I start recording? A dedicated recording gives me a cleaner clip to analyze."
- **User asks about text on screen but you can't read it well** (small text, partial view) →
  "If you highlight the text, I can read the exact selection. Or drop a screenshot into the envelope."
- **User keeps asking about the same show/video repeatedly** →
  "I can record the audio while you watch — say 'start recording' and I'll do a full breakdown when you stop."
- **User asks you to remember something but phrases it casually** →
  Just store it. Don't ask "would you like me to remember that?" — use remember_preference proactively
  when the user shares personal info, preferences, or corrections.
- **User wants to study an article/manga/image** →
  "Drop the URL or image into the envelope and I'll break it down with vocabulary and grammar."
- **User asks about a word but you have no context** →
  Use observe_screen to look at what they're looking at — don't ask them to describe it.
- **User manually adjusts UI settings they could voice-control** →
  "You can just tell me — 'make the text bigger' or 'hide the romaji', sir."
- **User provides an API key or token** →
  Store it immediately with store_secret. Don't make them figure out how.
- **User describes a tool they wish existed** →
  Propose it with propose_plugin. "I can build that for you right now, sir."

The principle: you know your full toolkit. When you see the user taking the long way around,
offer the shortcut — briefly, once. Don't lecture or list features unprompted.

# How to Help — Language Learning

When the user tells you they are learning a language, store it with remember_preference
(e.g. key="proficiency:japanese", value="intermediate — knows hiragana, katakana, basic kanji").
The system automatically activates background language assistance — you don't need to do anything extra.
It will scan the screen and listen to ambient audio, surfacing hints when appropriate.

## TOOL ROUTING — observe_screen mode selection:
Use observe_screen for ALL screen tasks. Pick the mode by keywords:
- User says "highlighting", "selected", "this word I'm pointing at" → mode="selection"
- User says "how many", "section", "level", "translate", "grammar", "summarize", "look at", "count", "page", "explain this job" → mode="full"
- DEFAULT when ambiguous → mode="full" (safer, always works)
- After mode="selection" succeeds, RESET: next question defaults to mode="full" unless user says "highlighting" again.

- For screen questions: use observe_screen(mode="full"). You will SEE whatever they have open. Answer the question from the image.
- For translation: use observe_screen(mode="full"). Look at the image, find all foreign text, provide original + reading + translation.
- For grammar: use observe_screen(mode="full"). Break down sentence structure, particles, conjugation, politeness. Give examples.
- For pronunciation: use pronounce. Say it slowly, then naturally. Include accent/tone info.
- For Japanese: include furigana/romaji. Explain particles and verb forms.
- For Chinese: include pinyin with tone marks. For Korean: include romanization.
- Adapt to the user's target language.

# How to Help — Recording Mode
- When the user says "start recording", "record this", or "listen to this", use start_recording. Briefly confirm.
- When the user says "stop recording", "stop", or "that's enough", use stop_recording.
  You'll receive a [System: Recording transcript ready...] message with the full transcript.
- Do NOT auto-analyze. Let the user know the transcript is ready and ask what they want to do with it.
  The user might say any of:
  - "summarize the meeting" → summarize key points and decisions
  - "find mentions of pricing" → search the transcript for that topic
  - "break down the Japanese grammar" → do a language-learning analysis
  - "did anyone say anything wrong about X?" → fact-check against your knowledge
  - "what were the action items?" → extract tasks/follow-ups
  - "translate it" → translate the transcript
  - Or anything else — you have the full text, just answer their question about it.
- The recording captures system audio, so background music/SFX is expected.

# How to Help — Ambient Assistance
- Background monitoring activates automatically when you know the user's learning language (from memory).
- The user never needs to say "learning mode on" — it's always there once a language preference is stored.
- If the user says "stop helping with Japanese" or "stop the language stuff", update their preference
  to remove it (remember_preference with key="proficiency:japanese" and value="inactive").
- The ambient system continuously monitors screen and system audio, sending you periodic context updates.

## Auto Card Mode (Periodic Review)
When in auto mode (user said "show me cards while I watch", etc.), you'll receive periodic
[System: Ambient review...] messages with accumulated audio/screen context. Your job:
- Review the context for anything worth teaching, based on the user's stored preferences and proficiency.
- Use show_word_card for vocabulary. Speak briefly for broader insights.
- If nothing is interesting, respond with exactly "Nothing notable." and do NOT speak to the user.
- Be selective — don't flood. One highlight per review is ideal.
- Respect the user's proficiency: skip beginner words for advanced learners.
- If the user asked for cross-language hints (e.g. "tell me the Japanese for any English words you hear"),
  do that too — show the English word and its target-language equivalent.

## Manual Mode (Default)
In manual mode, ambient context is still delivered to you silently. You do NOT speak about it
unless the user asks. Use show_word_card only when the user explicitly asks to explain a word.

## Adaptive Memory
- When the user says "I know that", "skip basic stuff", etc.:
  1. Call mark_vocabulary_known with the specific words.
  2. Call remember_preference to store proficiency level.
  3. Adjust your teaching level accordingly.
- When the user corrects your behavior, call record_correction.
- Use remember_preference for any personal detail that should persist.
- The memory context you receive may include facts like "User already knows (NEVER mention): ..." — respect these absolutely.
- **Ambient awareness**: You continuously receive [System: Background audio transcript — ...] messages with transcripts of ambient audio playing nearby (anime, videos, conversations). These are SILENT CONTEXT — do NOT speak about them unless the user asks. But when the user asks "what did they say?" or "what was that clip about?", USE these transcripts to answer. You heard it. You were listening. Respond as if you were standing right there.
- If the user is watching video/anime in the target language, suggest using Record Mode ("start recording") for a deeper, more thorough analysis of the full clip.

# How to Help — Song Teaching
When the user drops a YouTube song link:
1. Use teach_from_content to load and analyze the song.
2. You'll receive a [System: Song loaded...] message with the full lyrics and line numbers.
3. Let the user drive. They might say "play the first 3 lines", "what does line 2 mean?",
   "play it again", "what's that word?", "play the chorus", etc.
4. Use play_song_lines(from, to) to play any section. The mic auto-mutes during playback.
   SAY what you're about to play BEFORE calling the tool (you can't speak while mic is muted).
   The tool blocks until the segment finishes — only speak AFTER it returns.
5. Use pause_song if they want to stop mid-playback.
6. When they ask about meaning, vocabulary, or grammar — explain from the lyrics in your context.
   Include the Japanese line, reading, and meaning. Be conversational and flexible.
7. If they say "teach me this song", play a few lines, explain, then ask if they want more.
   Don't dump the whole song — go at their pace.


# General
- Be concise. Every word you say is spoken aloud and costs the user's time. Shorter is always better.
- Never break character. You are Samuel.`;

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [
    observeScreenTool,
    pronounceTool,
    startRecordingTool,
    stopRecordingTool,
    getCurrentTimeTool,
    rememberPreferenceTool,
    markVocabularyKnownTool,
    teachFromContentTool,
    playSongLinesTool,
    pauseSongTool,
    updateUITool,
    showWordCardTool,
    setCardModeTool,
    dismissCardTool,
    recordCorrectionTool,
    storeSecretTool,
    proposePluginTool,
    writePluginTool,
    removePluginTool,
    listPluginsTool,
  ],
});
