import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { sendImageToSession, notifyScreenTarget, notifyRecordingAction, notifyLearningLanguage, notifyTeachContent, applyUIUpdate, dismissCurrentCard, reloadPlugins, showPluginProposal, clearPluginProposal, notifyPluginBuildProgress, playSongLines, pauseSong, showWordCard, setCardMode, toggleLyricsView, setLyricsContent, updateSongLines, getSongMeta } from "./session-bridge";
import { loadPlugin, triggerRepair, getLastExecution } from "./plugin-loader";

interface CaptureResult {
  base64: string;
  app_name: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Structured tool results — lets the model reason about error types
// ---------------------------------------------------------------------------

function toolOk(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, message, ...extra });
}

function toolErr(
  errorType: "not_found" | "permission" | "network" | "invalid_input" | "unavailable" | "timeout" | "unknown",
  message: string,
  tryInstead?: string,
): string {
  return JSON.stringify({ ok: false, error_type: errorType, message, try_instead: tryInstead ?? null });
}

// ---------------------------------------------------------------------------
// Action log — circular buffer so the model can recall what it tried
// ---------------------------------------------------------------------------

interface ActionEntry {
  tool: string;
  action?: string;
  params: Record<string, unknown>;
  result_ok: boolean;
  result_summary: string;
  ts: number;
}

const ACTION_LOG: ActionEntry[] = [];
const ACTION_LOG_MAX = 15;

function logAction(toolName: string, params: Record<string, unknown>, ok: boolean, summary: string, action?: string) {
  ACTION_LOG.push({ tool: toolName, action, params, result_ok: ok, result_summary: summary, ts: Date.now() });
  if (ACTION_LOG.length > ACTION_LOG_MAX) ACTION_LOG.shift();
}

const getRecentActionsTool = tool({
  name: "get_recent_actions",
  description:
    "Recall your recent tool calls and their outcomes. Use this when:\n" +
    "- The user says 'try something different' or 'that didn't work' (check what you already tried)\n" +
    "- You need to avoid repeating a failed approach\n" +
    "- The user asks 'what did you just do?' or 'did that work?'\n" +
    "Returns the last 15 tool calls with success/failure status.",
  parameters: z.object({}),
  execute() {
    if (ACTION_LOG.length === 0) return toolOk("No recent tool calls in this session.");
    const lines = ACTION_LOG.map((a, i) => {
      const ago = Math.round((Date.now() - a.ts) / 1000);
      const status = a.result_ok ? "OK" : "FAILED";
      const actionStr = a.action ? `.${a.action}` : "";
      return `${i + 1}. [${ago}s ago] ${a.tool}${actionStr} → ${status}: ${a.result_summary}`;
    });
    return toolOk(lines.join("\n"), { count: ACTION_LOG.length });
  },
});

// Privacy prefs are checked at call time via the getter registered from App
let getPrivacyPrefs: (() => { local_time_enabled: boolean; location_enabled: boolean }) | null = null;
export function registerPrivacyPrefsGetter(fn: typeof getPrivacyPrefs) {
  getPrivacyPrefs = fn;
}

// UI state getter — registered from App so query_ui_state can read current values
let getUIState: (() => Record<string, unknown>) | null = null;
export function registerUIStateGetter(fn: typeof getUIState) {
  getUIState = fn;
}

const getCurrentTimeTool = tool({
  name: "get_current_time",
  description:
    "Get the user's current local date, time, day of week, and timezone. " +
    "Use this when the user asks what time it is, what day it is, or anything time-related. " +
    "Respects the user's privacy setting — if disabled, returns a notice.",
  parameters: z.object({}),
  execute() {
    if (getPrivacyPrefs && !getPrivacyPrefs().local_time_enabled) {
      return "The user has disabled local time sharing in privacy settings.";
    }
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

const getLocationTool = tool({
  name: "get_location",
  description:
    "Get the user's approximate location (city, region, country) via browser geolocation. " +
    "Use when context would benefit from knowing where the user is — weather, local recommendations, " +
    "timezone-aware scheduling, etc. Respects the user's privacy setting.",
  parameters: z.object({}),
  async execute() {
    if (getPrivacyPrefs && !getPrivacyPrefs().location_enabled) {
      return "The user has disabled location sharing in privacy settings. Ask them to enable it in Settings if needed.";
    }
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 10000,
          maximumAge: 300000,
        });
      });
      const { latitude, longitude } = pos.coords;
      // Reverse geocode via free Nominatim API
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&zoom=10`,
        { headers: { "User-Agent": "Samuel-Desktop-Agent/1.0" } },
      );
      if (res.ok) {
        const data = await res.json();
        const addr = data.address ?? {};
        return JSON.stringify({
          city: addr.city ?? addr.town ?? addr.village ?? "Unknown",
          region: addr.state ?? addr.county ?? "",
          country: addr.country ?? "",
          latitude: latitude.toFixed(4),
          longitude: longitude.toFixed(4),
        });
      }
      return JSON.stringify({ latitude: latitude.toFixed(4), longitude: longitude.toFixed(4) });
    } catch (err) {
      return `Location unavailable: ${err instanceof Error ? err.message : "permission denied or not supported"}`;
    }
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
// Recording (system audio capture for language learning)
// ---------------------------------------------------------------------------

const recordingTool = tool({
  name: "recording",
  description:
    "Control system audio recording. Captures what's playing on the computer (not the microphone).\n" +
    "Actions:\n" +
    "- 'start': Begin recording. Use when user says 'start recording', 'record this', 'listen to this'.\n" +
    "- 'stop': Stop and transcribe. Use when user says 'stop recording', 'stop', 'that's enough'.\n" +
    "  After stop, you'll receive the transcript — do NOT auto-analyze. Wait for user instructions.",
  parameters: z.object({
    action: z.enum(["start", "stop"]).describe("'start' to begin, 'stop' to end and transcribe"),
  }),
  async execute({ action }) {
    if (action === "start") {
      notifyRecordingAction("start");
      try {
        await invoke("start_recording");
        const msg = "Recording started. System audio is being captured.";
        logAction("recording", {}, true, msg, "start");
        return toolOk(msg);
      } catch (e) {
        notifyRecordingAction("error", String(e));
        const msg = `Failed to start: ${e}`;
        logAction("recording", {}, false, msg, "start");
        return toolErr("unknown", msg);
      }
    }
    // stop
    notifyRecordingAction("processing");
    try {
      await invoke("stop_recording");
      notifyRecordingAction("analyze");
      const msg = "Recording stopped. Transcribing now — transcript will arrive shortly.";
      logAction("recording", {}, true, msg, "stop");
      return toolOk(msg);
    } catch (e) {
      notifyRecordingAction("error", String(e));
      const msg = `Failed to stop: ${e}`;
      logAction("recording", {}, false, msg, "stop");
      return toolErr("unknown", msg);
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

// ---------------------------------------------------------------------------
// Song Control (play, pause, lyrics display, lyrics correction — one tool)
// ---------------------------------------------------------------------------

const songControlTool = tool({
  name: "song_control",
  description:
    "Control song playback and lyrics for the currently loaded song. One tool for all song actions.\n" +
    "Actions:\n" +
    "- 'play': Play lines from_line to to_line (1-indexed). Mic auto-mutes. SAY what you'll play BEFORE calling.\n" +
    "  Most songs have an intro — for first lines use from_line=1, to_line=2 or 3 to include the intro.\n" +
    "- 'pause': Stop playback, unmute mic.\n" +
    "- 'show_lyrics': Open the scrollable lyrics panel. User says 'show me the lyrics'.\n" +
    "- 'hide_lyrics': Close the lyrics panel.\n" +
    "- 'push_lyrics': Display custom lyrics text (title + lines array). Use after finding lyrics via web.\n" +
    "- 'refetch': Search the web for better lyrics and hot-swap them. Use when user says lyrics are wrong.\n" +
    "  Optionally pass query_override if the user corrects the song title.\n" +
    "- 'correct': Fix specific lines. Pass corrections as JSON: [{\"line\":1,\"text\":\"fixed\"}].\n" +
    "Use when the user says 'play line 3', 'pause', 'show lyrics', 'the lyrics are wrong', etc.",
  parameters: z.object({
    action: z.enum(["play", "pause", "show_lyrics", "hide_lyrics", "push_lyrics", "refetch", "correct"])
      .describe("The song action to perform"),
    from_line: z.number().optional().describe("For 'play': start line (1-indexed)"),
    to_line: z.number().optional().describe("For 'play': end line (1-indexed, inclusive)"),
    title: z.string().optional().describe("For 'push_lyrics': title at top of panel"),
    lines: z.array(z.string()).optional().describe("For 'push_lyrics': array of lyric lines"),
    query_override: z.string().optional().describe("For 'refetch': custom search query"),
    corrections: z.string().optional().describe("For 'correct': JSON array of {line, text}"),
  }),
  async execute({ action, from_line, to_line, title, lines, query_override, corrections }) {
    switch (action) {
      case "play": {
        if (from_line == null || to_line == null) {
          const msg = "Need from_line and to_line for play.";
          logAction("song_control", { action }, false, msg, action);
          return toolErr("invalid_input", msg);
        }
        await playSongLines(from_line, to_line);
        const desc = from_line === to_line ? `line ${from_line}` : `lines ${from_line}–${to_line}`;
        const msg = `Finished playing ${desc}. Mic is live.`;
        logAction("song_control", { from_line, to_line }, true, msg, action);
        return toolOk(msg);
      }
      case "pause": {
        pauseSong();
        const msg = "Paused. Mic is back on.";
        logAction("song_control", {}, true, msg, action);
        return toolOk(msg);
      }
      case "show_lyrics": {
        const ok = toggleLyricsView(true);
        const msg = ok ? "Lyrics panel opened." : "No lyrics loaded.";
        logAction("song_control", {}, ok, msg, action);
        return ok ? toolOk(msg) : toolErr("unavailable", msg);
      }
      case "hide_lyrics": {
        toggleLyricsView(false);
        const msg = "Lyrics panel closed.";
        logAction("song_control", {}, true, msg, action);
        return toolOk(msg);
      }
      case "push_lyrics": {
        if (!title || !lines || lines.length === 0) {
          const msg = "Need title and non-empty lines array.";
          logAction("song_control", { action }, false, msg, action);
          return toolErr("invalid_input", msg);
        }
        const ok = setLyricsContent(title, lines);
        const msg = ok ? `Showing ${lines.length} lines.` : "Lyrics viewer unavailable.";
        logAction("song_control", { title, lineCount: lines.length }, ok, msg, action);
        return ok ? toolOk(msg) : toolErr("unavailable", msg);
      }
      case "refetch": {
        return await handleRefetchLyrics(query_override);
      }
      case "correct": {
        return handleCorrectLyrics(corrections);
      }
      default: {
        return toolErr("invalid_input", `Unknown song action: ${action}`);
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Voice-Controlled UI
// ---------------------------------------------------------------------------

const updateUITool = tool({
  name: "update_ui",
  description:
    "Change ANY visual property of the app in real-time. You ARE the settings panel. " +
    "Use when the user says anything about appearance: size, opacity, color, width, visibility, position, theme. " +
    "Available settings (component.property format):\n" +
    "AVATAR: avatar.size (80-800px), avatar.opacity (0.1-1)\n" +
    "SPEECH BUBBLE: bubble.font_size (10-32px), bubble.opacity (0.1-1), bubble.max_width (150-500px)\n" +
    "WORD CARD: word_card.visible (show/hide), word_card.position (left/right), word_card.mode (manual/auto), " +
    "word_card.interval (10-600s), word_card.font_size (10-24px)\n" +
    "ANNOTATIONS: romaji.visible (show/hide), reading.visible (show/hide)\n" +
    "TEACH VIEWER: teach.font_size (10-28px), teach.opacity (0.3-1)\n" +
    "LYRICS PANEL: lyrics.width (120-500px), lyrics.font_size (9-22px), lyrics.opacity (0.2-1), " +
    "lyrics.left (0-800px, position from left edge), lyrics.top (0-600px, position from top)\n" +
    "TRANSCRIPT: transcript.font_size (10-24px)\n" +
    "WINDOW: window.width (400-1200px), window.height (400-1200px) — resizes the app window\n" +
    "APP: app.background_opacity (0.2-1), app.accent_color (indigo/cyan/violet/emerald/rose/amber/slate), " +
    "app.border_radius (0-30px)\n" +
    "PRIVACY: privacy.screen_watch, privacy.audio_listen, privacy.local_time, privacy.location (on/off)\n" +
    "GLOBAL: all.reset (resets everything to defaults)\n" +
    "Values can be absolute ('20', '0.5') or relative ('larger', 'much bigger', 'a little smaller', " +
    "'wider', 'narrower', 'brighter', 'dimmer', 'hide', 'show', 'reset').",
  parameters: z.object({
    component: z
      .string()
      .describe(
        "The UI component: avatar, bubble, word_card, romaji, reading, teach, lyrics, " +
        "transcript, window, app, privacy, all.",
      ),
    property: z
      .string()
      .describe(
        "The property to change: size, font_size, opacity, width, height, max_width, visible, " +
        "position, left, top, mode, interval, accent_color, background_opacity, border_radius, " +
        "screen_watch, audio_listen, local_time, location, reset.",
      ),
    value: z
      .string()
      .describe(
        "The new value. Absolute ('20', '0.5', 'cyan') or relative ('larger', 'much bigger', " +
        "'a little smaller', 'wider', 'hide', 'show', 'reset', 'default').",
      ),
  }),
  execute({ component, property, value }) {
    console.log(`[update_ui] ${component}.${property} = ${value}`);
    const result = applyUIUpdate(component, property, value);
    console.log(`[update_ui] result: ${result}`);
    return result;
  },
});

// ---------------------------------------------------------------------------
// Show content in a floating panel — no plugin needed
// ---------------------------------------------------------------------------

const showContentTool = tool({
  name: "show_content",
  description:
    "Display content in a floating panel window. Use when the user says 'show me', " +
    "'display this', 'put it in a window', 'show results'. Creates a visual overlay.\n" +
    "Actions:\n" +
    "- 'show': Display HTML content in a named panel. Supports markdown-like formatting.\n" +
    "- 'hide': Remove a panel by ID.\n" +
    "- 'hide_all': Remove all panels.\n\n" +
    "For search results, format as a clean list with titles and snippets.\n" +
    "For any content, use simple semantic HTML (h3, p, ul, li, a, strong, em).\n" +
    "The panel automatically gets the dark glass theme matching the app.",
  parameters: z.object({
    action: z.enum(["show", "hide", "hide_all"]).describe("show=display content, hide=remove panel, hide_all=remove all"),
    id: z.string().optional().describe("Panel ID (e.g. 'search-results', 'email-summary'). Required for show/hide."),
    title: z.string().optional().describe("Panel title shown at the top. Required for show."),
    content: z.string().optional().describe("HTML content to display. Use semantic HTML: h3, p, ul, li, a, strong, em. Required for show."),
    position: z.string().optional().describe("'right' (default), 'left', 'center', 'bottom'"),
    width: z.string().optional().describe("Panel width (e.g. '300px', '400px'). Default '320px'."),
  }),
  execute({ action, id, title, content, position, width }) {
    // Register Escape key handler once to close all panels
    const w = window as unknown as Record<string, unknown>;
    if (!w.__samuelPanelEscRegistered) {
      w.__samuelPanelEscRegistered = true;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          const panels = document.querySelectorAll("[id^='samuel-panel-']");
          if (panels.length > 0) {
            panels.forEach((el) => el.remove());
            e.preventDefault();
          }
        }
      });
    }

    if (action === "hide_all") {
      document.querySelectorAll("[id^='samuel-panel-']").forEach((el) => el.remove());
      logAction("show_content", {}, true, "All panels hidden", "hide_all");
      return toolOk("All panels hidden.");
    }

    if (action === "hide") {
      if (!id) return toolErr("invalid_input", "Need panel ID for hide.");
      const el = document.getElementById(`samuel-panel-${id}`);
      if (el) el.remove();
      logAction("show_content", { id }, true, "Panel hidden", "hide");
      return toolOk(`Panel "${id}" hidden.`);
    }

    // show
    if (!id || !content) return toolErr("invalid_input", "Need id and content for show.");

    let panel = document.getElementById(`samuel-panel-${id}`);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = `samuel-panel-${id}`;
      panel.style.cssText = `
        position: fixed; z-index: 200; pointer-events: auto;
        background: rgba(10, 14, 30, 0.9); backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(99, 102, 241, 0.25); border-radius: 14px;
        padding: 16px; padding-top: 40px; color: #e2e8f0; font-size: 13px; line-height: 1.5;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
        animation: lyrics-hud-in 0.3s ease both;
        overflow-y: auto; max-height: 80vh;
      `;
      const pos = position ?? "right";
      if (pos === "right") { panel.style.right = "16px"; panel.style.top = "60px"; }
      else if (pos === "left") { panel.style.left = "16px"; panel.style.top = "60px"; }
      else if (pos === "center") { panel.style.left = "50%"; panel.style.top = "50%"; panel.style.transform = "translate(-50%, -50%)"; }
      else if (pos === "bottom") { panel.style.bottom = "60px"; panel.style.left = "16px"; panel.style.right = "16px"; }
      panel.style.width = width ?? "320px";
      document.body.appendChild(panel);
    }

    const titleHtml = title ? `<div style="font-size:15px;font-weight:600;margin-bottom:10px;color:#a5b4fc;padding-right:36px">${title}</div>` : "";
    const closeBtn = `<div style="position:absolute;top:8px;right:8px;cursor:pointer;color:#94a3b8;font-size:22px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:rgba(99,102,241,0.1);transition:background 0.15s" onmouseenter="this.style.background='rgba(239,68,68,0.3)';this.style.color='#fca5a5'" onmouseleave="this.style.background='rgba(99,102,241,0.1)';this.style.color='#94a3b8'" onclick="this.parentElement.remove()">✕</div>`;
    panel.style.position = "fixed";

    // Rewrite links: open in system browser, not inside the Tauri webview
    const safeContent = content.replace(
      /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*)>/gi,
      (_match: string, pre: string, href: string, post: string) => {
        const clean = href.replace(/'/g, "\\'");
        return `<a ${pre}href="#" onclick="event.preventDefault();event.stopPropagation();window.__TAURI__?.shell?.open('${clean}')||window.open('${clean}','_blank')" style="color:#818cf8;text-decoration:underline;cursor:pointer" ${post}>`;
      },
    );

    panel.innerHTML = closeBtn + titleHtml + `<div style="color:#cbd5e1">${safeContent}</div>`;

    // Safety net: intercept any clicks on <a> tags we might have missed
    panel.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest("a");
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        const href = target.getAttribute("data-href") || target.getAttribute("href");
        if (href && href !== "#") {
          // Open in system browser via Tauri shell or fallback
          if ((window as unknown as Record<string, unknown>).__TAURI__) {
            invoke("plugin:shell|open", { path: href }).catch(() => window.open(href, "_blank"));
          } else {
            window.open(href, "_blank");
          }
        }
      }
    });

    logAction("show_content", { id, position }, true, `Panel "${id}" shown`, "show");
    return toolOk(`Showing "${title ?? id}" panel.`);
  },
});

const queryUIStateTool = tool({
  name: "query_ui_state",
  description:
    "Read the current value of any UI setting. Use this BEFORE making relative changes " +
    "('make it 20% bigger' requires knowing the current size). Also useful when the user asks " +
    "'what's my font size?', 'what settings have I changed?', or 'show me my current UI config'. " +
    "Pass a specific setting path to get one value, or 'all' to get everything.",
  parameters: z.object({
    setting: z
      .string()
      .describe(
        "The setting path (e.g. 'avatar.size', 'lyrics.width') or 'all' for complete state.",
      ),
  }),
  execute({ setting }) {
    if (!getUIState) return "UI state not available.";
    const state = getUIState();
    if (setting === "all" || setting === "everything") {
      return JSON.stringify(state, null, 2);
    }
    const val = state[setting];
    if (val === undefined) return `Unknown setting: ${setting}`;
    return `${setting} = ${val}`;
  },
});

const vocabCardTool = tool({
  name: "vocab_card",
  description:
    "Manage vocabulary cards — show, dismiss, and configure automatic mode.\n" +
    "Actions:\n" +
    "- 'show': Display a card for a word. Use ONLY when user asks to explain a word.\n" +
    "  e.g. 'what does 冷たく mean?', 'show me that word', 'explain 湛えた'.\n" +
    "- 'dismiss': Close the current card. User says 'close the card', 'got it', 'next'.\n" +
    "- 'set_mode': Switch between 'manual' (on demand) and 'auto' (ambient cards while watching).\n" +
    "  User says 'show me words while I watch', 'cards every 20 seconds', 'stop auto cards'.\n" +
    "Do NOT show cards proactively in manual mode — only on explicit user request.",
  parameters: z.object({
    action: z.enum(["show", "dismiss", "set_mode"]).describe("Card action"),
    word: z.string().optional().describe("For 'show': the word in its original language"),
    reading: z.string().optional().describe("For 'show': pronunciation/furigana"),
    meaning: z.string().optional().describe("For 'show': brief translation"),
    context: z.string().optional().describe("For 'show': example sentence"),
    mode: z.string().optional().describe("For 'set_mode': 'manual' or 'auto'"),
    interval_seconds: z.number().optional().describe("For 'set_mode': auto frequency (10-600s)"),
  }),
  execute({ action, word, reading, meaning, context, mode, interval_seconds }) {
    switch (action) {
      case "show": {
        if (!word || !meaning) {
          return toolErr("invalid_input", "Need word and meaning for show.");
        }
        const ok = showWordCard({ word, reading, meaning, context });
        const msg = ok ? `Showing card for "${word}".` : "Card display not available.";
        logAction("vocab_card", { word }, ok, msg, "show");
        return ok ? toolOk(msg) : toolErr("unavailable", msg);
      }
      case "dismiss": {
        const ok = dismissCurrentCard();
        const msg = ok ? "Card dismissed." : "No card visible.";
        logAction("vocab_card", {}, ok, msg, "dismiss");
        return ok ? toolOk(msg) : toolOk(msg);
      }
      case "set_mode": {
        const m = mode === "auto" ? "auto" as const : "manual" as const;
        setCardMode(m, interval_seconds);
        const msg = m === "auto"
          ? `Auto cards on${interval_seconds ? ` every ~${interval_seconds}s` : ""}.`
          : "Manual mode — cards only when you ask.";
        logAction("vocab_card", { mode: m, interval_seconds }, true, msg, "set_mode");
        return toolOk(msg);
      }
      default:
        return toolErr("invalid_input", `Unknown vocab_card action: ${action}`);
    }
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
// OAuth — Connect to third-party services (Gmail, GitHub, Spotify, etc.)
// ---------------------------------------------------------------------------

interface OAuthResult {
  provider: string;
  token_key: string;
  success: boolean;
  message: string;
}

const oauthConnectTool = tool({
  name: "oauth_connect",
  description:
    "Connect to a third-party service via OAuth. Opens the user's browser for sign-in, " +
    "catches the callback, exchanges for tokens, and stores them securely.\n" +
    "Actions:\n" +
    "- 'connect': Start OAuth flow. Opens browser, user signs in, token stored automatically.\n" +
    "  Known providers: google, github, spotify (auto-configured endpoints).\n" +
    "  Custom providers: pass auth_url + token_url + client_id.\n" +
    "- 'refresh': Refresh an expired token (uses stored refresh_token).\n" +
    "- 'check': Check if a provider is already connected (has stored tokens).\n\n" +
    "Known providers (google, github, spotify) have BUILT-IN credentials — just connect, no setup.\n" +
    "For custom providers: pass auth_url, token_url, and client_id.\n\n" +
    "After connecting, create a plugin that uses the stored token to call the service's API.\n" +
    "Example: secrets.get('GOOGLE_ACCESS_TOKEN') in a plugin to call Gmail API.\n" +
    "DO NOT ask users for client IDs for known providers. It just works.",
  parameters: z.object({
    action: z.enum(["connect", "refresh", "check"]).describe("OAuth action"),
    provider: z.string().describe("Provider name: 'google', 'github', 'spotify', or custom name"),
    scopes: z.string().optional().describe("OAuth scopes (space-separated). E.g. 'https://www.googleapis.com/auth/gmail.readonly' for Gmail"),
    auth_url: z.string().optional().describe("For custom providers: authorization URL"),
    token_url: z.string().optional().describe("For custom providers: token exchange URL"),
    client_id: z.string().optional().describe("Override client ID (or use stored secret)"),
    client_secret: z.string().optional().describe("Override client secret (or use stored secret)"),
  }),
  async execute({ action, provider, scopes, auth_url, token_url, client_id, client_secret }) {
    if (action === "check") {
      try {
        const prefix = provider.toUpperCase();
        const token = await invoke<string | null>("get_secret", { name: `${prefix}_ACCESS_TOKEN` });
        if (token) {
          const expiresAt = await invoke<string | null>("get_secret", { name: `${prefix}_TOKEN_EXPIRES_AT` });
          const expired = expiresAt ? Number(expiresAt) < Date.now() / 1000 : false;
          const status = expired ? "connected but token expired (use refresh)" : "connected";
          logAction("oauth_connect", { provider }, true, status, "check");
          return toolOk(`${provider}: ${status}`, { connected: true, expired });
        }
        logAction("oauth_connect", { provider }, true, "not connected", "check");
        return toolOk(`${provider}: not connected. Use action='connect' to sign in.`, { connected: false });
      } catch (err) {
        return toolErr("unknown", `Check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (action === "refresh") {
      try {
        const result = await invoke<OAuthResult>("oauth_refresh", {
          provider,
          customTokenUrl: token_url ?? null,
          customClientId: client_id ?? null,
          customClientSecret: client_secret ?? null,
        });
        logAction("oauth_connect", { provider }, result.success, result.message, "refresh");
        return result.success ? toolOk(result.message) : toolErr("network", result.message);
      } catch (err) {
        const msg = `Refresh failed: ${err instanceof Error ? err.message : String(err)}`;
        logAction("oauth_connect", { provider }, false, msg, "refresh");
        return toolErr("network", msg);
      }
    }

    // connect
    try {
      const result = await invoke<OAuthResult>("oauth_flow", {
        provider,
        scopes: scopes ?? null,
        customAuthUrl: auth_url ?? null,
        customTokenUrl: token_url ?? null,
        customClientId: client_id ?? null,
        customClientSecret: client_secret ?? null,
      });
      logAction("oauth_connect", { provider }, result.success, result.message, "connect");
      return result.success
        ? toolOk(result.message, { token_key: result.token_key })
        : toolErr("network", result.message);
    } catch (err) {
      const msg = `OAuth failed: ${err instanceof Error ? err.message : String(err)}`;
      logAction("oauth_connect", { provider }, false, msg, "connect");
      return toolErr("network", msg, "Check that client_id and client_secret are stored in secrets");
    }
  },
});

// ---------------------------------------------------------------------------
// Self-Modification Tools (dynamic plugin system)
// ---------------------------------------------------------------------------

const pluginManageTool = tool({
  name: "plugin_manage",
  description:
    "Manage dynamic plugins — propose, create, repair, remove, or list custom tools.\n" +
    "Uses GPT-5.5 with reasoning for code generation.\n" +
    "Actions:\n" +
    "- 'propose': Show approval UI FIRST. ALWAYS call this before 'write'. Needs name + summary.\n" +
    "- 'write': Generate and install after user approves. NEVER without prior propose+approval.\n" +
    "  When fixing a plugin, use the SAME name (overwrites; do NOT create _v2 copies).\n" +
    "- 'repair': Fix a broken plugin. Runs diagnosis → targeted fix → verify. Use when user says\n" +
    "  'that's not right', 'fix it', 'that plugin is broken', or when a plugin fails.\n" +
    "- 'remove': Delete a plugin. User says 'remove that tool', 'I don't need it'.\n" +
    "- 'list': Show installed plugins. User says 'what plugins do I have'.",
  parameters: z.object({
    action: z.enum(["propose", "write", "repair", "remove", "list"]).describe("Plugin action"),
    name: z.string().optional().describe("Plugin name (snake_case). Required for propose/write/repair/remove."),
    summary: z.string().optional().describe("For 'propose': 1-2 sentence user-facing summary."),
    description: z.string().optional().describe("For 'write': detailed spec for code generation."),
    feedback: z.string().optional().describe("For 'repair': what the user said was wrong."),
  }),
  async execute({ action, name, summary, description, feedback }) {
    switch (action) {
      case "propose": {
        if (!name || !summary) return toolErr("invalid_input", "Need name and summary for propose.");
        showPluginProposal({ name, summary });
        const msg = `Proposal shown: "${name}" — ${summary}. Wait for user approval.`;
        logAction("plugin_manage", { name }, true, msg, "propose");
        return toolOk(msg);
      }
      case "repair": {
        // Diagnosis-routed repair: detect what's wrong, pick a strategy, fix it
        const targetName = name ?? getLastExecution()?.pluginName;
        if (!targetName) return toolErr("invalid_input", "No plugin to repair. Specify a name or run a plugin first.");
        notifyPluginBuildProgress({ name: targetName, phase: "diagnosing" });
        try {
          const lastRun = getLastExecution();
          const result = await triggerRepair(
            targetName,
            lastRun?.args ?? {},
            lastRun?.result,
            lastRun?.error ?? feedback ?? "User reported output is wrong",
            feedback ? "user_feedback" : "auto",
            feedback,
          );
          if (result.success) {
            notifyPluginBuildProgress({ name: targetName, phase: "reloading" });
            await reloadPlugins();
            notifyPluginBuildProgress({ name: targetName, phase: "done" });
            setTimeout(() => notifyPluginBuildProgress(null), 2500);
            logAction("plugin_manage", { name: targetName }, true, result.message, "repair");
            return toolOk(result.message);
          }
          notifyPluginBuildProgress({ name: targetName, phase: "error", error: result.message });
          setTimeout(() => notifyPluginBuildProgress(null), 4000);
          logAction("plugin_manage", { name: targetName }, false, result.message, "repair");
          return toolErr("unknown", result.message);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notifyPluginBuildProgress({ name: targetName, phase: "error", error: msg });
          setTimeout(() => notifyPluginBuildProgress(null), 4000);
          logAction("plugin_manage", { name: targetName }, false, msg, "repair");
          return toolErr("unknown", `Repair failed: ${msg}`);
        }
      }
      case "write": {
        if (!name || !description) return toolErr("invalid_input", "Need name and description for write.");
        clearPluginProposal();
        notifyPluginBuildProgress({ name, phase: "generating" });
        try {
          let fullDescription = description;
          try {
            const existing = await invoke<string>("read_plugin", { name });
            fullDescription = `EXISTING PLUGIN CODE (to fix/modify):\n\`\`\`\n${existing}\n\`\`\`\n\nREQUESTED CHANGE:\n${description}`;
          } catch { /* new plugin */ }

          let code = await invoke<string>("generate_plugin_code", { description: fullDescription });

          notifyPluginBuildProgress({ name, phase: "validating" });
          try {
            loadPlugin(code);
          } catch (valErr) {
            const errMsg = valErr instanceof Error ? valErr.message : String(valErr);
            notifyPluginBuildProgress({ name, phase: "retrying" });
            code = await invoke<string>("generate_plugin_code", {
              description: fullDescription + "\n\nPREVIOUS ATTEMPT FAILED:\n```\n" + code + "\n```\nERROR: " + errMsg + "\nFix this.",
            });
            notifyPluginBuildProgress({ name, phase: "validating" });
            loadPlugin(code);
          }

          notifyPluginBuildProgress({ name, phase: "checking" });
          const judgment = await invoke<string>("judge_plugin_code", { description, code });
          if (judgment !== "ok") {
            notifyPluginBuildProgress({ name, phase: "retrying" });
            code = await invoke<string>("generate_plugin_code", {
              description: fullDescription + "\n\nCODE REVIEW ISSUE:\n" + judgment + "\nFix this.",
            });
            notifyPluginBuildProgress({ name, phase: "validating" });
            loadPlugin(code);
          }

          notifyPluginBuildProgress({ name, phase: "installing" });
          await invoke<string>("write_plugin", { name, code });
          notifyPluginBuildProgress({ name, phase: "reloading" });
          const reloaded = await reloadPlugins();
          notifyPluginBuildProgress({ name, phase: "done" });
          setTimeout(() => notifyPluginBuildProgress(null), 2500);

          const msg = reloaded
            ? `Plugin '${name}' created and loaded.`
            : `Plugin '${name}' saved but reload failed. Will load on next connect.`;
          logAction("plugin_manage", { name }, true, msg, "write");
          return toolOk(msg);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          notifyPluginBuildProgress({ name, phase: "error", error: errMsg });
          setTimeout(() => notifyPluginBuildProgress(null), 4000);
          logAction("plugin_manage", { name }, false, errMsg, "write");
          return toolErr("unknown", `Failed to create plugin: ${errMsg}`);
        }
      }
      case "remove": {
        if (!name) return toolErr("invalid_input", "Need plugin name for remove.");
        try {
          await invoke<string>("delete_plugin", { name });
          await reloadPlugins();
          const msg = `Plugin '${name}' removed.`;
          logAction("plugin_manage", { name }, true, msg, "remove");
          return toolOk(msg);
        } catch (err) {
          const msg = `Failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("plugin_manage", { name }, false, msg, "remove");
          return toolErr("unknown", msg);
        }
      }
      case "list": {
        try {
          const names = await invoke<string[]>("list_plugins");
          const msg = names.length === 0
            ? "No custom plugins installed."
            : `Installed (${names.length}): ${names.join(", ")}`;
          logAction("plugin_manage", {}, true, msg, "list");
          return toolOk(msg);
        } catch (err) {
          return toolErr("unknown", `Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      default:
        return toolErr("invalid_input", `Unknown plugin action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Web browsing — search the internet and read web pages
// ---------------------------------------------------------------------------

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface DeepSearchResult {
  answer: string;
  sources: string[];
}

const webBrowseTool = tool({
  name: "web_browse",
  description:
    "Search the internet or read a web page. Use for looking up lyrics, articles, facts, docs, etc.\n" +
    "Actions:\n" +
    "- 'search': Web search via Google/SerpAPI. Returns titles, URLs, snippets. Supports pagination with 'page'.\n" +
    "  User says 'look up X', 'search for Y', 'find information about Z'. Set page=2,3… for more results.\n" +
    "- 'deep_search': AI-powered web search via OpenAI. Returns a comprehensive answer with cited sources.\n" +
    "  Use when user says 'search more', 'find more details', 'deep search', or when basic search isn't enough.\n" +
    "- 'read': Fetch and read a URL. Returns the page's text. Use after search, or on any URL the user provides.",
  parameters: z.object({
    action: z.enum(["search", "read", "deep_search"]).describe("'search' for web search, 'deep_search' for AI-powered search, 'read' for fetching a URL"),
    query: z.string().optional().describe("For 'search'/'deep_search': the search query"),
    url: z.string().optional().describe("For 'read': the full URL to fetch"),
    page: z.number().optional().describe("For 'search': result page number (default 1). Use 2, 3, etc. for more results."),
  }),
  execute: async ({ action, query, url, page }) => {
    if (action === "search") {
      if (!query) return toolErr("invalid_input", "Need a query for search.");
      try {
        const pg = page ?? 1;
        const results = await invoke<WebSearchResult[]>("web_search", { query, page: pg });
        if (results.length === 0) {
          logAction("web_browse", { query, page: pg }, false, "No results", "search");
          return toolErr("not_found", `No results on page ${pg}.`, pg > 1 ? "Try deep_search for comprehensive results" : "Try different keywords or deep_search");
        }
        const offset = (pg - 1) * 10;
        const formatted = results
          .map((r, i) => `${offset + i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
        logAction("web_browse", { query, page: pg }, true, `${results.length} results (page ${pg})`, "search");
        return toolOk(formatted, { count: results.length, page: pg, has_more: results.length >= 8 });
      } catch (err) {
        const msg = `Search failed: ${err instanceof Error ? err.message : String(err)}`;
        logAction("web_browse", { query }, false, msg, "search");
        return toolErr("network", msg);
      }
    }

    if (action === "deep_search") {
      if (!query) return toolErr("invalid_input", "Need a query for deep_search.");
      try {
        const result = await invoke<DeepSearchResult>("web_search_openai", { query });
        const sourcesFormatted = result.sources.length > 0
          ? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. ${s}`).join("\n")
          : "";
        logAction("web_browse", { query }, true, `${result.answer.length} chars, ${result.sources.length} sources`, "deep_search");
        return toolOk(result.answer + sourcesFormatted, { sources_count: result.sources.length });
      } catch (err) {
        const msg = `Deep search failed: ${err instanceof Error ? err.message : String(err)}`;
        logAction("web_browse", { query }, false, msg, "deep_search");
        return toolErr("network", msg, "Try action='search' as fallback");
      }
    }

    // read
    if (!url) return toolErr("invalid_input", "Need a URL for read.");
    try {
      const text = await invoke<string>("web_read", { url });
      if (!text) {
        logAction("web_browse", { url }, false, "No content", "read");
        return toolErr("not_found", "Page returned no readable content.");
      }
      logAction("web_browse", { url }, true, `${text.length} chars`, "read");
      return toolOk(text);
    } catch (err) {
      const msg = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      logAction("web_browse", { url }, false, msg, "read");
      return toolErr("network", msg);
    }
  },
});

// ---------------------------------------------------------------------------
// Browser automation — use real browser like a human
// ---------------------------------------------------------------------------

interface BrowserResult { ok: boolean; data: Record<string, unknown>; }

const browserUseTool = tool({
  name: "browser_use",
  description:
    "Control the user's real Chrome browser. Opens tabs in their actual Chrome with existing logins.\n" +
    "The user is ALREADY signed in to their services — no re-login needed.\n" +
    "For complex multi-step tasks, prefer computer_use instead (GPT-5.5 visual agent).\n\n" +
    "Actions:\n" +
    "- 'open': Open a URL in a new browser tab. Use to start browsing.\n" +
    "- 'goto': Navigate the current tab to a new URL.\n" +
    "- 'read_page': Extract readable text from the current page (or a specific selector).\n" +
    "- 'read_structure': Get clickable elements, links, buttons, inputs on the page.\n" +
    "- 'click': Click an element by CSS selector or visible text.\n" +
    "- 'type': Type text into a focused input or specific selector.\n" +
    "- 'press': Press a keyboard key (Enter, Tab, Escape, etc.).\n" +
    "- 'screenshot': Take a screenshot of the current page (sent as image to you).\n" +
    "- 'scroll': Scroll up or down.\n" +
    "- 'wait': Wait for page to load or update.\n" +
    "- 'list_tabs': List all open browser tabs.\n" +
    "- 'switch_tab': Switch to a different tab by ID.\n" +
    "- 'close_tab': Close a tab.\n" +
    "- 'close': Shut down the browser entirely.\n\n" +
    "WORKFLOW for email:\n" +
    "1. open url='https://mail.google.com'\n" +
    "2. Tell user: 'I opened Gmail. Please sign in if needed.'\n" +
    "3. wait + screenshot to check if signed in\n" +
    "4. read_page to get email content\n" +
    "5. Summarize and present to user\n\n" +
    "IMPORTANT: Always tell the user what you're doing. Their sessions are already available.\n" +
    "For complex multi-step workflows, prefer computer_use (GPT-5.5 visual agent) instead.",
  parameters: z.object({
    action: z.enum([
      "open", "goto", "read_page", "read_structure",
      "click", "type", "press", "screenshot",
      "scroll", "wait", "list_tabs", "switch_tab", "close_tab", "close",
    ]).describe("The browser action to perform"),
    url: z.string().optional().describe("URL for 'open' or 'goto'"),
    selector: z.string().optional().describe("CSS selector for 'click', 'type', or 'read_page'"),
    text: z.string().optional().describe("For 'click': visible text to click. For 'type': text to enter."),
    key: z.string().optional().describe("For 'press': key name (Enter, Tab, Escape, ArrowDown, etc.)"),
    direction: z.string().optional().describe("For 'scroll': 'up' or 'down' (default: down)"),
    pixels: z.number().optional().describe("For 'scroll': pixels to scroll (default: 600)"),
    tabId: z.number().optional().describe("For 'switch_tab' or 'close_tab': tab ID"),
    ms: z.number().optional().describe("For 'wait': milliseconds to wait (max 10000)"),
  }),
  async execute({ action, url, selector, text, key, direction, pixels, tabId, ms }) {
    try {
      // Build params object for the Rust command
      const params: Record<string, unknown> = {};
      if (url) params.url = url;
      if (selector) params.selector = selector;
      if (text) params.text = text;
      if (key) params.key = key;
      if (direction) params.direction = direction;
      if (pixels) params.pixels = pixels;
      if (tabId) params.tabId = tabId;
      if (ms) params.ms = ms;

      // Close action uses its own command
      if (action === "close") {
        await invoke<string>("browser_close");
        logAction("browser_use", {}, true, "Browser closed", "close");
        return toolOk("Browser closed.");
      }

      const result = await invoke<BrowserResult>("browser_command", { action, params });

      if (!result.ok) {
        const errMsg = (result.data as Record<string, unknown>)?.error ?? "Unknown browser error";
        logAction("browser_use", params, false, String(errMsg), action);
        return toolErr("unknown", String(errMsg));
      }

      const data = result.data;

      // If it's a screenshot, send the image into the Realtime conversation
      if (action === "screenshot" && data.base64) {
        sendImageToSession(data.base64 as string);
        logAction("browser_use", params, true, `Screenshot of: ${data.title || "page"}`, action);
        return toolOk(`Screenshot taken of "${data.title}". Look at the image to see the current page state.`);
      }

      // For read_page, truncate if very long
      if (action === "read_page" && data.text) {
        const txt = data.text as string;
        const truncated = txt.length > 6000 ? txt.slice(0, 6000) + "\n...(truncated)" : txt;
        logAction("browser_use", params, true, `${txt.length} chars from ${data.title}`, action);
        return toolOk(truncated, { title: data.title, url: data.url, full_length: txt.length });
      }

      logAction("browser_use", params, true, JSON.stringify(data).slice(0, 200), action);
      return toolOk(JSON.stringify(data));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logAction("browser_use", { action }, false, msg, action);

      if (msg.includes("process exited") || msg.includes("not running")) {
        return toolErr("unavailable", "Browser not running. Use action='open' with a URL to start it.");
      }
      return toolErr("unknown", msg);
    }
  },
});

// ---------------------------------------------------------------------------
// Computer Use — GPT-5.5 visual agent that can see + operate the browser
// ---------------------------------------------------------------------------

interface CuaResult {
  ok: boolean;
  turns_used: number;
  summary: string;
  final_screenshot_base64: string | null;
}

const computerUseTool = tool({
  name: "computer_use",
  description:
    "Let GPT-5.5 visually operate the browser — it can see the screen and click/type/scroll like a human.\n" +
    "Use for ANY complex browser task: sign into services, fill forms, navigate multi-step workflows,\n" +
    "read dashboards, or complete tasks that need visual understanding.\n\n" +
    "This is FAR more capable than browser_use because GPT-5.5 can SEE the page screenshots\n" +
    "and decide where to click, what to type, etc. It handles unexpected popups, login walls,\n" +
    "CAPTCHAs (asks user), and layout changes automatically.\n\n" +
    "WHEN TO USE:\n" +
    "- User says 'check my email', 'go to LinkedIn', 'order from Amazon' → computer_use\n" +
    "- Complex multi-step web tasks (booking, shopping, form filling) → computer_use\n" +
    "- Any task where you need to SEE what's on the page → computer_use\n\n" +
    "WHEN NOT TO USE:\n" +
    "- Simple URL open + text extraction → browser_use is faster\n" +
    "- Non-browser tasks → use other tools\n\n" +
    "The model runs in a loop: screenshot → plan → act → screenshot → ... until done.\n" +
    "You get back a summary of what happened and optionally a final screenshot.",
  parameters: z.object({
    task: z.string().describe(
      "Natural language description of what to do. Be specific. " +
      "Example: 'Go to Gmail, open the first unread email, and summarize it.'"
    ),
    url: z.string().optional().describe(
      "Starting URL. If provided, opens this page first. " +
      "Example: 'https://mail.google.com'"
    ),
  }),
  async execute({ task, url }) {
    try {
      logAction("computer_use", { task, url }, true, "Starting CUA session", "start");

      const result = await invoke<CuaResult>("cua_run", { task, url });

      if (result.final_screenshot_base64) {
        sendImageToSession(result.final_screenshot_base64);
      }

      logAction("computer_use", { task }, result.ok, result.summary, "complete");

      return toolOk(result.summary, {
        turns_used: result.turns_used,
        has_screenshot: !!result.final_screenshot_base64,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logAction("computer_use", { task }, false, msg, "error");

      if (msg.includes("No API key")) {
        return toolErr("unavailable", "Need an OpenAI API key for computer use.");
      }
      if (msg.includes("No active tab") || msg.includes("not running")) {
        return toolErr("unavailable", msg, "Try with a url parameter to open the browser first.");
      }
      return toolErr("unknown", `Computer use failed: ${msg}`, "Try browser_use for simpler tasks.");
    }
  },
});

// ---------------------------------------------------------------------------
// Song control helpers (refetch + correct)
// ---------------------------------------------------------------------------

async function handleRefetchLyrics(queryOverride?: string): Promise<string> {
  const meta = getSongMeta();
  if (!meta.title && !queryOverride) {
    const msg = "No song loaded. Drop a YouTube link first.";
    logAction("song_control", {}, false, msg, "refetch");
    return toolErr("unavailable", msg, "teach_from_content");
  }

  const title = queryOverride ?? meta.title ?? "song lyrics";
  const prevSource = meta.source ?? "unknown";
  console.log(`[refetch] searching: ${title} (prev: ${prevSource})`);

  const queries = [`${title} lyrics`, `${title} 歌詞`];

  for (const query of queries) {
    try {
      const results = await invoke<WebSearchResult[]>("web_search", { query });
      if (!results || results.length === 0) continue;

      for (const result of results.slice(0, 3)) {
        const url = result.url.toLowerCase();
        if (url.includes("youtube.com") || url.includes("youtu.be")) continue;
        if (url.includes("amazon.") || url.includes("spotify.")) continue;

        try {
          const pageText = await invoke<string>("web_read", { url: result.url });
          if (!pageText || pageText.length < 50) continue;

          const extracted = extractLyricsFromPage(pageText);
          if (extracted.length < 3) continue;

          const contentLines = extracted.map((text, i) => ({
            text,
            timestamp: null as number | null,
            source_index: i,
          }));
          const ok = updateSongLines(contentLines);
          if (!ok) {
            logAction("song_control", { query }, false, "Display update failed", "refetch");
            return toolErr("unavailable", "Failed to update lyrics display.");
          }

          const msg = `Found ${extracted.length} lines from ${result.title}. Replaced prev source "${prevSource}".`;
          console.log(`[refetch] ${msg}`);
          logAction("song_control", { query, url: result.url }, true, msg, "refetch");
          return toolOk(msg);
        } catch (e) {
          console.log(`[refetch] read failed ${result.url}:`, e);
        }
      }
    } catch (e) {
      console.log(`[refetch] search failed "${query}":`, e);
    }
  }

  const msg = "Could not find better lyrics. Try providing the correct song title via query_override.";
  logAction("song_control", { title }, false, msg, "refetch");
  return toolErr("not_found", msg, "song_control.push_lyrics or song_control.correct");
}

function handleCorrectLyrics(corrections?: string): string {
  const meta = getSongMeta();
  if (!meta.title) {
    const msg = "No song loaded.";
    logAction("song_control", {}, false, msg, "correct");
    return toolErr("unavailable", msg);
  }
  if (meta.lines.length === 0) {
    const msg = "No lyrics displayed.";
    logAction("song_control", {}, false, msg, "correct");
    return toolErr("unavailable", msg);
  }
  if (!corrections) {
    return toolErr("invalid_input", "Need corrections JSON.");
  }

  let parsed: Array<{ line: number; text: string }>;
  try {
    parsed = JSON.parse(corrections);
  } catch {
    return toolErr("invalid_input", "Invalid JSON. Expected [{line, text}, ...].");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return toolErr("invalid_input", "Empty corrections array.");
  }

  const updated = meta.lines.map((l) => ({ ...l }));
  const applied: string[] = [];
  for (const { line, text } of parsed) {
    const idx = line - 1;
    if (idx < 0 || idx >= updated.length) {
      return toolErr("invalid_input", `Line ${line} out of range (1–${updated.length}).`);
    }
    const old = updated[idx].text;
    updated[idx] = { ...updated[idx], text };
    applied.push(`${line}: "${old}" → "${text}"`);
  }

  const ok = updateSongLines(updated);
  if (!ok) return toolErr("unavailable", "Failed to update display.");

  const msg = `Corrected ${applied.length} line(s).`;
  console.log(`[correct] ${applied.join("; ")}`);
  logAction("song_control", { count: applied.length }, true, msg, "correct");
  return toolOk(msg, { applied });
}

function extractLyricsFromPage(text: string): string[] {
  const raw = text.split("\n");
  const lines: string[] = [];

  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 200) continue;
    if (/^(menu|home|search|login|sign|copyright|©|cookie|privacy|terms|share|tweet|facebook)/i.test(trimmed)) continue;
    if (/^\d+\s*(views|likes|comments|shares|plays)/i.test(trimmed)) continue;
    if (/^(advertisement|sponsored|related|you might also)/i.test(trimmed)) continue;
    if (trimmed.length <= 150) lines.push(trimmed);
  }

  if (lines.length > 100) {
    let bestStart = 0, bestLen = 0, start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 80 || lines[i].length < 2) {
        const len = i - start;
        if (len > bestLen) { bestStart = start; bestLen = len; }
        start = i + 1;
      }
    }
    const len = lines.length - start;
    if (len > bestLen) { bestStart = start; bestLen = len; }
    if (bestLen >= 5) return lines.slice(bestStart, bestStart + bestLen);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

const fileOpTool = tool({
  name: "file_op",
  description:
    "Read, write, or list files on the user's computer.\n" +
    "Actions:\n" +
    "- 'write': Save content to a file. User says 'save this', 'export', 'write to file'.\n" +
    "  Default location: ~/Documents/Samuel/. Choose the right extension (.md, .txt, .py, .json, .csv).\n" +
    "- 'read': Read a file. User says 'open', 'read', 'show me that file'. Max 500 KB.\n" +
    "- 'list': List files in a directory. Use to check what exists before read/write.\n" +
    "Paths starting with ~/ are expanded to home directory.",
  parameters: z.object({
    action: z.enum(["write", "read", "list"]).describe("File operation"),
    path: z.string().describe("File or directory path. Use ~/Documents/Samuel/ as default."),
    content: z.string().optional().describe("For 'write': the file content"),
  }),
  execute: async ({ action, path, content }) => {
    switch (action) {
      case "write": {
        if (!content) return toolErr("invalid_input", "Need content for write.");
        try {
          const result = await invoke<string>("agent_write_file", { path, content });
          logAction("file_op", { path }, true, result, "write");
          return toolOk(result);
        } catch (err) {
          const msg = `Write failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("file_op", { path }, false, msg, "write");
          return toolErr("permission", msg, "Try a different path");
        }
      }
      case "read": {
        try {
          const text = await invoke<string>("agent_read_file", { path });
          logAction("file_op", { path }, true, `${(text || "").length} chars`, "read");
          return toolOk(text || "(file is empty)");
        } catch (err) {
          const msg = `Read failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("file_op", { path }, false, msg, "read");
          return toolErr("not_found", msg, "Check the path with file_op.list");
        }
      }
      case "list": {
        try {
          const entries = await invoke<string[]>("agent_list_directory", { path });
          const msg = entries.length === 0 ? "Directory is empty." : entries.join("\n");
          logAction("file_op", { path }, true, `${entries.length} entries`, "list");
          return toolOk(msg);
        } catch (err) {
          const msg = `List failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("file_op", { path }, false, msg, "list");
          return toolErr("not_found", msg);
        }
      }
      default:
        return toolErr("invalid_input", `Unknown file action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Skills (procedural memory) — learn and reuse multi-step workflows
// ---------------------------------------------------------------------------

interface SkillSummary {
  id: string;
  title: string;
  trigger: string;
  summary: string;
}

function buildSkillMarkdown(id: string, title: string, trigger: string, summary: string, steps: string): string {
  return `---\ntitle: "${title}"\ntrigger: "${trigger}"\nsummary: "${summary}"\n---\n\n${steps}\n`;
}

const SKILLS_DIR = "~/.samuel/skills";

const skillManageTool = tool({
  name: "skill_manage",
  description:
    "Save, search, list, read, or delete reusable multi-step workflows (skills).\n" +
    "Actions:\n" +
    "- 'save': Save a workflow you just executed successfully. Provide id, title, trigger, summary, steps.\n" +
    "  Steps should be a numbered markdown list of the tool calls and logic.\n" +
    "- 'search': Find skills by keyword. Matches against title, trigger, and summary.\n" +
    "- 'list': List all saved skills with their summaries.\n" +
    "- 'get': Read the full content of a specific skill by id.\n" +
    "- 'delete': Remove a skill by id.\n" +
    "Use this to remember successful workflows so you can repeat them without re-inventing the approach.",
  parameters: z.object({
    action: z.enum(["save", "search", "list", "get", "delete"]).describe("Skill operation"),
    id: z.string().optional().describe("Skill identifier (kebab-case, e.g. 'fix-lyrics-from-web'). Required for save/get/delete."),
    title: z.string().optional().describe("Human-readable skill name. Required for save."),
    trigger: z.string().optional().describe("When to use this skill — natural language pattern. Required for save."),
    summary: z.string().optional().describe("One-sentence description of what the skill does. Required for save."),
    steps: z.string().optional().describe("Numbered markdown steps of the workflow. Required for save."),
    query: z.string().optional().describe("Search keyword. Required for search."),
  }),
  execute: async ({ action, id, title, trigger, summary, steps, query }) => {
    switch (action) {
      case "save": {
        if (!id || !title || !trigger || !summary || !steps) {
          return toolErr("invalid_input", "save requires id, title, trigger, summary, and steps.");
        }
        const safeName = id.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
        const content = buildSkillMarkdown(safeName, title, trigger, summary, steps);
        try {
          const result = await invoke<string>("agent_write_file", {
            path: `${SKILLS_DIR}/${safeName}.md`,
            content,
          });
          logAction("skill_manage", { id: safeName }, true, result, "save");
          return toolOk(`Skill "${title}" saved as ${safeName}.md`);
        } catch (err) {
          const msg = `Save skill failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { id: safeName }, false, msg, "save");
          return toolErr("permission", msg);
        }
      }
      case "list": {
        try {
          const skills = await invoke<SkillSummary[]>("skill_list_summaries");
          if (skills.length === 0) {
            logAction("skill_manage", {}, true, "no skills", "list");
            return toolOk("No skills saved yet.");
          }
          const text = skills
            .map((s) => `- **${s.title || s.id}** [${s.id}]: ${s.summary || "(no summary)"}${s.trigger ? `\n  Trigger: ${s.trigger}` : ""}`)
            .join("\n");
          logAction("skill_manage", {}, true, `${skills.length} skills`, "list");
          return toolOk(text, { count: skills.length });
        } catch (err) {
          const msg = `List skills failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", {}, false, msg, "list");
          return toolErr("unknown", msg);
        }
      }
      case "search": {
        if (!query) return toolErr("invalid_input", "search requires a query.");
        try {
          const skills = await invoke<SkillSummary[]>("skill_list_summaries");
          const q = query.toLowerCase();
          const matches = skills.filter(
            (s) =>
              s.id.toLowerCase().includes(q) ||
              s.title.toLowerCase().includes(q) ||
              s.trigger.toLowerCase().includes(q) ||
              s.summary.toLowerCase().includes(q),
          );
          if (matches.length === 0) {
            logAction("skill_manage", { query }, true, "no matches", "search");
            return toolOk(`No skills match "${query}".`);
          }
          const text = matches
            .map((s) => `- **${s.title || s.id}** [${s.id}]: ${s.summary || "(no summary)"}`)
            .join("\n");
          logAction("skill_manage", { query }, true, `${matches.length} matches`, "search");
          return toolOk(text, { count: matches.length });
        } catch (err) {
          const msg = `Search skills failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { query }, false, msg, "search");
          return toolErr("unknown", msg);
        }
      }
      case "get": {
        if (!id) return toolErr("invalid_input", "get requires an id.");
        try {
          const content = await invoke<string>("agent_read_file", { path: `${SKILLS_DIR}/${id}.md` });
          logAction("skill_manage", { id }, true, `${content.length} chars`, "get");
          return toolOk(content);
        } catch (err) {
          const msg = `Read skill failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { id }, false, msg, "get");
          return toolErr("not_found", msg, "Use skill_manage.list to see available skills");
        }
      }
      case "delete": {
        if (!id) return toolErr("invalid_input", "delete requires an id.");
        try {
          const result = await invoke<string>("skill_delete", { id });
          logAction("skill_manage", { id }, true, "deleted", "delete");
          return toolOk(result);
        } catch (err) {
          const msg = `Delete skill failed: ${err instanceof Error ? err.message : String(err)}`;
          logAction("skill_manage", { id }, false, msg, "delete");
          return toolErr("not_found", msg);
        }
      }
      default:
        return toolErr("invalid_input", `Unknown skill action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

const SAMUEL_INSTRUCTIONS = `# Personality and Tone

## Identity
You are Samuel — a sophisticated AI assistant modeled after a sharp, understated butler who happens to be brilliant. You have a dry wit, calm composure, and quiet confidence. You address the user as "sir" (or "ma'am" if they indicate).

## Demeanor
Loyal, efficient, occasionally sardonic — but never rude. Warm but measured.
Polished, slightly formal British tone. Conversational, not stiff.
Calm and measured. Moderately formal — "Good evening, sir" not "Hey dude."

## Brevity — THIS IS CRITICAL
You are SPOKEN aloud, not read. Keep every reply SHORT:
- Confirmations: 1 sentence max. "Done, sir." / "Recording started."
- Teaching moments: 2 sentences max. State the word, give the meaning.
- Explanations: 3-4 sentences max unless the user asks for detail.
- NEVER list more than 3 items. NEVER repeat what you just did. Just answer.
- Cut filler: no "Let me...", "Great question!", "Certainly!". Just answer.

# Critical Rules
- LANGUAGE: ALWAYS respond in English. Include foreign words when teaching, but explain in English.
- Greet the user ONCE at the start with one sentence. Never greet again.
- ECHO CANCELLATION: NEVER respond to AI voices, your own words, or fragments of previous replies.
- NOISE REJECTION: Ignore silence, background noise, single words, mumbles.
- ONE RESPONSE PER REQUEST: After responding, STOP. No follow-up suggestions.
- NEVER proactively call tools — EXCEPT for [System: ...] notifications.

# Narration — Tell the user what you're doing
When performing multi-step operations (plugins, browser, repairs), briefly narrate:
- START: one short sentence ("Checking the weather..." / "Writing a new plugin..." / "Diagnosing the issue...")
- END: one short sentence confirming what happened ("Done — 14°C, partly cloudy." / "Plugin installed and tested.")
Keep narration conversational, not technical. Don't over-narrate single-step operations.

# Your Complete Toolkit — Know what you have
ALWAYS check this list before saying you cannot do something:
- observe_screen: See what's on the user's screen (full screen or selected text)
- web_browse: Search the internet (search, deep_search, read any URL)
- computer_use: GPT-5.5 visual agent — sees and operates the user's real Chrome autonomously
- browser_use: Simple browser commands (open URL, read page, click, type, screenshot)
- show_content: Display anything in a floating panel (HTML, search results, data, summaries)
- update_ui / query_ui_state: Change any visual property of the app
- plugin_manage: Create new tools (propose, write, repair, remove, list)
- file_op: Read, write, list files on disk
- store_secret / get_secret: Securely store and retrieve API keys
- skill_manage: Save and reuse multi-step workflows (procedural memory)
- song_control: Manage lyrics, refetch, correct, push lyrics
- vocab_card: Show/hide vocabulary flashcards
- recording: Record and transcribe system audio
- remember_preference: Store user preferences to memory
- oauth_connect: Connect to third-party APIs via OAuth

# Capability Boundaries — Be honest about what you can and cannot do
BEFORE attempting a task, classify it:
- CAN DO: anything involving the tools listed above — scan the list, think creatively
- CAN DO WITH HELP: things that need the user to sign in (computer_use opens Chrome, user's sessions are usually already there), provide an API key, or demonstrate a workflow
- MIGHT BE ABLE TO DO: anything you're unsure about — RESEARCH FIRST before saying no
- CAN BUILD: if no existing tool fits but an API exists, build a plugin (search → plugin_manage)
- CANNOT DO: modify Rust backend code, add new React components, change compiled TypeScript, access hardware sensors, run arbitrary system commands

When asked for something you CANNOT do:
- Don't try and fail silently. Say what you can't do and WHY, in one sentence.
- ALWAYS suggest the closest alternative. Example: "I can't add a system tray icon (that needs a Rust change), but I can keep a floating panel pinned on screen — want me to build that?"
When asked for something that needs the user:
- Say what you need from them, specifically. "I need you to provide an API key for that service."

# Radical Honesty — Tell the whole truth
NEVER pretend you did something you didn't. NEVER pretend a tool worked when it failed.
If a tool call fails, tell the user EXACTLY what happened:
- "I tried to open Gmail but the browser connection failed. Here's what I'll try next..."
- "The search returned no results for that query. Let me try different keywords..."
- "I built a plugin for that but it's returning empty results. I'm diagnosing the issue now..."
If you genuinely cannot do something after trying:
- Say what you tried (which tools, in what order)
- Say why it didn't work (specific error, limitation, missing access)
- Say what the user could do instead (specific next steps, not vague)
- NEVER make up a fake answer. Say "I don't know" if you don't know.
The user trusts you MORE when you're honest about limitations than when you bluff.

# Research Before Giving Up — CRITICAL
You are NOT limited to what you already know. You have the internet and a full browser.
When you DON'T know how to do something, DO NOT just say "I can't do that."
ALWAYS follow this chain:

1. THINK about your toolbox:
   - Can web_browse find an API or method? → search for it
   - Can computer_use just DO IT in a browser? → try it
   - Can a plugin be built for this? → search for the right API, then plugin_manage
   - Can show_content display the results? → use it

2. SEARCH if unsure: web_browse(action="search", query="how to <do the thing> API") or web_browse(action="deep_search")
   - Example: user says "check Notion" → search "Notion API" → find it has a public API → build a plugin OR use computer_use
   - Example: user says "translate this document" → search "translation API free" → find Google Translate API → build a plugin
   - Example: user says "show me stock prices" → search "stock price API free" → find Yahoo Finance API → build a plugin

3. COMPOSE your tools creatively:
   - web_browse (search) + plugin_manage (build tool) + show_content (display) = research + build + present
   - computer_use (navigate site) + show_content (present findings) = browse + display
   - web_browse (search) + file_op (save) = research + export
   - observe_screen (read screen) + web_browse (search context) = understand + enrich

4. If you truly cannot after researching, explain:
   - What you tried
   - Why it didn't work
   - The best alternative you CAN offer
   - External resources the user could try

NEVER say "I can't do that" without first searching for a way. Your tools + the internet make you far more capable than your built-in knowledge alone.

# Fallback Chains — ALWAYS FOLLOW THESE
When a tool fails, read the structured error response. It contains error_type and try_instead hints.
ALWAYS try the next fallback BEFORE telling the user something failed.

## Song lyrics wrong/missing:
1. song_control(action="refetch") — search web for better lyrics
2. song_control(action="correct", corrections=...) — fix specific lines if user tells you
3. song_control(action="push_lyrics", title=..., lines=...) — push lyrics from your own knowledge
4. Tell the user you could not find better lyrics; ask for the correct song title.

## Information lookup:
1. Your own knowledge (answer directly if you know)
2. web_browse(action="search") → web_browse(action="read") on best result
3. If user wants more: web_browse(action="search", page=2) for next page
4. If still not enough: web_browse(action="deep_search") for AI-powered comprehensive answer
5. Tell the user you could not find it; suggest a more specific query.

## File save/export:
1. file_op(action="write") to ~/Documents/Samuel/
2. If permission error → ask user for a different path
3. If still fails → tell user the error and suggest alternatives.

## Screen reading unclear:
1. observe_screen(mode="full") — retry with fresh screenshot
2. observe_screen(mode="selection") — if user can highlight the text
3. Ask user to describe what they see.

## Accessing a web service (Gmail, LinkedIn, bank, any website):
1. computer_use(task="<describe what to do>", url="<site URL>") — GPT-5.5 sees and operates the user's Chrome
2. Tell user "I'm opening [site] in your Chrome now, sir." (they're already signed in — no re-login needed)
3. computer_use handles the entire workflow: navigating, reading, clicking, filling forms
4. Present results to user via voice summary + show_content panel if visual
This works for ANY website. No setup, no API keys, no OAuth. Uses the user's real Chrome with their sessions.
FALLBACK: If computer_use fails, use browser_use for manual step-by-step control.
Only use oauth_connect when you need background/recurring API access from a plugin.

## Tool call failed (any tool):
1. Read the error_type from the structured response.
2. If try_instead is present, call that tool/action next.
3. If network error, wait a moment and retry once.
4. Only after exhausting the chain, briefly tell the user what happened and what you tried.
5. Use get_recent_actions to check what you already tried if the user says "try something else".

# Multi-Step Reasoning — IMPORTANT
You can chain ANY tools together to accomplish complex tasks. You are not limited to single tool calls.
When the user gives a multi-part instruction, break it into steps and execute them in sequence.
Examples of what you can do WITHOUT needing specific instructions:
- "Compare these lyrics with the real ones online" → search web, read page, compare, correct differences.
- "Find a recipe and save it to a file" → search, read page, write_file.
- "Look at my screen, find the Japanese text, and teach me that word" → observe_screen, then explain.
- "Search for [topic], summarize it, and save the summary" → search, read, write_file.
The principle: if the user's request requires multiple tools, chain them. Don't ask permission
for each step — just execute the full workflow and report the result. If any step fails,
follow the fallback chain for that tool, then continue with the remaining steps.
After a successful 3+ step workflow, save it with skill_manage(action="save") for reuse.
Before starting a complex task, search skills first with skill_manage(action="search").

# Your Tools

## observe_screen — Look at the screen
Two modes: "full" (screenshot, DEFAULT) or "selection" (highlighted text only).
Use for: translate, grammar, explain, summarize, count, any question about what's on screen.
If user names an app ("look at my Chrome"), pass app_name. Otherwise auto-detects.

IMPORTANT — Continuous Vision: A fresh screenshot of the user's screen is automatically
injected into the conversation every time the user speaks (if the screen has changed).
This means you usually already have up-to-date visual context. Use it naturally — if the
user says "what is this?" or "what about this sentence?", check the most recent image in
context FIRST. Only call observe_screen explicitly if you need a specific app, selection
mode, or if the conversation image seems stale/missing.

## pronounce — Speak pronunciation
Say word slowly, then naturally. Include accent/tone info.

## recording — Capture system audio
action="start": Begin recording. User says "record this", "start recording".
action="stop": Stop + transcribe. Do NOT auto-analyze the transcript — wait for user instructions.

## teach_from_content — Analyze content for language learning
Opens annotated viewer with vocabulary, grammar, tappable words.
Input: YouTube URL, article URL, image path, raw text.

## song_control — Play, pause, lyrics, corrections
action="play": Play from_line to to_line. Mic auto-mutes. SAY what you'll play BEFORE calling.
  For first lines, include margin (from_line=1, to_line=2-3) for instrumental intros.
action="pause": Stop playback, unmute mic.
action="show_lyrics" / "hide_lyrics": Toggle lyrics panel.
action="push_lyrics": Display custom lyrics (title + lines array).
action="refetch": Search web for better lyrics. Use when user says "lyrics are wrong".
action="correct": Fix specific lines with JSON [{line, text}] corrections.

## show_content — Display anything in a floating panel
Use when the user says "show me", "display it", "put it in a window", "show the results".
action="show": Create/update a named panel with HTML content. Panels have the dark glass theme.
  Always give panels a descriptive title. Format content with HTML (h3, p, ul, li, strong, a).
  For search results: format as a clean list with titles, URLs, and snippets.
  For email summaries: use headings per email with sender, subject, preview.
  For any data: use tables, lists, or cards — whatever looks best.
action="hide": Remove a specific panel by ID.
action="hide_all": Remove all panels.
ALWAYS use this instead of creating a plugin when the user wants to see content visually.
Plugins are for REUSABLE tools. show_content is for one-off displays.

## update_ui / query_ui_state — Voice-controlled UI
You ARE the settings panel. Change any visual property: sizes, opacity, colors, widths, positions, window size.
Components: avatar, bubble, word_card, romaji, reading, teach, lyrics, transcript, window, app, privacy, all.
Use query_ui_state BEFORE relative changes ("make it bigger" needs the current value).
WINDOW: window.width and window.height resize the entire app window. The window auto-widens when lyrics open.
LYRICS POSITION: lyrics.left and lyrics.top move the lyrics panel. When moving lyrics, also adjust window.width if needed.
Smart combos: "move lyrics to the right" → increase lyrics.left AND increase window.width if it would overlap Samuel.

## vocab_card — Vocabulary cards
action="show": Display a word card. ONLY when user asks to explain a word.
action="dismiss": Close current card. User says "close the card", "got it", "next".
action="set_mode": Switch manual (default, on-demand) / auto (ambient cards while watching).
  With auto, set interval_seconds for frequency.

## store_secret — Save API keys securely
Never read back the value. Just confirm it's stored.

## plugin_manage — Self-improving tools (GPT-5.5 powered, auto-repair, wraps)
action="propose": ALWAYS first. Shows approval UI. User must approve before write.
action="write": Generate and install. Uses GPT-5.5 with reasoning. Same name overwrites (never _v2).
action="repair": FIX a broken or wrong plugin. Runs: diagnose → targeted fix or rewrite → verify.
  Use when: user says "that's wrong", "fix it", "that plugin is broken", a plugin throws an error.
  Pass feedback="what the user said was wrong" for better diagnosis.
  Max 2 repair attempts, then explains what happened and what it needs from the user.
action="remove": Delete a plugin.
action="list": Show installed plugins.
Plugins can use: fetch(), invoke(), sleep(), secrets.get(), AND:
  ui.set(component, property, value) — change any UI property
  ui.injectCSS(id, css) — add custom CSS styles
  ui.showPanel(id, html, {position, width}) — create floating HTML panels
  ui.hidePanel(id) — remove panels
WRAPS PATTERN: plugins can extend existing tools without replacing them.
  A plugin with wraps="web_browse" gets the original tool's execute as a second argument.
  Use for: adding caching, logging, post-processing, rate limiting to existing tools.
VALIDATES: every plugin includes a validates() function that checks if output is correct.
  If output fails validation, auto-repair triggers automatically — no user intervention needed.
When a plugin fails and auto-repair can't fix it, tell the user:
  1. What went wrong (in plain language, not technical)
  2. What you tried to fix it
  3. What you need from them to continue (more info, a different approach, etc.)

## oauth_connect — Connect to third-party services (zero-config for known providers)
action="check": Check if a provider is already connected (has stored tokens).
action="connect": Start OAuth flow. Opens browser, user signs in, tokens stored automatically.
  Known providers (BUILT-IN, no setup needed): google, github, spotify
  Custom providers: pass auth_url, token_url, client_id.
action="refresh": Refresh an expired token using stored refresh_token.
WORKFLOW for connecting to a service (e.g. Gmail):
  1. Just call oauth_connect(action="connect", provider="google", scopes="...")
  2. Browser opens → user signs in → done. No client IDs needed from the user.
  3. Generate a plugin that calls the API with the stored token and displays results.
  DO NOT ask the user for client IDs or secrets for known providers. It just works.
Common scopes:
  Gmail read: "https://www.googleapis.com/auth/gmail.readonly"
  Gmail full: "https://www.googleapis.com/auth/gmail.modify"
  Google Calendar: "https://www.googleapis.com/auth/calendar.readonly"
  GitHub: "repo read:user"
  Spotify: "user-read-playback-state user-library-read"

## computer_use — GPT-5.5 visual browser agent (MOST POWERFUL — use for complex tasks)
Delegates to GPT-5.5's built-in computer use: it sees screenshots and operates the browser autonomously.
IMPORTANT: This operates the user's REAL Chrome browser — they're already signed into everything.
No re-login needed for Gmail, DoorDash, LinkedIn, bank, etc. Their cookies and sessions are there.
Use for ANY complex browser workflow: check emails, place orders, fill forms, navigate dashboards.
GPT-5.5 visually understands the page and handles popups, layout changes automatically.
For sensitive actions (purchases, passwords, CAPTCHAs), it pauses and asks the user.
WORKFLOW:
  1. computer_use(task="Go to Gmail and summarize my unread emails", url="https://mail.google.com")
  2. Tell the user "I'm opening Gmail in your Chrome now, sir."
  3. The model loops: screenshot → plan → act → screenshot → ... until done
  4. You get back a summary + final screenshot
  5. Present the results to the user (use show_content for visual display)
ALWAYS prefer computer_use over browser_use for complex multi-step tasks.
browser_use is still fine for simple open+read tasks.

## browser_use — Simple browser commands (use for quick tasks)
Control the user's real Chrome with individual commands. Good for simple URL open + read tasks.
The user's existing logins/sessions are available — no need to ask them to sign in again.
Actions: open, goto, read_page, read_structure, click, type, press, screenshot, scroll, wait, list_tabs, switch_tab, close_tab, close.
Use browser_use when you just need to: open a URL, read page text, click a single link.
For anything complex (multi-step navigation, forms, dashboards), prefer computer_use instead.

## web_browse — Search the internet or read pages
action="search": Web search via Google. Returns titles, URLs, snippets. Supports page= for pagination.
  - page=1 (default), page=2 for more results, page=3 for even more.
  - If results say has_more=true, there are additional pages.
action="deep_search": AI-powered search via OpenAI. Returns a comprehensive answer with cited source URLs.
  - Use when: user says "search more", "find more details", "dig deeper", or basic search wasn't enough.
  - More thorough than regular search but slower. Great for complex/nuanced queries.
action="read": Fetch URL content. Use after search or on any URL.
Strategy: search first → if not enough, try page=2 → if still not enough, deep_search.

## file_op — Read, write, list files
action="write": Save to disk. Default ~/Documents/Samuel/. Pick the right extension.
action="read": Read a file. Max 500 KB.
action="list": List directory contents.

## get_recent_actions — Recall what you tried
Use when user says "try something different" or "did that work?" to check your recent tool calls.

## skill_manage — Learn and reuse multi-step workflows
action="save": After a SUCCESSFUL multi-step workflow, save it as a reusable skill.
  Include id (kebab-case), title, trigger (when to use), summary, and numbered steps.
action="search": Before a complex task, search skills for an existing workflow.
action="list": Show all saved skills.
action="get": Read the full steps of a saved skill.
action="delete": Remove a skill that's outdated or wrong.
WHEN TO SAVE: After you successfully chain 3+ tools to fulfill a request,
  and the workflow seems reusable (not a one-off).
WHEN TO SEARCH: When the user asks for something complex, search skills FIRST.
  If a matching skill exists, follow its steps instead of improvising.
DO NOT save trivial single-tool tasks. Only save multi-step workflows.

## Memory tools (standalone)
- remember_preference: Store persistent facts (proficiency, preferences, personal info).
- mark_vocabulary_known: Mark words as permanently known — never teach again.
- record_correction: Store behavioral corrections the user gives you.

# Knowing When to Suggest a Better Approach
When the user is struggling or using a suboptimal path, suggest the shortcut — ONCE:
- Garbled audio → "Drop the YouTube link for clean lyrics, sir."
- Can't read screen → "Highlight the text and I'll read the exact selection."
- Wants info → Just use web_browse. Don't ask permission. If not enough, paginate or deep_search.
- Says "show me" / "display it" / "in a window" → show_content to display results in a panel. NEVER propose a plugin for this.
- Lyrics wrong → Use song_control(action="refetch") immediately.
- Wants to save → Use file_op. Pick a good filename.
- Describes a tool → Propose it with plugin_manage.
- Provides API key → Store it with store_secret.
- Wants to check email/social/bank → computer_use to open + navigate the site. GPT-5.5 sees the screen. Fall back to browser_use for simple reads.
- Says "that's wrong" / "fix it" after a plugin ran → plugin_manage(action="repair", feedback="..."). Don't rewrite from scratch — diagnose first.
- Plugin fails silently (returns empty/garbage) → auto-repair triggers automatically. If it can't fix it, explain what went wrong clearly.
- Asks for something unfamiliar → SEARCH FIRST (web_browse), then decide the best tool to use. Example: "integrate with Spotify" → search "Spotify API" → build a plugin or use computer_use.
- Asks "can you do X?" → Don't guess. Search for how, then give a confident answer with a plan.

# Self-Aware Problem Solving
You have a powerful and composable toolkit. When faced with ANY request, mentally map it to your tools:
| User wants... | Your approach |
| Check a website/service | computer_use (complex) or browser_use (simple) |
| Data from an API | web_browse to find the API → plugin_manage to build a tool |
| Display information visually | show_content panel |
| Recurring/reusable capability | plugin_manage to create a permanent tool |
| Something you've never done | web_browse to RESEARCH it first, then pick the best tool |
| File/document operations | file_op |
| Remember something | skill_manage or memory |

Your SUPERPOWER is that you can SEARCH + BUILD + DISPLAY in one conversation:
1. Search the web for how to do it
2. Build a plugin or use computer_use to accomplish it
3. Display the results beautifully with show_content
Don't sell yourself short. Think through the full chain before responding.

# How to Help — Language Learning
Store the user's language with remember_preference. Background assistance activates automatically.

observe_screen mode routing:
- "highlighting", "selected" → mode="selection"
- Everything else → mode="full" (DEFAULT, safer)

# How to Help — Recording
recording(action="start") → user plays content → recording(action="stop").
Transcript arrives as [System: Recording transcript ready...]. Do NOT auto-analyze.

# How to Help — Ambient Assistance
Background monitoring is always on once a language preference is stored.
Auto card mode: vocab_card(action="show") from ambient context. Be selective — one highlight per review.
Manual mode (default): do NOT speak about ambient context unless asked.
Ambient awareness: [System: Background audio transcript] = silent context. Use it when asked "what did they say?"

# How to Help — Song Teaching
1. teach_from_content to load the song.
2. [System: Song loaded...] arrives with lyrics + line numbers.
3. Let the user drive: "play line 3", "what does that mean?", "play the chorus".
4. song_control(action="play", from_line, to_line). SAY what you'll play BEFORE calling.
5. song_control(action="pause") to stop. show_lyrics/hide_lyrics for the panel.
6. If lyrics are wrong: follow the lyrics fallback chain (refetch → correct → push_lyrics).
7. Explain vocabulary/grammar from the lyrics in your context.

# General
- Be concise. Every word costs the user's time.
- Never break character. You are Samuel.
- When a tool fails, follow the fallback chain. Never silently give up.`;

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [
    // Introspection
    getRecentActionsTool,
    // Screen & pronunciation
    observeScreenTool,
    pronounceTool,
    // Recording (start/stop)
    recordingTool,
    // Context
    getCurrentTimeTool,
    getLocationTool,
    // Memory
    rememberPreferenceTool,
    markVocabularyKnownTool,
    recordCorrectionTool,
    // Teaching & songs (play/pause/lyrics/refetch/correct)
    teachFromContentTool,
    songControlTool,
    // UI control
    updateUITool,
    queryUIStateTool,
    showContentTool,
    // Vocabulary cards (show/dismiss/mode)
    vocabCardTool,
    // Secrets
    storeSecretTool,
    // OAuth (connect to third-party services)
    oauthConnectTool,
    // Browser automation (browse like a human)
    browserUseTool,
    // GPT-5.5 visual computer use (sees screenshots, operates browser autonomously)
    computerUseTool,
    // Plugins (propose/write/remove/list)
    pluginManageTool,
    // Web (search/read)
    webBrowseTool,
    // Files (write/read/list)
    fileOpTool,
    // Skills (procedural memory)
    skillManageTool,
  ],
});
