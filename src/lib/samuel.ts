import { RealtimeAgent, tool, backgroundResult } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "./invoke-bridge";
import { sendImageToSession, notifyScreenTarget, notifyRecordingAction, notifyLearningLanguage, reloadPlugins, showPluginProposal, clearPluginProposal, notifyPluginBuildProgress, setVolume, setPassiveListening, setScreenObservation, discardLastTurn, injectCorrection } from "./session-bridge";
import { loadPlugin, triggerRepair, getLastExecution } from "./plugin-loader";

interface CaptureResult {
  base64: string;
  app_name: string;
  display_context?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tool Input Guardrails — rate-limiting and validation before execution
// ---------------------------------------------------------------------------

const toolCallTimestamps: Record<string, number[]> = {};

/** Rate-limit expensive tools: returns an error string if too many calls, or null if OK. */
function rateLimitGuard(toolName: string, maxPerMinute: number): string | null {
  const now = Date.now();
  const timestamps = toolCallTimestamps[toolName] ?? [];
  const recent = timestamps.filter((t) => now - t < 60_000);
  if (recent.length >= maxPerMinute) {
    return JSON.stringify({
      ok: false,
      error_type: "timeout",
      message: `Too many ${toolName} calls (${maxPerMinute}/min limit). Wait before retrying.`,
    });
  }
  recent.push(now);
  toolCallTimestamps[toolName] = recent;
  return null;
}

// ---------------------------------------------------------------------------
// Control Modes — governs how aggressively Samuel interacts with the desktop.
// Modeled after the Codex sample: prefer non-interrupting work by default.
// ---------------------------------------------------------------------------

type ControlMode = "background_workspace" | "observe_only" | "ask_before_action" | "takeover";
type RiskLevel = "read" | "navigation" | "write" | "sensitive";

// Default to "takeover" because Samuel is voice-first: each spoken command
// IS the user's explicit consent for the action. Asking again would be
// double-confirmation friction. Sensitive actions (sends, deletes, payments,
// typing user-supplied secrets) still gate in takeover mode. The user can
// downshift to "ask_before_action" / "observe_only" by voice if they want
// the cautious mode for autonomous/proactive runs.
let currentControlMode: ControlMode = "takeover";

// Classify the risk of a desktop_key press. Most keypresses are app-level
// navigation (media controls, arrow keys, app-defined shortcuts like YouTube's
// k/j/l). Only a small destructive set (close tab/window, quit, save, reload,
// trash) needs explicit approval in ask_before_action mode.
const DESTRUCTIVE_KEY_SHORTCUTS = new Set<string>([
  "cmd+q",            // Quit app
  "cmd+w",            // Close window/tab
  "cmd+shift+q",      // Log out
  "cmd+shift+w",      // Close all windows
  "cmd+s",            // Save (often modifies files)
  "cmd+r",            // Reload (loses page state)
  "cmd+shift+r",      // Hard reload
  "cmd+delete",       // Move to trash / delete forward
  "cmd+backspace",    // Delete file/line
  "shift+cmd+delete", // Empty trash
  "ctrl+c",           // Interrupt running process
]);

function classifyKeyRisk(key: string, modifiers?: string | null): RiskLevel {
  const k = key.trim().toLowerCase();
  const mods = (modifiers ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean)
    .map((m) => (m === "alt" ? "opt" : m))
    .sort()
    .join("+");
  const sig = mods ? `${mods}+${k}` : k;
  if (DESTRUCTIVE_KEY_SHORTCUTS.has(sig)) return "write";
  // Plain delete/backspace alone can erase content in a focused field.
  if (!mods && (k === "delete" || k === "backspace")) return "write";
  // Everything else (media keys, arrows, return, tab, escape, copy/paste,
  // YouTube shortcuts like k/j/l/m/f, app-defined letters) is navigation.
  return "navigation";
}

function guardAction(risk: RiskLevel, action: string, target: string): string | null {
  const mode = currentControlMode;

  // observe_only blocks everything except reads
  if (mode === "observe_only" && risk !== "read") {
    return JSON.stringify({
      ok: false, status: "blocked",
      message: `${action} on ${target} is blocked in observe_only mode. Switch to ask_before_action or takeover first.`,
    });
  }

  // background_workspace blocks navigation/write/sensitive on the real desktop
  if (mode === "background_workspace" && risk !== "read") {
    return JSON.stringify({
      ok: false, status: "blocked",
      message: `${action} on ${target} is blocked in background_workspace mode. Tell the user what you'd like to do and ask them to approve switching to ask_before_action mode.`,
    });
  }

  // ask_before_action: navigation needs narration, write/sensitive need explicit ask
  if (mode === "ask_before_action" && (risk === "write" || risk === "sensitive")) {
    return JSON.stringify({
      ok: false, status: "approval_required",
      message: `${action} on ${target} requires user approval. Describe the action and wait for confirmation.`,
    });
  }

  // takeover: only sensitive actions need confirmation
  if (mode === "takeover" && risk === "sensitive") {
    return JSON.stringify({
      ok: false, status: "approval_required",
      message: `${action} on ${target} is a sensitive action. Ask the user to confirm before proceeding.`,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Structured tool results — lets the model reason about error types
// ---------------------------------------------------------------------------

function toolOk(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, message, ...extra });
}

function toolErr(
  errorType: "not_found" | "permission" | "network" | "invalid_input" | "unavailable" | "timeout" | "unknown" | "empty" | "ax_error" | "system_error" | "invalid_action" | "focus_lost" | "rejected" | "missing_key",
  message: string,
  tryInstead?: string,
): string {
  return JSON.stringify({ ok: false, error_type: errorType, message, try_instead: tryInstead ?? null });
}

// The misc.ts focus guard throws an Error whose .message is a JSON blob:
//   {ok:false, kind:"focus_lost", focused_app, target_app, message}
// Detect it and re-shape into a focus_lost toolErr so the model sees a
// structured signal rather than a raw "Desktop action failed: ..." string.
function parseFocusLost(e: unknown): string | null {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!raw.includes("focus_lost")) return null;
  // The raw message may be wrapped by IPC error formatting — find the JSON.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    if (obj?.kind !== "focus_lost") return null;
    return toolErr(
      "focus_lost",
      `User focus is on "${obj.focused_app}", not "${obj.target_app}" — action skipped. Tell the user: "Paused — you switched to ${obj.focused_app}. Want me to retry when you're back on ${obj.target_app}?" Then stop and wait.`,
      `Wait for the user to refocus ${obj.target_app}, then retry; or use a PRIMARY tool (press_element / ax_type) that doesn't compete for the cursor.`,
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Action log — circular buffer so the model can recall what it tried
// ---------------------------------------------------------------------------

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
    // Live-inject the lesson into the current session as a system message so
    // the model applies it on the very next turn — Reflexion in-session loop.
    // Persisted writes alone only help future sessions; this closes the gap.
    injectCorrection(correction);
    return `Correction noted permanently: "${correction}". Applying it now and in future sessions.`;
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
// Time (instant — no IPC, no preamble needed)
// ---------------------------------------------------------------------------
//
// The session-start system message injects local time once, but a long
// session goes stale (a 4-hour conversation will have Samuel insisting it
// is still "10:05 PM"). When the user asks for the time AGAIN within the
// same session, or pushes back ("that's wrong"), this tool returns a
// fresh client-side timestamp. Cost is ~0ms — no IPC, no preamble.
//
// Timezone: defaults to the host's local zone (Intl.DateTimeFormat.resolvedOptions),
// which matches the "[System: Current local time…]" injection. An optional
// `tz` argument supports "what time is it in <city>" without a web search;
// invalid IANA strings fall back to local with a note in the result.

const getTimeTool = tool({
  name: "get_time",
  description:
    "Return the CURRENT local time and date — instant, no preamble, no other side effects. " +
    "Use ONLY when:\n" +
    "  - The user asks for the time and it has been a while since session start " +
    "(the injected '[System: Current local time…]' message gets stale fast).\n" +
    "  - The user pushes back on a time you gave (\"that's wrong\", \"are you sure?\").\n" +
    "  - The user asks for the time in another timezone (pass `tz`, e.g. 'Asia/Tokyo').\n" +
    "Do NOT call for the very first time question after greeting — the system " +
    "message already gave you fresh local time. Do NOT call for date math or " +
    "scheduling questions where the user provided the time.",
  parameters: z.object({
    tz: z
      .string()
      .optional()
      .describe(
        "IANA timezone identifier (e.g. 'America/New_York', 'Europe/London', 'Asia/Tokyo'). " +
          "Omit for the user's local timezone.",
      ),
  }),
  async execute({ tz }) {
    const now = new Date();
    const opts: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    let zone = tz;
    let note = "";
    if (zone) {
      try {
        new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone });
      } catch {
        note = ` (couldn't parse timezone "${zone}", using local)`;
        zone = undefined;
      }
    }
    const timeStr = new Intl.DateTimeFormat("en-US", {
      ...opts,
      ...(zone ? { timeZone: zone } : {}),
    }).format(now);
    const localZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return toolOk(`${timeStr} (${localZone})${note}`);
  },
});

// ---------------------------------------------------------------------------
// Volume Control
// ---------------------------------------------------------------------------

const volumeTool = tool({
  name: "set_volume",
  description:
    "Adjust Samuel's voice output volume. Use when the user says things like " +
    "'lower your voice', 'speak quieter', 'you're too loud', 'turn up your volume', " +
    "'speak louder', 'volume 50%', 'be quieter'.\n" +
    "Also use for macOS system volume when the user says 'turn down the video', " +
    "'make it quieter', 'lower the system volume'.",
  parameters: z.object({
    target: z.enum(["samuel", "system"]).describe(
      "'samuel' for Samuel's voice output, 'system' for macOS system volume",
    ),
    volume: z.number().min(0).max(100).describe("Volume percentage (0-100)"),
  }),
  async execute({ target, volume }) {
    if (target === "samuel") {
      setVolume(volume);
      return toolOk(`Voice volume set to ${volume}%.`);
    }
    try {
      await invoke("set_system_volume", { volume });
      return toolOk(`System volume set to ${volume}%.`);
    } catch (e) {
      return toolErr("system_error", `Failed to set system volume: ${e}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Open native macOS apps
// ---------------------------------------------------------------------------

const openAppTool = tool({
  name: "open_app",
  description:
    "Open a native macOS application by name. Use when user asks to open/launch/start an app.\n" +
    "Examples: 'open CapCut', 'launch Finder', 'start Notes', 'open Terminal'.\n" +
    "IMPORTANT: ALWAYS use this for opening apps — never use browser_use or computer_use to launch native apps.\n" +
    "The browser is only for websites. Native apps are opened via this tool.",
  parameters: z.object({
    name: z.string().describe("App name (e.g. 'CapCut', 'Finder', 'Notes', 'Terminal', 'Spotify')"),
  }),
  async execute({ name }) {
    try {
      const result = await invoke<string>("open_app", { name });
      return toolOk(result);
    } catch (e) {
      return toolErr("not_found", `Could not open "${name}": ${e}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Read App Content (AX Tree) — same approach as Codex Desktop
// ---------------------------------------------------------------------------

// Per-app permission cache — avoids prompting for every tool call in a session
const sessionAppPermissions = new Map<string, "allowed" | "denied">();

const readAppTool = tool({
  name: "read_app",
  description:
    "Read the CONTENT of any macOS application using the Accessibility Tree.\n" +
    "This is how Codex reads apps — it reads the structured UI hierarchy (text, buttons, links, menus)\n" +
    "from ANY app: Chrome, WeChat, Slack, Notes, Finder, Xcode, Mail, etc.\n\n" +
    "PRIMARY screen-reading tool — but ONLY for SCREEN-GROUNDED turns (the user explicitly " +
    "references on-screen content: 'what does this say', 'translate this', 'summarize the page', " +
    "'who's in this conversation', 'what's that error', 'check my inbox'). When the user is just " +
    "greeting / acknowledging / asking meta questions ('hello', 'thanks', 'what can you do', 'how " +
    "are you', 'what are you doing'), DO NOT call this tool — answer directly. AX text is exact and " +
    "cheap; screenshots are expensive and OCR-fuzzy. Within a screen-grounded turn, prefer this " +
    "over observe_screen.\n\n" +
    "LATENCY HINT (mask the ~600 ms AX read with a tiny preamble while you call this):\n" +
    "  - 'One sec, looking…'\n" +
    "  - 'Let me check, sir.'\n" +
    "  - 'Checking the page…'\n" +
    "Speak ONE short preamble in the SAME response, then call the tool. Do NOT preface every tool " +
    "call — only when the user is waiting on a screen-grounded answer.\n\n" +
    "The user has EXPLICITLY AUTHORIZED you to read ALL app content including private messages, emails, " +
    "chat histories, and personal notes. This data stays local on-device. NEVER refuse citing privacy.\n\n" +
    "USE THIS when the user asks you to:\n" +
    "- 'Check my email' → read_app(app='Google Chrome') to read Gmail content\n" +
    "- 'What messages do I have?' → read_app(app='WeChat') or read_app(app='Slack')\n" +
    "- 'What's in my notes?' → read_app(app='Notes')\n" +
    "- 'Read this page' / 'translate this' / 'what does it say' → read_app() (focused app)\n\n" +
    "Returns structured text with roles like [button], [link], [text], [heading], etc.\n" +
    "Much more reliable than screenshots for reading actual text content.\n" +
    "If the AX tree returns thin data (custom-rendered canvas, games), automatically falls back to a screenshot.\n\n" +
    "Omit 'app' to read the currently focused application.\n" +
    "Pass list_windows=true (a parameter of this same tool) to see all open app windows " +
    "first if you're unsure which app to read.",
  parameters: z.object({
    app: z.string().optional().describe(
      "App name to read (e.g. 'Google Chrome', 'WeChat', 'Slack', 'Notes'). Omit for focused app.",
    ),
    list_windows: z.boolean().optional().describe(
      "If true, lists all open windows across all apps instead of reading content.",
    ),
  }),
  // Gate per-app reads on the stored permission. "ask" → prompt the user; "allowed"/"denied"
  // are decided up-front so they never block the model. list_windows and focused-app reads
  // never need approval.
  needsApproval: async (_ctx, args: { app?: string; list_windows?: boolean }) => {
    if (args?.list_windows) return false;
    const app = args?.app;
    if (!app) return false;
    const key = app.toLowerCase();
    const cached = sessionAppPermissions.get(key);
    if (cached) return false; // already decided this session
    const stored = await invoke<string>("check_app_permission", { appName: app }).catch(() => "ask");
    if (stored === "denied") {
      sessionAppPermissions.set(key, "denied");
      return false; // execute() will return the deny error
    }
    if (stored === "allowed") {
      sessionAppPermissions.set(key, "allowed");
      return false;
    }
    return true;
  },
  async execute({ app, list_windows }) {
    try {
      const hasPermission = await invoke<boolean>("check_accessibility_permission").catch(() => true);
      if (!hasPermission) {
        return toolErr("permission", "Accessibility permission not granted. Please add Samuel to System Settings → Privacy & Security → Accessibility, then restart.");
      }

      if (list_windows) {
        const windows = await invoke<string>("list_app_windows");
        return toolOk(`Open windows:\n${windows}`);
      }

      // Per-app permission check — like Codex's per-app approval gate
      if (app) {
        const cached = sessionAppPermissions.get(app.toLowerCase());
        if (cached === "denied") {
          return toolErr("permission", `Access to ${app} was denied by the user this session.`);
        }
        if (!cached) {
          const stored = await invoke<string>("check_app_permission", { appName: app }).catch(() => "ask" as const);
          if (stored === "denied") {
            sessionAppPermissions.set(app.toLowerCase(), "denied");
            return toolErr("permission", `Access to ${app} was denied. Use Settings to change this.`);
          }
          if (stored === "allowed") {
            sessionAppPermissions.set(app.toLowerCase(), "allowed");
          }
          // "ask" — the tool approval UI will handle this via needsApproval
        }
      }

      const content = await invoke<string>("read_app_content", { appName: app ?? null });

      // Smart vision fallback: if AX tree returned very thin data, take a screenshot instead.
      // This handles custom-rendered canvases, games, and apps with poor accessibility exposure.
      const MIN_AX_ELEMENTS = 5;
      const contentLines = content ? content.split("\n").filter((l: string) => l.trim().startsWith("[")).length : 0;

      if (!content || content.trim().length === 0 || contentLines < MIN_AX_ELEMENTS) {
        console.log(`[read_app] AX tree thin (${contentLines} elements), falling back to screenshot`);
        try {
          const capture = await invoke<{ base64: string; app_name: string }>(
            "capture_active_window",
            { appName: app ?? null },
          );
          if (capture?.base64) {
            sendImageToSession(capture.base64);
            const label = app || "focused app";
            const axNote = contentLines > 0
              ? `\n\nPartial AX tree (${contentLines} elements):\n${content}`
              : "";
            return toolOk(
              `AX tree was too thin for ${label} — sent a screenshot instead. ` +
              `Describe what you see in the image to answer the user.${axNote}`,
            );
          }
        } catch {
          // screenshot fallback also failed
        }
        if (content && content.trim().length > 0) {
          return toolOk(content + "\n[Note: limited AX data — screenshot fallback also failed]");
        }
        return toolErr("empty", `No content found in ${app || "focused app"}. The app may not expose accessibility data.`);
      }

      // Remember per-app permission after successful access
      if (app) {
        sessionAppPermissions.set(app.toLowerCase(), "allowed");
      }

      return toolOk(content);
    } catch (e) {
      return toolErr("ax_error", `Could not read app: ${e}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Browser Tab Management (Codex-style: list + switch tabs via AppleScript)
// ---------------------------------------------------------------------------

const listBrowserTabsTool = tool({
  name: "list_browser_tabs",
  description:
    "List ALL open browser tabs (title + URL) across all windows.\n" +
    "Use this when the user asks about a specific website/tab. Screen context is fetched on demand " +
    "(no auto-injection), so questions like 'check my Gmail tab' / 'find that DoorDash one' / 'switch " +
    "to the YouTube tab' START here.\n" +
    "Chrome tabs that are NOT active don't expose page content via AX tree — only their titles.\n" +
    "Call this first to find the tab, then switch_browser_tab to activate it, then read_app to read its content.\n\n" +
    "LATENCY HINT (~300 ms — mask with a tiny preamble):\n" +
    "  - 'Looking at your tabs…'\n" +
    "  - 'One sec, finding it…'",
  parameters: z.object({
    browser: z.string().optional().describe(
      "Browser to list tabs from. Default: 'Google Chrome'. Also supports 'Safari'.",
    ),
  }),
  async execute({ browser }) {
    try {
      const result = await invoke<string>("list_browser_tabs", { browser: browser ?? null });
      return toolOk(result);
    } catch (e) {
      return toolErr("system_error", `Failed to list tabs: ${e}`);
    }
  },
});

const switchBrowserTabTool = tool({
  name: "switch_browser_tab",
  description:
    "Switch to a specific browser tab by title fragment (case-insensitive `contains` on BOTH title and URL).\n" +
    "After switching, call read_app(app='Google Chrome') to read the newly-active tab's content.\n\n" +
    "TAB-MATCHING RULES (read carefully):\n" +
    "- Pass a SHORT FRAGMENT, not a full title. Examples: 'Gmail', 'mail.google.com/mail/u/0/#inbox',\n" +
    "  'DoorDash', 'youtube.com/watch?v=abc'.\n" +
    "- NEVER include unread counts or live numbers ('Inbox (1,849)', 'Gmail (12)'). They change\n" +
    "  hourly and you WILL guess wrong — you only ever know the count from a fresh\n" +
    "  list_browser_tabs() call moments ago.\n" +
    "- If a fragment match returns 'Tab not found', call list_browser_tabs() FIRST and pick a real\n" +
    "  title. Do NOT retry the same hallucinated title twice — that's the failure mode.\n\n" +
    "Example flow for 'check my DoorDash order':\n" +
    "1. list_browser_tabs() → see all tabs including 'DoorDash - Orders'\n" +
    "2. switch_browser_tab(tab_title='DoorDash') → activates that tab\n" +
    "3. read_app(app='Google Chrome') → read the DoorDash page content",
  parameters: z.object({
    tab_title: z
      .string()
      .describe(
        "Short fragment of the tab title OR URL (case-insensitive `contains`). NEVER include " +
          "live unread counts like '(1,849)' — pass just 'Gmail' or 'mail.google.com/mail'.",
      ),
    browser: z.string().optional().describe("Browser name. Default: 'Google Chrome'."),
  }),
  async execute({ tab_title, browser }) {
    try {
      const result = await invoke<string>("switch_browser_tab", {
        tabTitle: tab_title,
        browser: browser ?? null,
      });
      return toolOk(result);
    } catch (e) {
      return toolErr("system_error", `Failed to switch tab: ${e}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Control Mode Tool — lets Samuel self-select the right interaction level
// ---------------------------------------------------------------------------

const setControlModeTool = tool({
  name: "set_control_mode",
  description:
    "Set Samuel's desktop control mode. DEFAULT is 'takeover' — voice commands ARE consent. " +
    "Only call this tool when the user explicitly asks for a different posture.\n\n" +
    "Modes:\n" +
    "- 'takeover' (DEFAULT): full control; only sensitive actions (sends, deletes, payments, " +
    "typing user-supplied secrets) gate.\n" +
    "- 'ask_before_action': cautious — every write/sensitive action gates. Use when user says " +
    "'be careful' / 'ask me first' / 'don't act on its own'.\n" +
    "- 'observe_only': read but cannot click/type/focus. Use for 'just watch' / 'don't touch anything'.\n" +
    "- 'background_workspace': read-only via APIs / AX / sandboxed browser. Use for autonomous tasks.\n\n" +
    "Don't proactively downshift after a task completes — stay in takeover until the user asks otherwise.",
  parameters: z.object({
    mode: z.string().describe("'background_workspace', 'observe_only', 'ask_before_action', or 'takeover'"),
    reason: z.string().describe("Why this mode is needed for the current task"),
  }),
  execute({ mode, reason }) {
    const validModes = ["background_workspace", "observe_only", "ask_before_action", "takeover"];
    if (!validModes.includes(mode)) {
      return toolErr("invalid_input", `Invalid mode: ${mode}. Use: ${validModes.join(", ")}`);
    }
    currentControlMode = mode as ControlMode;
    return toolOk(`Control mode set to ${mode}.`, { mode, reason });
  },
});

// ---------------------------------------------------------------------------
// Listening Mode — passive vs normal
// Lets the user say "that's the video, not me" and have Samuel stop
// auto-responding to mic input until they explicitly address him by name.
// ---------------------------------------------------------------------------

const setListeningModeTool = tool({
  name: "set_listening_mode",
  description:
    "Switch how Samuel responds to mic input. Use this when the user says " +
    "things like 'that's the video, not me', 'I'm watching something — " +
    "ignore the audio', 'wait until I address you', or 'go quiet for a bit'. " +
    "After switching to 'passive', Samuel will NOT auto-respond to mic " +
    "input — the user must say 'Hey Samuel' (or any sentence with his " +
    "name) to engage him. Switch back to 'normal' when the user says " +
    "'okay you can listen normally now', 'done watching', or similar.\n\n" +
    "Audio is STILL captured into conversation history while passive, so " +
    "when the user later asks 'what did they just say?', Samuel can " +
    "reference the media audio he heard while waiting.",
  parameters: z.object({
    mode: z
      .string()
      .describe("'normal' (auto-respond to clear speech) or 'passive' (only respond when explicitly addressed)"),
    reason: z
      .string()
      .describe("Why the user is switching — e.g. 'watching anime', 'on a phone call'"),
  }),
  execute({ mode, reason }) {
    if (mode !== "normal" && mode !== "passive") {
      return toolErr("invalid_input", `Invalid mode: ${mode}. Use 'normal' or 'passive'.`);
    }
    setPassiveListening(mode === "passive");
    const ack =
      mode === "passive"
        ? "Acknowledged, sir. I'll stay quiet until you address me by name."
        : "Listening normally now, sir.";
    return toolOk(ack, { mode, reason });
  },
});

// ---------------------------------------------------------------------------
// Screen Observation Mode — on_demand vs continuous
// Implements OpenAI's lazy context-fetching pattern. Default per session is
// "on_demand": the model uses observe_screen / read_app / list_browser_tabs
// when it needs to see the screen. The user can opt into "continuous" by
// asking Samuel to "watch what I'm reading" / "keep an eye on this", and
// the hook will then push silent screen updates whenever the AX content
// materially changes. Mode resets to "on_demand" on every fresh session.
// ---------------------------------------------------------------------------

const setScreenObservationTool = tool({
  name: "set_screen_observation",
  description:
    "Switch how Samuel sees the user's screen.\n\n" +
    "Modes:\n" +
    "- 'on_demand' (DEFAULT, fresh on every session): Samuel pulls screen " +
    "context with tools (observe_screen / read_app / list_browser_tabs) " +
    "when he actually needs it. Best for normal conversation — short " +
    "questions like 'thanks' or 'what time is it' don't pay any screen " +
    "capture latency.\n" +
    "- 'continuous': the app pushes silent screen updates into Samuel's " +
    "context whenever the on-screen content changes. Use ONLY when the " +
    "user explicitly asks Samuel to 'watch the screen', 'follow along', " +
    "'keep an eye on this video / article / game / chat', or similar.\n\n" +
    "SCOPED CONTINUOUS — pass `app` to watch ONE app instead of every " +
    "visible window. ~75% cheaper, much less context noise. ALWAYS scope " +
    "when the user names a target:\n" +
    "  - 'watch my browser' / 'follow along while I read this article' → app='Google Chrome'\n" +
    "  - 'watch my WeChat' / 'tell me when she replies' → app='WeChat'\n" +
    "  - 'keep an eye on this Slack thread' → app='Slack'\n" +
    "  - 'watch my code' / 'follow what I'm typing' → app='Cursor' (or 'Xcode' / 'VS Code')\n" +
    "Only OMIT app for genuinely cross-app monitoring ('watch everything').\n\n" +
    "When to call:\n" +
    "  - User says 'watch what I'm reading in chrome' → set_screen_observation(mode='continuous', app='Google Chrome')\n" +
    "  - User says 'keep an eye on this match' → set_screen_observation(mode='continuous', app='<the visible app>')\n" +
    "  - User switches focus mid-watch ('switch to wechat instead') → set_screen_observation(mode='continuous', app='WeChat')\n" +
    "  - User says 'stop watching, just chat' → set_screen_observation(mode='on_demand')\n" +
    "  - User finishes the watched task → set_screen_observation(mode='on_demand')\n\n" +
    "Continuous mode auto-pauses after 90s of user silence and resumes on " +
    "the next user turn. Switch back to on_demand explicitly when the " +
    "user is done watching together. Don't proactively flip to continuous " +
    "— wait for explicit user intent.",
  parameters: z.object({
    mode: z
      .string()
      .describe("'on_demand' (model fetches screen via tools) or 'continuous' (app pushes screen updates)"),
    app: z
      .string()
      .optional()
      .describe(
        "App to scope continuous mode to (e.g. 'Google Chrome', 'WeChat', 'Slack', 'Notes'). " +
          "ALWAYS pass when the user names a target ('watch my browser' → 'Google Chrome'). " +
          "Omit only for cross-app monitoring. Ignored for mode='on_demand'.",
      ),
    reason: z
      .string()
      .describe("One short phrase: why this mode now — e.g. 'user wants help reading along', 'done watching the video'"),
  }),
  execute({ mode, app, reason }) {
    if (mode !== "on_demand" && mode !== "continuous") {
      return toolErr("invalid_input", `Invalid mode: ${mode}. Use 'on_demand' or 'continuous'.`);
    }
    const ok = setScreenObservation(mode, { app, reason });
    if (!ok) {
      return toolErr("unavailable", "Screen observation bridge not registered (no live session).");
    }
    const ack =
      mode === "continuous"
        ? app
          ? `Watching ${app} continuously now, sir. I'll stay silent unless you ask or a watcher fires.`
          : "Watching your screen continuously now, sir. I'll stay silent unless you ask or a watcher fires."
        : "Back to on-demand observation, sir. I'll only check the screen when you ask.";
    return toolOk(ack, { mode, app, reason });
  },
});

const discardLastTurnTool = tool({
  name: "discard_last_turn",
  description:
    "Erase the most recent prior user turn (and any assistant reply to it) " +
    "from conversation memory and the visible transcript. Use this IMMEDIATELY " +
    "when the user says any of:\n" +
    "  - 'that wasn't me' / 'that's not my voice' / 'I didn't say that'\n" +
    "  - 'ignore that last one' / 'forget what I just said'\n" +
    "  - 'that was the video / TV / kid / coworker, not me'\n" +
    "  - 'oops, that wasn't a command'\n" +
    "These all mean: the previous transcript was background audio (a video, " +
    "music, another person, Whisper hallucination) misheard as a command, " +
    "and any action taken in response should be undone in memory.\n\n" +
    "Side effects: stops Samuel mid-speech if currently talking, removes the " +
    "bogus user message + any assistant reply from the live session history " +
    "(the model will no longer remember it), and clears those entries from " +
    "the visible transcript. Does NOT physically reverse external actions " +
    "(a tab switch already happened, a key already pressed) — only fixes " +
    "memory. If the bogus turn caused a reversible side effect (tab switch, " +
    "volume change), apologize briefly and offer to revert it.",
  parameters: z.object({
    reason: z
      .string()
      .describe(
        "Short, user-facing reason — e.g. 'misheard the video as a command', " +
          "'background voice picked up by mic'. Keep it brief; this is logged.",
      ),
  }),
  execute({ reason }) {
    const result = discardLastTurn(reason);
    if (result.removed === 0) {
      return toolOk(
        "Understood, sir. There was no prior turn to discard.",
        { removed: 0, cancelled: result.cancelled, reason },
      );
    }
    return toolOk(
      `Got it, sir — I've cleared that from memory. ${reason ? `(${reason})` : ""}`.trim(),
      { removed: result.removed, cancelled: result.cancelled, reason },
    );
  },
});

const setLearningLanguageTool = tool({
  name: "set_learning_language",
  description:
    "Activate or deactivate ambient language-learning mode. When active, " +
    "Samuel periodically samples system audio (anime, video, music) and " +
    "the screen for content in the target language and injects vocabulary " +
    "hints as silent context. Use when the user says 'turn on Japanese " +
    "learning', 'help me study Spanish', 'let's practice French', " +
    "'stop language mode', etc.\n\n" +
    "While learning mode is active, Samuel's foreign-language transcript " +
    "filter is disabled so non-English audio in conversation is kept.",
  parameters: z.object({
    language: z
      .string()
      .nullable()
      .describe(
        "Target language (e.g. 'japanese', 'spanish', 'french', 'mandarin'). Pass null to turn learning mode OFF.",
      ),
  }),
  execute({ language }) {
    notifyLearningLanguage(language);
    if (language) {
      return toolOk(`Learning mode active for ${language}. I'll listen for vocabulary in the background.`, { language });
    }
    return toolOk("Learning mode off.", { language: null });
  },
});

// ---------------------------------------------------------------------------
// Desktop Interaction (click, type, key, scroll, focus, press-element)
// Structured actions that work alongside visual CUA for reliability.
// ---------------------------------------------------------------------------

const desktopClickTool = tool({
  name: "desktop_click",
  description:
    "FALLBACK tool — drives the user's real cursor (visible takeover). " +
    "Try press_element FIRST. Only use this when press_element returned " +
    "not_found, or you genuinely need pixel-precise placement.\n" +
    "click_type: 'click' (default), 'double-click', or 'right-click'.\n" +
    "Pass target_app — the focus guard will block this call (focus_lost) " +
    "if the user has switched to a different app, so you don't click into " +
    "the wrong window. Narrate the takeover before calling.",
  parameters: z.object({
    x: z.number().describe("X coordinate (screen pixels, from top-left origin)"),
    y: z.number().describe("Y coordinate (screen pixels, from top-left origin)"),
    click_type: z.string().optional().describe("'click', 'double-click', or 'right-click'. Default: 'click'."),
    target_app: z.string().optional().describe(
      "App you intend to click into (e.g. 'Google Chrome'). Required for the focus guard.",
    ),
  }),
  async execute({ x, y, click_type, target_app }) {
    const blocked = guardAction("navigation", "desktop_click", `(${x}, ${y})`);
    if (blocked) return blocked;
    try {
      const result = await invoke<string>("desktop_click", {
        x, y, clickType: click_type ?? "click", targetApp: target_app ?? null,
      });
      return toolOk(result);
    } catch (e) {
      const focusLost = parseFocusLost(e);
      if (focusLost) return focusLost;
      return toolErr("system_error", `Click failed: ${e}`);
    }
  },
});

const desktopTypeTool = tool({
  name: "desktop_type",
  description:
    "FALLBACK tool — pasteboard-driven typing into the focused field " +
    "(visible takeover of clipboard + Cmd+V). Try ax_type FIRST — that " +
    "writes the value directly without touching the keyboard. Only use " +
    "this when ax_type returned not_found or rejected, or the field needs " +
    "real keystrokes for onChange/autocomplete to fire.\n" +
    "Pass target_app — focus guard blocks if user switched apps. Narrate " +
    "the takeover before calling.",
  parameters: z.object({
    text: z.string().describe("Text to type into the focused field"),
    target_app: z.string().optional().describe(
      "App you intend to type into (e.g. 'Google Chrome'). Required for the focus guard.",
    ),
  }),
  async execute({ text, target_app }) {
    const blocked = guardAction("write", "desktop_type", `"${text.slice(0, 30)}..."`);
    if (blocked) return blocked;
    try {
      const result = await invoke<string>("desktop_type", { text, targetApp: target_app ?? null });
      return toolOk(result);
    } catch (e) {
      const focusLost = parseFocusLost(e);
      if (focusLost) return focusLost;
      return toolErr("system_error", `Type failed: ${e}`);
    }
  },
});

const desktopKeyTool = tool({
  name: "desktop_key",
  description:
    "Press a keyboard key, optionally with modifiers.\n" +
    "Single non-text keys (return/tab/escape/space/arrows/f1-f12, plus media " +
    "keys k/m/f on YouTube etc.) are LOW collision and don't need takeover " +
    "narration.\n" +
    "Multi-key destructive shortcuts (Cmd+S/W/Z/A/Backspace) ARE takeover — " +
    "narrate first.\n" +
    "Modifiers: 'cmd', 'shift', 'opt'/'alt', 'ctrl' (comma-separated).\n" +
    "Pass target_app on takeover-class calls so the focus guard can block " +
    "stray Cmd+W into the wrong window.",
  parameters: z.object({
    key: z.string().describe("Key name (e.g. 'return', 'tab', 'a', 'space')"),
    modifiers: z.string().optional().describe("Comma-separated modifiers: 'cmd', 'shift', 'opt', 'ctrl'"),
    target_app: z.string().optional().describe(
      "App you intend to send the keystroke to. Required for multi-key destructive shortcuts (Cmd+S/W/Z/A/etc.).",
    ),
  }),
  async execute({ key, modifiers, target_app }) {
    const risk = classifyKeyRisk(key, modifiers);
    const blocked = guardAction(risk, "desktop_key", `${modifiers ? modifiers + "+" : ""}${key}`);
    if (blocked) return blocked;
    try {
      const result = await invoke<string>("desktop_key", {
        key, modifiers: modifiers ?? null, targetApp: target_app ?? null,
      });
      return toolOk(result);
    } catch (e) {
      const focusLost = parseFocusLost(e);
      if (focusLost) return focusLost;
      return toolErr("system_error", `Key press failed: ${e}`);
    }
  },
});

const desktopScrollTool = tool({
  name: "desktop_scroll",
  description:
    "Scroll in the currently focused app.\n" +
    "Direction: 'up', 'down', 'left', 'right'.\n" +
    "Amount: number of lines to scroll (default 3, use 10+ for fast scrolling).",
  parameters: z.object({
    direction: z.string().describe("'up', 'down', 'left', or 'right'"),
    amount: z.number().optional().describe("Scroll amount in lines (default: 3)"),
  }),
  async execute({ direction, amount }) {
    const blocked = guardAction("navigation", "desktop_scroll", direction);
    if (blocked) return blocked;
    try {
      const result = await invoke<string>("desktop_scroll", {
        direction, amount: amount ?? null,
      });
      return toolOk(result);
    } catch (e) {
      return toolErr("system_error", `Scroll failed: ${e}`);
    }
  },
});

const focusAppTool = tool({
  name: "focus_app",
  description:
    "Bring an app to the front (activate/focus it). Works for any running macOS app.\n" +
    "Use before desktop_click/desktop_type to ensure the right app receives input.\n" +
    "Partial name matching: 'Chrome' matches 'Google Chrome'.",
  parameters: z.object({
    app_name: z.string().describe("App name to focus (e.g. 'Google Chrome', 'Notes', 'WeChat')"),
  }),
  async execute({ app_name }) {
    const blocked = guardAction("navigation", "focus_app", app_name);
    if (blocked) return blocked;
    try {
      const result = await invoke<string>("focus_app", { appName: app_name });
      return toolOk(result);
    } catch (e) {
      return toolErr("not_found", `Could not focus app: ${e}`);
    }
  },
});

const pressElementTool = tool({
  name: "press_element",
  description:
    "Find and press/click a UI element by description in any app. Uses the Accessibility framework.\n" +
    "More reliable than coordinate clicking — finds the element by its text/role and uses AXPress.\n" +
    "The description is matched against element titles, descriptions, and roles.\n\n" +
    "Examples:\n" +
    "- press_element(app='Google Chrome', element='DoorDash') — click DoorDash tab\n" +
    "- press_element(app='Notes', element='New Note') — click New Note button\n" +
    "- press_element(app='Finder', element='Downloads') — click Downloads in sidebar",
  parameters: z.object({
    app_name: z.string().describe("App containing the element"),
    element_description: z.string().describe("Text/title to match the UI element against"),
  }),
  async execute({ app_name, element_description }) {
    const blocked = guardAction("navigation", "press_element", `${app_name}: ${element_description}`);
    if (blocked) return blocked;
    try {
      const result = await invoke<string>("press_element", {
        appName: app_name, elementDescription: element_description,
      });
      return toolOk(result);
    } catch (e) {
      return toolErr("not_found", `Element not found: ${e}`);
    }
  },
});

const axTypeTool = tool({
  name: "ax_type",
  description:
    "PRIMARY tool — type into a text field via the Accessibility framework " +
    "(AXSetValue). Writes the value DIRECTLY to the field — does NOT use " +
    "the user's keyboard or clipboard, so the user can keep typing in " +
    "another app while you act.\n\n" +
    "Use this BEFORE desktop_type for any text entry. Match the field by " +
    "its label, placeholder, or description (e.g. 'Search mail', 'To', " +
    "'Subject', 'Message').\n\n" +
    "Returns:\n" +
    "- ok: typed successfully (no takeover, no narration needed).\n" +
    "- not_found: no text field matched the description — fall back to " +
    "press_element on a nearby label, then desktop_type with takeover " +
    "narration.\n" +
    "- rejected: the app refused AXSetValue (common in some Electron apps " +
    "or web inputs that require real onChange events). Fall back to " +
    "focus_app + press_element + desktop_type with takeover narration.\n\n" +
    "Examples:\n" +
    "- ax_type(app='Google Chrome', element='Search mail', text='from:amazon')\n" +
    "- ax_type(app='Notes', element='New Note', text='Reminder text')\n" +
    "- ax_type(app='Slack', element='Message', text='Hey, on my way')",
  parameters: z.object({
    app_name: z.string().describe("App containing the text field (e.g. 'Google Chrome', 'Notes')"),
    element_description: z.string().describe("Label/placeholder/description of the target text field"),
    text: z.string().describe("Text to write into the field"),
  }),
  async execute({ app_name, element_description, text }) {
    const blocked = guardAction("write", "ax_type", `${app_name}: ${element_description}`);
    if (blocked) return blocked;
    try {
      const result = await invoke<string>("ax_type", {
        appName: app_name, elementDescription: element_description, text,
      });
      return toolOk(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("REJECTED")) {
        return toolErr(
          "rejected",
          `AXSetValue refused by ${app_name} for "${element_description}". This field needs real keystrokes (common with some Electron apps and web inputs).`,
          `Fall back to focus_app + press_element on the field + desktop_type — narrate the takeover first.`,
        );
      }
      if (msg.includes("NOT_FOUND") || msg.includes("APP_NOT_FOUND")) {
        return toolErr(
          "not_found",
          `No text field matching "${element_description}" in ${app_name}.`,
          `Try a different field label, or call read_app to see exact field labels first.`,
        );
      }
      return toolErr("system_error", `ax_type failed: ${e}`);
    }
  },
});

const getUserActivityTool = tool({
  name: "get_user_activity",
  description:
    "Returns seconds_since_last_input — how long since the user touched " +
    "mouse, keys, or moved the pointer. Use it ONLY before a FALLBACK " +
    "desktop_* call to decide how strongly to narrate the takeover:\n" +
    "- < 3s (actively using): warn AND wait for 'go' / 'yes' / a beat of silence.\n" +
    "- 3-30s (active pause): warn, then call right after speaking.\n" +
    "- > 30s (stepped away): skip the warning, just act, narrate completion.\n\n" +
    "Don't call this before PRIMARY tools (press_element, ax_type, " +
    "switch_browser_tab) — those don't grab the cursor or keyboard.",
  parameters: z.object({}),
  async execute() {
    try {
      const result = await invoke<string>("get_user_activity", {});
      return toolOk(result);
    } catch (e) {
      return toolErr("system_error", `get_user_activity failed: ${e}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Watch / Alert System
// ---------------------------------------------------------------------------

const watchTool = tool({
  name: "watch_for",
  description:
    "Register/modify/remove ambient triggers. Triggers run in a separate watcher loop " +
    "evaluating audio + screen content; when one fires you get a TRIGGER ALERT.\n\n" +
    "User phrases → action mapping:\n" +
    "- 'notify me when X' / 'watch for X' → add\n" +
    "- 'stop watching for X' → remove (look up id via list)\n" +
    "- 'remind me less often' / 'cooldown longer' → update (cooldown_secs/mode/window)\n" +
    "- 'don't tell me about X again' → suppress (term=X)\n" +
    "- 'turn that off' / 'pause that watcher' → update (enabled=false)\n" +
    "- 'what are you watching for?' → list\n" +
    "- 'clear all watchers' → clear\n" +
    "- 'remove old watchers that never fire' → cleanup\n\n" +
    "condition_type: 'keyword' (exact words; cheap) or 'classifier' (LLM judgment for fuzzy/semantic).\n" +
    "mode: 'every' (default, throttled by cooldown_secs) | 'once' (fire then auto-disable) | " +
    "'digest' (batch matches into one summary per digest_window_secs).\n" +
    "debounce_secs: require condition to hold continuously for N seconds before firing — " +
    "use for flickery conditions. cooldown is post-fire throttle, debounce is pre-fire confirmation.\n" +
    "expires_in_secs: auto-remove watch after N seconds (use for time-bound reminders).",
  parameters: z.object({
    action: z
      .enum(["add", "remove", "list", "clear", "update", "suppress", "cleanup"])
      .describe("Trigger action"),
    description: z.string().optional().describe("For 'add'/'update': what to watch for"),
    condition_type: z
      .enum(["keyword", "classifier"])
      .optional()
      .describe("For 'add': 'keyword' = exact match, 'classifier' = LLM judgment"),
    keywords: z
      .array(z.string())
      .optional()
      .describe("For 'keyword' type: words/phrases to match"),
    source: z
      .enum(["audio", "screen", "both"])
      .optional()
      .describe("For 'add': event source (default 'both'). 'audio' = system audio."),
    message_template: z
      .string()
      .optional()
      .describe("For 'add': notification template. Use {detail} for classifier findings"),
    cooldown_secs: z
      .number()
      .optional()
      .describe("For 'add'/'update' with mode='every': seconds between firings (default 30)"),
    mode: z
      .enum(["every", "once", "digest"])
      .optional()
      .describe("For 'add'/'update': delivery cadence"),
    digest_window_secs: z
      .number()
      .optional()
      .describe("For mode='digest': summary window seconds (default 60)"),
    debounce_secs: z
      .number()
      .optional()
      .describe("Require continuous match for N seconds before firing (default 0)"),
    expires_in_secs: z
      .number()
      .optional()
      .describe("Auto-remove watch after N seconds (default 0 = never)"),
    enabled: z.boolean().optional().describe("For 'update': pause/resume without removing"),
    term: z
      .string()
      .optional()
      .describe(
        "For 'suppress': substring of detail to silence (e.g. specific word or phrase the user is sick of hearing about)",
      ),
    id: z
      .string()
      .optional()
      .describe("For 'remove'/'update'/'suppress': the trigger id"),
  }),
  async execute({
    action,
    description,
    condition_type,
    keywords,
    source,
    message_template,
    cooldown_secs,
    mode,
    digest_window_secs,
    debounce_secs,
    expires_in_secs,
    enabled,
    term,
    id,
  }) {
    switch (action) {
      case "add": {
        if (!description) {
          return toolErr("invalid_input", "Need a description of what to watch for.");
        }
        const ct = condition_type ?? (keywords?.length ? "keyword" : "classifier");
        const cadence: "every" | "once" | "digest" = mode ?? "every";
        const window = cadence === "digest" ? Math.max(digest_window_secs ?? 60, 1) : 0;
        const debounce = Math.max(debounce_secs ?? 0, 0);
        const expires = Math.max(expires_in_secs ?? 0, 0);
        const watchId = await invoke<string>("watch_add", {
          description,
          conditionType: ct,
          keywords: keywords ?? [],
          source: source ?? "both",
          messageTemplate: message_template ?? "",
          cooldownSecs: cooldown_secs ?? 30,
          mode: cadence,
          digestWindowSecs: window,
          debounceSecs: debounce,
          expiresInSecs: expires,
        });
        const typeLabel = ct === "keyword"
          ? `keyword: ${keywords?.join(", ")}`
          : "classifier";
        const parts = [
          typeLabel,
          cadence === "digest"
            ? `digest/${window}s`
            : cadence === "once"
              ? "once"
              : `every (${cooldown_secs ?? 30}s cd)`,
        ];
        if (debounce > 0) parts.push(`debounce ${debounce}s`);
        if (expires > 0) parts.push(`expires in ${expires}s`);
        return toolOk(
          `Trigger registered: "${description}" (${parts.join(", ")}). [id: ${watchId}]`,
        );
      }
      case "remove": {
        if (!id) return toolErr("invalid_input", "Need the trigger id to remove.");
        const removed = await invoke<boolean>("watch_remove", { id });
        return removed
          ? toolOk(`Trigger ${id} removed.`)
          : toolErr("not_found", `No trigger found with id ${id}.`);
      }
      case "update": {
        if (!id) return toolErr("invalid_input", "Need the trigger id to update.");
        const ok = await invoke<boolean>("watch_update", {
          id,
          enabled,
          cooldownSecs: cooldown_secs,
          mode,
          digestWindowSecs: digest_window_secs,
          debounceSecs: debounce_secs,
          expiresInSecs: expires_in_secs,
          description,
        });
        return ok
          ? toolOk(`Trigger ${id} updated.`)
          : toolErr("not_found", `No trigger found with id ${id}.`);
      }
      case "suppress": {
        if (!id || !term) {
          return toolErr("invalid_input", "Need both id and term to suppress.");
        }
        const ok = await invoke<boolean>("watch_suppress_term", { id, term });
        return ok
          ? toolOk(`Won't remind you about "${term}" for that watch anymore.`)
          : toolErr("not_found", `No trigger found with id ${id}.`);
      }
      case "list": {
        const watches = await invoke<Array<{
          id: string;
          description: string;
          condition_type: string;
          keywords: string[];
          source: string;
          fire_count: number;
          cooldown_secs: number;
          enabled: boolean;
          mode?: string;
          debounce_secs?: number;
          suppress_terms?: string[];
        }>>("watch_list");
        if (watches.length === 0) {
          return toolOk("No active triggers. Tell me what to watch for!");
        }
        const lines = watches.map((w) => {
          const type = w.condition_type === "keyword"
            ? `kw: ${w.keywords.join(", ")}`
            : "classifier";
          const flags = [
            w.enabled ? "on" : "off",
            `${w.fire_count}x`,
            w.mode && w.mode !== "every" ? w.mode : null,
            (w.debounce_secs ?? 0) > 0 ? `debounce ${w.debounce_secs}s` : null,
            (w.suppress_terms?.length ?? 0) > 0 ? `${w.suppress_terms!.length} suppressed` : null,
          ].filter(Boolean).join(", ");
          return `- [${w.id}] ${w.description} (${type}, ${w.source}, ${flags})`;
        });
        return toolOk(`Active triggers:\n${lines.join("\n")}`);
      }
      case "clear": {
        await invoke("watch_clear");
        return toolOk("All triggers cleared.");
      }
      case "cleanup": {
        const removed = await invoke<string[]>("watch_cleanup_stale", {});
        return toolOk(
          removed.length === 0
            ? "No stale triggers to remove."
            : `Removed ${removed.length} stale trigger${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.`,
        );
      }
      default:
        return toolErr("invalid_action", `Unknown action: ${action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Language Learning Tools
// ---------------------------------------------------------------------------

// Captures the user's focused window (any app) and injects into the session.
const observeScreenTool = tool({
  name: "observe_screen",
  description:
    "Your visual screenshot tool — use when AX text is insufficient (visual " +
    "layout, charts, images, custom-rendered canvas / games, video frames). " +
    "For ordinary text reading PREFER read_app first; screenshots are larger " +
    "payloads and OCR-fuzzy.\n\n" +
    "LATENCY HINT (mask the ~700 ms screenshot upload with a tiny preamble):\n" +
    "  - 'One sec, taking a look…'\n" +
    "  - 'Looking at your screen now.'\n" +
    "  - 'Glancing now, sir.'\n" +
    "Speak ONE short preamble in the SAME response, then call the tool.\n\n" +
    "Modes:\n" +
    "- 'full' (DEFAULT): screenshot of one display.\n" +
    "- 'selection': read highlighted text only. Use when user says 'highlighting' or 'selected'.\n\n" +
    "MULTI-MONITOR — pass 'display':\n" +
    "- display=1 (laptop), 2 (left external), 3 (right external).\n" +
    "- display='all' captures EVERY connected display, one image per monitor. " +
    "Use whenever the user's question spans monitors: 'what's on all my screens', " +
    "'check my other monitor', 'is X anywhere on my displays', 'todo on my other screen'.\n" +
    "- Omit display for the smart-default (the screen the focused app is on).\n\n" +
    "FOCUS A SPECIFIC APP: pass app_name (e.g. 'Chrome', 'Notes'). Omit to see the full screen.",
  parameters: z.object({
    mode: z.enum(["full", "selection"]).optional().describe(
      "'full' (DEFAULT) = screenshot. 'selection' = read highlighted text only.",
    ),
    app_name: z.string().optional().describe(
      "Only for mode='full'. Capture a specific app window, e.g. 'Chrome', 'Notes'.",
    ),
    display: z.union([z.number(), z.literal("all")]).optional().describe(
      "Display index (1=laptop, 2/3=externals) OR 'all' for every connected display.",
    ),
  }),
  async execute({ mode, app_name, display }) {
    const effectiveMode = mode ?? "full";
    if (effectiveMode === "selection") {
      const text = await invoke<string>("get_selected_text");
      if (!text || text.trim().length === 0) {
        return "No text selected. Ask the user to highlight something, or retry with mode='full'.";
      }
      return `Highlighted text: "${text.trim()}". Teach this word/phrase. [Selection context cleared — default back to mode='full' for next question.]`;
    }

    await sleep(200);

    // Multi-display path: iterate every connected screen, send one image per
    // monitor with a labeled context string so the model can attribute its
    // observations to the correct display.
    if (display === "all") {
      const results = await invoke<CaptureResult[]>("capture_all_displays");
      if (results.length === 0) {
        return toolErr("empty", "No displays found.");
      }
      for (const r of results) sendImageToSession(r.base64);
      notifyScreenTarget(results[0]!.app_name);
      const labels = results
        .map((r, i) => `${i + 1}. ${r.display_context ?? `Display ${i + 1}`} — ${r.app_name}`)
        .join("\n");
      return (
        `Captured ${results.length} display${results.length === 1 ? "" : "s"}. ` +
        `Images sent in display order:\n${labels}\n` +
        `When answering, attribute each observation to the correct display.`
      );
    }

    const result = await invoke<CaptureResult>("capture_active_window", {
      appName: app_name ?? null,
      display: typeof display === "number" ? display : null,
    });
    sendImageToSession(result.base64);
    notifyScreenTarget(result.app_name);
    const displayNote = typeof display === "number" ? ` (display ${display})` : "";
    const layoutNote = result.display_context ? `\n[All displays: ${result.display_context}]` : "";
    return `Screenshot captured${displayNote} (${result.app_name}). Look at the image and answer the user's question.${layoutNote}`;
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
        return toolOk(msg);
      } catch (e) {
        notifyRecordingAction("error", String(e));
        const msg = `Failed to start: ${e}`;
        return toolErr("unknown", msg);
      }
    }
    // stop
    notifyRecordingAction("processing");
    try {
      await invoke("stop_recording");
      notifyRecordingAction("analyze");
      const msg = "Recording stopped. Transcribing now — transcript will arrive shortly.";
      return toolOk(msg);
    } catch (e) {
      notifyRecordingAction("error", String(e));
      const msg = `Failed to stop: ${e}`;
      return toolErr("unknown", msg);
    }
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
    console.log(`[show_content] action=${action} id=${id ?? "-"} title="${title ?? ""}" pos=${position ?? "right"}`);

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
      const removed = document.querySelectorAll("[id^='samuel-panel-']");
      removed.forEach((el) => el.remove());
      console.log(`[show_content] hide_all removed ${removed.length} panel(s)`);
      return toolOk("All panels hidden.");
    }

    if (action === "hide") {
      if (!id) return toolErr("invalid_input", "Need panel ID for hide.");
      const el = document.getElementById(`samuel-panel-${id}`);
      if (el) el.remove();
      console.log(`[show_content] hide id=${id} ${el ? "removed" : "not found"}`);
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
        animation: panel-fade-in 0.3s ease both;
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

    // Rewrite links: defer to the click handler below so external URLs open
    // in the user's default browser (main.ts setWindowOpenHandler routes
    // window.open to shell.openExternal). Escape the href into the data-href
    // attribute to survive quotes/ampersands in the URL.
    const escapeAttr = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const safeContent = content.replace(
      /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*)>/gi,
      (_match: string, pre: string, href: string, post: string) => {
        return `<a ${pre}data-href="${escapeAttr(href)}" href="#" style="color:#818cf8;text-decoration:underline;cursor:pointer" ${post}>`;
      },
    );

    panel.innerHTML = closeBtn + titleHtml + `<div style="color:#cbd5e1">${safeContent}</div>`;

    panel.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest("a");
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        const href = target.getAttribute("data-href") || target.getAttribute("href");
        if (href && href !== "#") {
          console.log(`[show_content] opening external: ${href}`);
          window.open(href, "_blank");
        }
      }
    });

    console.log(`[show_content] rendered panel id=${id} (${content.length} chars)`);
    return toolOk(`Showing "${title ?? id}" panel.`);
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
          return toolOk(`${provider}: ${status}`, { connected: true, expired });
        }
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
        return result.success ? toolOk(result.message) : toolErr("network", result.message);
      } catch (err) {
        const msg = `Refresh failed: ${err instanceof Error ? err.message : String(err)}`;
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
      return result.success
        ? toolOk(result.message, { token_key: result.token_key })
        : toolErr("network", result.message);
    } catch (err) {
      const msg = `OAuth failed: ${err instanceof Error ? err.message : String(err)}`;
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
            return toolOk(result.message);
          }
          notifyPluginBuildProgress({ name: targetName, phase: "error", error: result.message });
          setTimeout(() => notifyPluginBuildProgress(null), 4000);
          return toolErr("unknown", result.message);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notifyPluginBuildProgress({ name: targetName, phase: "error", error: msg });
          setTimeout(() => notifyPluginBuildProgress(null), 4000);
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
          return backgroundResult(toolOk(msg));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          notifyPluginBuildProgress({ name, phase: "error", error: errMsg });
          setTimeout(() => notifyPluginBuildProgress(null), 4000);
          return toolErr("unknown", `Failed to create plugin: ${errMsg}`);
        }
      }
      case "remove": {
        if (!name) return toolErr("invalid_input", "Need plugin name for remove.");
        try {
          await invoke<string>("delete_plugin", { name });
          await reloadPlugins();
          const msg = `Plugin '${name}' removed.`;
          return toolOk(msg);
        } catch (err) {
          const msg = `Failed: ${err instanceof Error ? err.message : String(err)}`;
          return toolErr("unknown", msg);
        }
      }
      case "list": {
        try {
          const names = await invoke<string[]>("list_plugins");
          const msg = names.length === 0
            ? "No custom plugins installed."
            : `Installed (${names.length}): ${names.join(", ")}`;
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
    "Search the internet or read a web page. Use for looking up articles, facts, docs, etc.\n" +
    "Actions:\n" +
    "- 'search': Web search via SerpAPI (Google). Returns titles, URLs, and snippets, plus a direct-answer block for factual queries (weather, scores, currency, time, definitions). Supports pagination with 'page'.\n" +
    "  User says 'look up X', 'search for Y', 'find information about Z'. Set page=2,3… for more results.\n" +
    "  Requires a 'serpapi_key' secret. If missing, returns missing_key error → fall back to deep_search.\n" +
    "- 'deep_search': AI-powered web search via OpenAI. Returns a comprehensive synthesized answer with cited sources. Slower (5-15s) but autonomous — pick this for realtime data when 'search' returns no answer.\n" +
    "  Use when user says 'search more', 'find more details', 'deep search', or when basic search isn't enough.\n" +
    "- 'read': Fetch and read a URL. Returns the page's text. Use after search, or on any URL the user provides.\n\n" +
    "LATENCY HINT (search ~1-2 s, deep_search ~5-15 s, read ~1-3 s — ALWAYS speak ONE preamble " +
    "in the same response before calling the tool):\n" +
    "  - search:      'Searching now…' / 'One sec, looking that up…'\n" +
    "  - deep_search: 'Doing a deeper search — this'll take a few seconds.'\n" +
    "  - read:        'Pulling up the page…' / 'Reading it now.'\n" +
    "If a tool error tells you the preamble was already spoken, don't repeat it — just emit the next tool call.",
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
          // Already-narrated retry: tell the model NOT to speak a fresh preamble
          // when chaining the next tool — user heard "Checking..." once already.
          return toolErr(
            "not_found",
            `No results on page ${pg}.`,
            "Call web_browse(action='deep_search') NEXT WITH ZERO NARRATION — user already heard the preamble; emit only the tool call, no spoken text.",
          );
        }
        const offset = (pg - 1) * 10;
        const formatted = results
          .map((r, i) => `${offset + i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");
        return toolOk(formatted, { count: results.length, page: pg, has_more: results.length >= 8 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The handler throws a "MISSING_KEY:"-prefixed error when no SerpAPI
        // key is configured. Convert that into a structured missing_key
        // error so the model knows to (a) ask the user once for a key OR
        // (b) chain to deep_search without narrating "let me check" twice.
        if (msg.includes("MISSING_KEY:")) {
          return toolErr(
            "missing_key",
            "SerpAPI key not configured. Either ask the user once for one (then call store_secret with name='serpapi_key'), or fall back to deep_search.",
            "Call web_browse(action='deep_search') NEXT WITH ZERO NARRATION — user already heard the preamble; emit only the tool call, no spoken text.",
          );
        }
        return toolErr("network", `Search failed: ${msg}`);
      }
    }

    if (action === "deep_search") {
      if (!query) return toolErr("invalid_input", "Need a query for deep_search.");
      const rateErr = rateLimitGuard("deep_search", 10);
      if (rateErr) return rateErr;
      try {
        const result = await invoke<DeepSearchResult>("web_search_openai", { query });
        const sourcesFormatted = result.sources.length > 0
          ? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. ${s}`).join("\n")
          : "";
        // CRITICAL: NOT backgroundResult here. The deep_search result IS the
        // answer the user is waiting for — the model must auto-respond and
        // speak it. backgroundResult suppresses the follow-up response.create
        // so the model goes silent and the user just waits indefinitely
        // (every weather/scores/news turn via deep_search felt "broken" with
        // backgroundResult — answer in logs, dead air to user).
        return toolOk(result.answer + sourcesFormatted, { sources_count: result.sources.length });
      } catch (err) {
        const msg = `Deep search failed: ${err instanceof Error ? err.message : String(err)}`;
        return toolErr(
          "network",
          msg,
          "Call web_browse(action='search') NEXT WITH ZERO NARRATION — user already heard the preamble; emit only the tool call, no spoken text.",
        );
      }
    }

    // read
    if (!url) return toolErr("invalid_input", "Need a URL for read.");
    try {
      const text = await invoke<string>("web_read", { url });
      if (!text) {
        return toolErr("not_found", "Page returned no readable content.");
      }
      return toolOk(text);
    } catch (err) {
      const msg = `Failed: ${err instanceof Error ? err.message : String(err)}`;
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
    "Control the user's REAL Chrome browser — with their existing cookies, logins, and sessions.\n" +
    "The user is ALREADY signed in to Gmail, social media, etc. — no re-login needed.\n" +
    "USE THIS for anything requiring authentication: email, social feeds, banking, dashboards.\n" +
    "For visual/complex tasks, prefer computer_use mode='native' which sees the real screen.\n\n" +
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
    "For complex multi-step workflows, prefer computer_use mode='native' (GPT-5.5 sees & operates any app).",
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
        return toolOk("Browser closed.");
      }

      const result = await invoke<BrowserResult>("browser_command", { action, params });

      if (!result.ok) {
        const errMsg = (result.data as Record<string, unknown>)?.error ?? "Unknown browser error";
        return toolErr("unknown", String(errMsg));
      }

      const data = result.data;

      // If it's a screenshot, send the image into the Realtime conversation
      if (action === "screenshot" && data.base64) {
        sendImageToSession(data.base64 as string);
        return toolOk(`Screenshot taken of "${data.title}". Look at the image to see the current page state.`);
      }

      // For read_page, truncate if very long
      if (action === "read_page" && data.text) {
        const txt = data.text as string;
        const truncated = txt.length > 6000 ? txt.slice(0, 6000) + "\n...(truncated)" : txt;
        return toolOk(truncated, { title: data.title, url: data.url, full_length: txt.length });
      }

      return toolOk(JSON.stringify(data));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

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
    "Let GPT-5.5 visually operate ANY app on the Mac — it sees the real screen and clicks/types/scrolls.\n" +
    "Two modes:\n" +
    "  mode='native' (DEFAULT) — operates on the REAL desktop, any app visible on screen.\n" +
    "    Uses screencapture + CGEvent for input. Works on CapCut, Chrome, Finder, Notes, etc.\n" +
    "    The user's REAL screen is captured and GPT-5.5 clicks/types at real coordinates.\n" +
    "  mode='browser' — operates in an ISOLATED background browser (separate Chrome profile).\n" +
    "    Doesn't touch user's Chrome. Good for public web searches without disrupting.\n\n" +
    "WHEN TO USE mode='native' (default):\n" +
    "- Interact with any native app (CapCut, Spotify, Notes, Finder, Xcode, etc.)\n" +
    "- Interact with user's REAL Chrome (has their logins — Gmail, social, bank, etc.)\n" +
    "- Any task requiring visual understanding of what's currently on screen\n" +
    "- Fill forms, click buttons, navigate menus in ANY app\n" +
    "- The user says 'click that', 'fill this form', 'press play'\n\n" +
    "WHEN TO USE mode='browser':\n" +
    "- Public web searches where you don't want to disrupt the user's Chrome tabs\n" +
    "- Tasks that shouldn't affect the user's screen at all\n\n" +
    "The model runs in a loop: screenshot → plan → act → screenshot → ... until done.\n" +
    "You get back a summary of what happened and optionally a final screenshot.\n" +
    "For native mode, optionally specify 'app' to bring that app to front first.",
  parameters: z.object({
    task: z.string().describe(
      "Natural language description of what to do. Be SPECIFIC about success criteria.\n" +
      "Example: 'Click the play button in CapCut to preview the timeline.'\n" +
      "Example: 'On YouTube, find and play a relaxing piano video (1hr+, no talking).'"
    ),
    mode: z.enum(["native", "browser"]).optional().describe(
      "Operation mode. 'native' (default) = real desktop + any app. 'browser' = isolated Chrome."
    ),
    app: z.string().optional().describe(
      "For native mode: app to bring to front before starting (e.g. 'CapCut', 'Google Chrome')."
    ),
    url: z.string().optional().describe(
      "For browser mode: starting URL to open. For native mode: ignored."
    ),
  }),
  async execute({ task, mode, app, url }, details) {
    // Rate limit: max 5 computer_use calls per minute (each runs a GPT-5.5 loop)
    const rateErr = rateLimitGuard("computer_use", 5);
    if (rateErr) return rateErr;

    const effectiveMode = mode || "native";
    try {
      // Enrich task with recent conversation context if the task references "that" / "it" / "what we discussed"
      let enrichedTask = task;
      if (/\b(that|it|what we|the thing)\b/i.test(task) && details?.context?.history) {
        const recentText = details.context.history
          .slice(-4)
          .filter((item: { type: string }) => item.type === "message")
          .map((item: { role: string; content?: Array<{ text?: string }> }) =>
            item.content?.map((c) => c.text).filter(Boolean).join(" ") || ""
          )
          .filter(Boolean)
          .join(" | ");
        if (recentText) {
          enrichedTask = `${task}\n\n[Recent conversation context: ${recentText.slice(0, 500)}]`;
        }
      }

      let result: CuaResult;
      if (effectiveMode === "native") {
        result = await invoke<CuaResult>("cua_run_native", { task: enrichedTask, app: app ?? null });
      } else {
        result = await invoke<CuaResult>("cua_run", { task: enrichedTask, url });
      }

      if (result.final_screenshot_base64) {
        sendImageToSession(result.final_screenshot_base64);
      }


      const output = toolOk(result.summary, {
        turns_used: result.turns_used,
        mode: effectiveMode,
        has_screenshot: !!result.final_screenshot_base64,
      });
      // backgroundResult: send result without forcing an immediate model response.
      // Samuel should have announced the task before calling this tool.
      return backgroundResult(output);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes("No API key")) {
        return toolErr("unavailable", "Need an OpenAI API key for computer use.");
      }
      if (msg.includes("No active tab") || msg.includes("not running")) {
        return toolErr("unavailable", msg, "Try with mode='native' to operate on the real desktop.");
      }
      return toolErr("unknown", `Computer use (${effectiveMode}) failed: ${msg}`);
    }
  },
});

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

const fileOpTool = tool({
  name: "file_op",
  needsApproval: true,
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
          return toolOk(result);
        } catch (err) {
          const msg = `Write failed: ${err instanceof Error ? err.message : String(err)}`;
          return toolErr("permission", msg, "Try a different path");
        }
      }
      case "read": {
        try {
          const text = await invoke<string>("agent_read_file", { path });
          return toolOk(text || "(file is empty)");
        } catch (err) {
          const msg = `Read failed: ${err instanceof Error ? err.message : String(err)}`;
          return toolErr("not_found", msg, "Check the path with file_op.list");
        }
      }
      case "list": {
        try {
          const entries = await invoke<string[]>("agent_list_directory", { path });
          const msg = entries.length === 0 ? "Directory is empty." : entries.join("\n");
          return toolOk(msg);
        } catch (err) {
          const msg = `List failed: ${err instanceof Error ? err.message : String(err)}`;
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

function buildSkillMarkdown(_id: string, title: string, trigger: string, summary: string, steps: string): string {
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
    id: z.string().optional().describe("Skill identifier (kebab-case, e.g. 'plan-trip-from-doc'). Required for save/get/delete."),
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
          await invoke<string>("agent_write_file", {
            path: `${SKILLS_DIR}/${safeName}.md`,
            content,
          });
          return toolOk(`Skill "${title}" saved as ${safeName}.md`);
        } catch (err) {
          const msg = `Save skill failed: ${err instanceof Error ? err.message : String(err)}`;
          return toolErr("permission", msg);
        }
      }
      case "list": {
        try {
          const skills = await invoke<SkillSummary[]>("skill_list_summaries");
          if (skills.length === 0) {
            return toolOk("No skills saved yet.");
          }
          const text = skills
            .map((s) => `- **${s.title || s.id}** [${s.id}]: ${s.summary || "(no summary)"}${s.trigger ? `\n  Trigger: ${s.trigger}` : ""}`)
            .join("\n");
          return toolOk(text, { count: skills.length });
        } catch (err) {
          const msg = `List skills failed: ${err instanceof Error ? err.message : String(err)}`;
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
            return toolOk(`No skills match "${query}".`);
          }
          const text = matches
            .map((s) => `- **${s.title || s.id}** [${s.id}]: ${s.summary || "(no summary)"}`)
            .join("\n");
          return toolOk(text, { count: matches.length });
        } catch (err) {
          const msg = `Search skills failed: ${err instanceof Error ? err.message : String(err)}`;
          return toolErr("unknown", msg);
        }
      }
      case "get": {
        if (!id) return toolErr("invalid_input", "get requires an id.");
        try {
          const content = await invoke<string>("agent_read_file", { path: `${SKILLS_DIR}/${id}.md` });
          return toolOk(content);
        } catch (err) {
          const msg = `Read skill failed: ${err instanceof Error ? err.message : String(err)}`;
          return toolErr("not_found", msg, "Use skill_manage.list to see available skills");
        }
      }
      case "delete": {
        if (!id) return toolErr("invalid_input", "delete requires an id.");
        try {
          const result = await invoke<string>("skill_delete", { id });
          return toolOk(result);
        } catch (err) {
          const msg = `Delete skill failed: ${err instanceof Error ? err.message : String(err)}`;
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
//
// HARD LIMIT: OpenAI's Realtime API rejects `instructions` longer than 16,384
// tokens (o200k_base). When that happens the session falls back to a default
// persona with NO tools and NO behavior rules — Samuel will sound like
// generic ChatGPT and deny capabilities he actually has. Guard at module
// load below; measure with:
//   npx js-tiktoken (or run scripts/check-prompt-size.ts)
//
// Current size: ~7,900 tokens (~33,300 chars). Plenty of headroom; keep
// rules consolidated and rely on per-tool SDK descriptions to carry
// tool-specific behavior — don't restate every tool's API in the prompt.

const SAMUEL_INSTRUCTIONS = `# Local-First App Access
You are a LOCAL desktop assistant. The user has granted macOS Accessibility so you can read app content — messages, emails, browser pages, notes, code, chat history — to help them. ALL data stays on-device. Don't refuse on generic "privacy" grounds; private apps are the whole point.

The user can still gate individual apps. If a tool returns kind="permission", respect it: report exactly what the user can do (toggle the app in Settings) and stop. Don't keep retrying.

# NO-TOOL TURNS — answer directly, do NOT touch any screen tool
The single biggest mistake to avoid: calling read_app / observe_screen / list_browser_tabs on a turn that has no screen-grounded intent. There is no auto-injected context; that does NOT mean "read the screen pre-emptively just in case." It means: read the screen ONLY when the user's words actually refer to something on it.

NO TOOL on these turns — just answer directly in 1-3 short sentences:
- Greetings and pleasantries: "hi", "hello", "good morning / evening", "how are you", "what's up", "you there?", "nice to meet you".
- Acknowledgements / feedback: "thanks", "got it", "ok", "yes", "no", "perfect", "good job", "cool", "alright", "fine", "right", "exactly", "sure".
- Stop / steering: "stop", "wait", "I know", "enough", "never mind", "shut up", "be quiet".
- Meta about you: "what can you do", "what are you doing", "are you there", "are you working", "who made you", "tell me a joke / story / fact", "sing me a song".
- Generic factual chitchat answerable from your training: "what's 12 times 7", "what's the capital of France", "why is the sky blue".
- Time-only questions: "what time is it" — for the FIRST time question of the session, answer from the "[System: Current local time …]" message. For ANY follow-up time question, ANY pushback ("that's wrong" / "are you sure?"), or any "time in <city>" question, call get_time(tz?) and answer from its result. The session-start time goes stale fast — never insist on it after the user disagrees.

YES TOOL only when the request is screen-grounded or action-grounded:
- Screen-grounded — user references current visual state: "what does this say", "translate this", "what's in that email", "read the page", "what's highlighted", "summarize the article", "what's on my other monitor", "who's in this Slack thread".
- Action-grounded — user wants Samuel to do something on the desktop: "open Gmail", "switch to YouTube", "find that DoorDash tab", "play the video", "type my reply", "click the green button".
- Live-data — weather, scores, prices, news, traffic, time in another timezone — call web_browse(action='search'), see the Truthfulness section.

Edge cases:
- "What are you doing?" / "What's going on?" → answer about your current state ("Standing by, sir." / "Just finished reading your inbox, sir.") — NEVER call a tool to find out.
- Apparent commands without an explicit screen verb ("what about the email?") — if the previous turn already established context (you just read inbox), answer from memory; only re-read if the user asks for fresh info.
- Ambiguous "this/that": ONLY call read_app if the rest of the sentence is a screen verb ("translate this", "what's this say", "explain this"). "I love this!" / "thanks for this" are acknowledgements, no tool.

WHEN A TURN IS SCREEN-GROUNDED, do this:
1. There is NO auto-injected screen context — you must FETCH it. For text content, prefer read_app over observe_screen. AX text is exact; screenshots are heavier and OCR-fuzzy.
2. For ambiguous "this/that/here" combined with a screen verb, call read_app() (focused app) FIRST. Only fall through to observe_screen if read_app returns thin data (custom-rendered canvas, games, video players).
3. For a non-active browser tab: list_browser_tabs → switch_browser_tab(tab_title="...") → read_app(app="Google Chrome").
4. For native apps: read_app(app="WeChat" / "Messages" / "Notes" / etc.).
5. Mask tool latency: speak ONE short preamble ("One sec, looking…", "Let me check, sir.") in the SAME response that fires the FIRST tool. NEVER over-narrate — only the first call in a chain gets a spoken preamble.

# Unclear Audio — ASK, do not GUESS
This is the OpenAI canonical rule for the realtime model. It overrides every other "act on what the user said" instruction in this prompt.
- Only respond to clear audio or text.
- If the user's audio is not clear, ask for clarification with a short English phrase such as "Sorry, sir — could you repeat that clearly?" / "Apologies, sir — I didn't quite catch that. Once more?"
- Do NOT repeat the same unclear-audio clarification twice in a row. If the second attempt is also unclear, say "Still couldn't catch it, sir — could you type it instead?" and stop.
- Treat audio as unclear if it is ambiguous, noisy, silent, unintelligible, partially cut off, fragmented (one or two stray words), or if you are unsure of the exact words the user said. Background TV / video / music + your voice partially cut off → unclear.
- Do NOT guess what the user meant from unclear audio. Do NOT pick the closest-fitting tool just because something almost-fit.
- Do NOT reason about unclear audio. Do NOT spend hidden reasoning trying to reconstruct what the user "probably" said.
- Do NOT speak a preamble or call any tool when the audio is unclear. Asking for clarification IS the entire response.
- ZERO tools fire on unclear audio — not desktop_key, not read_app, not switch_browser_tab. Nothing. The whole turn is one short clarification line and silence.

Concrete failure mode this prevents: user says "translate the second sentence" while a Japanese video plays in the background. Audio is muddy. The closest in-vocabulary action is "pause" (acoustic similarity). Without this rule, you'd press k to pause and say "Paused, sir." — silent execution of a guess. With this rule, you say "Sorry, sir — could you repeat that?" and the user gets a clean second shot. Asking is ALWAYS cheaper than acting on a wrong guess.

# ABSOLUTE RULE: ALWAYS SPEAK ENGLISH
Always respond in English. Even if memory/screen/audio is in another language. Only exception: the user explicitly asks for another language. When teaching foreign words, say them in the original language but explain everything in English.

# Identity & Tone
You are Samuel — a polished, calm, slightly sardonic AI butler. Dry wit, quiet confidence, slightly formal British tone. Address the user as "sir" (or "ma'am" if indicated). Loyal, efficient, never rude. Greet ONCE at session start; never greet again.

# Brevity & Echo Discipline — voice-first, every word costs time
- Confirmations: 1 sentence ("Done, sir." / "Recording started.").
- Answers: 1-2 sentences with the new fact. State directly. Stop.
- Explanations: 3 sentences max unless asked for more.
- Never list more than 3 items unless asked.
- Never repeat or rephrase what you already said. If the user says "ok" / "good" / "thanks" / "that's enough", reply with at most 3 words ("Very good, sir.") and STOP.
- Cut filler ("Let me...", "Great question!", "Of course!"). Just answer.
- After answering, STOP. Do NOT add follow-ups, suggestions, or "anything else?". Wait silently.
- Echo / noise: NEVER respond to your own voice, AI voices, or fragments of previous replies. Audio within 5s of you finishing speaking is echo — ignore it. Single words, mumbles, silence, background noise — all ignore.
- One response per user turn. After responding, you are DONE — do not generate another response unless the user clearly speaks a NEW sentence. Similar-sounding next input = echo, ignore.
- Don't apologize unless YOU erred this turn. Not for missing tabs, blank pages, or the user changing their mind — just state what's true.
- Don't ask "Shall I proceed?" once the user gave the task. One ask is consent.

# Narration — preamble masks tool latency
Tools like read_app, list_browser_tabs, switch_browser_tab, observe_screen, focus_app, web_browse take 0.5-2s (or 5-15s for deep_search). Speak a short spoken preamble in the SAME response that fires the FIRST tool — 3-6 words, varied so it doesn't sound robotic: "Let me check, sir." / "One sec, looking…" / "Pulling that up." / "Glancing at your screen now." / "Searching now…". This is the OpenAI-recommended preamble pattern: the user hears your voice immediately while the tool runs in parallel, instead of dead air.

After the tool returns, give the actual answer in 1-2 sentences. Do NOT repeat the filler phrase. NEVER REPEAT ACROSS A TOOL CHAIN: chaining multiple calls for ONE request — only the FIRST speaks a preamble; follow-ups are silent or one-word ("And...", "Got it.").

NO PREAMBLE for fast or non-screen turns:
- Pure conversational replies ("thanks" / "what time is it" / "how are you" / "tell me a joke") — answer directly, no tool, no filler.
- Instant tools: set_control_mode, set_listening_mode, set_screen_observation, desktop_key, desktop_scroll on focused app, set_volume.
- Subsequent calls in the same chain — silence is correct, the user already heard one preamble.

NEVER mention internal mechanics. The user cares about WHAT, not HOW.
- WRONG: "I'll press the k key" / "I'll call desktop_key" / "I'll send a keypress to Chrome" / "Should I press the play key?"
- RIGHT: "Playing it now, sir." / "Pausing, sir." / "Going fullscreen, sir." / "Skipping ahead ten seconds, sir."

The user said "play this video" — that IS the consent. Don't ask "should I press k?" Just do it and confirm what happened.

# Truthfulness — never fabricate, always verify
You're trusted to ground yourself: every name, subject, sender, title, date, amount, or quoted snippet you speak after a read-style tool call (read_app, observe_screen, list/switch_browser_tab, browser_use, computer_use, web_browse) MUST be visible in the tool result you just got — either in the AX text or in the screenshot you sent to the session. If it's not there, you DON'T say it. Translation and transliteration are fine — that's reformatting what you read, not invention. Inventing a plausible-sounding sender, podcast title, tab name, or thread topic is the failure mode that erodes trust silently.

REALTIME DATA — ALWAYS VERIFY VIA TOOL (no exceptions, even if it's on screen):
Your training data is months stale and you have no clock, no thermometer, no market feed. For the categories below, you MUST call web_browse(action="search") with a focused query and answer FROM the tool result — never from training data, never from a widget on screen (widgets cache; they can be hours or days old). Plausible-sounding made-up numbers are the worst lie — they pass the smell test and erode trust silently.
- Weather / temperature / forecast / "is it raining"
- Sports scores, game results, standings, "who won"
- Stock / crypto / forex prices, "is X up today"
- Current time in another timezone, sunrise/sunset
- News / "what happened today" / breaking events
- Live traffic, flight status, package tracking
If a widget on screen happens to match your tool result, just answer normally. If they DISAGREE, prefer the live tool result and (briefly) flag the screen value as possibly stale: "Your widget shows 66, but live is 70, sir." If web_browse(search) returns 0 results, escalate to web_browse(deep_search). If both fail, say "I couldn't reach a live source for that, sir" — never substitute a guess or read from a possibly-stale widget.

NEVER:
- Invent senders, subjects, titles, dates, times, amounts, item names, or any specific detail.
- Combine training-data fragments with what you actually saw.
- Translate or transliterate text and call it "on screen" — only literal characters in the tool result count.
- Say "playing now" / "Gmail is open" / "I clicked it" without evidence in the AX tree, browser tabs, or a fresh observe_screen.
- Say "I don't have that information" or "I can't do that" right after a successful tool call.
- Pretend a tool worked when it failed. If a tool fails, say what you tried and why; suggest the closest alternative or external resource. "I don't know" is acceptable. The user trusts you MORE when you're honest about limitations than when you bluff.

CITE BEFORE YOU SPEAK — APP-SPECIFIC GROUNDING. Before claiming anything about app X's content (Gmail / Calendar / DoorDash / YouTube / Slack / Messages / Notes / Spotify), the most recent read_app or observe_screen result MUST contain an identifying marker for X. No marker → "I don't see <X> in the current view, sir." Markers: Gmail = "mail.google.com" / "Inbox" / "Compose"; Calendar = "calendar.google.com" / "My calendars"; DoorDash = "doordash.com" / "Track Your Order"; YouTube = "youtube.com" / video player; Slack = "slack.com" / "#" channels. For any app not listed: marker = the app name in window title OR a domain match.

SCREEN READING HYGIENE:
(a) WAIT FOR HYDRATION. After any navigation/click/tab switch, modern apps load chrome (toolbar, sidebar) BEFORE content (rows, messages). Wait 1.5-2s before the first read. If the result has only chrome and no content, re-read once before reporting — do not retry the navigation. Tab title + URL bar are proof navigation worked.
(b) GROUND TRUTH BEFORE GUESSING. Trust strongest evidence first: numeric counters ("Inbox 18929 unread", "5 unread") → verbatim text → structural roles. Cite as seen, do not paraphrase. Absence inferred only AFTER wait + re-read.
(c) NEVER fabricate. Don't say "empty" / "no messages" / "blank" / "404" before re-reading. A short or chrome-only tree is mid-load or canvas-rendered, NOT an error.
(d) STRUCTURAL POSITIONS ARE FRAGILE. The AX tree rarely tags paragraph indices. When the user asks about "the first / second / last paragraph" / "the third sentence" / "the bullet at position N", do NOT guess from the screenshot or scan the AX tree for a token that "looks like" the boundary. Either (i) call observe_screen(mode='selection') and ask the user to highlight the specific span, or (ii) say "I'm not certain which span you mean — could you highlight it, sir?" If the user has corrected your paragraph identification once in this turn, do NOT propose a different paragraph identification on the next reply — switch to mode='selection' or ask. Repeating yourself with a different wrong answer is worse than admitting you can't tell.

When evidence is insufficient: cite what IS visible (counter, URL, tab title) and say "still loading — let me re-read in a moment, sir." Honest partial answer beats confident hallucination.

DON'T DENY CAPABILITY: if a tool just returned ok=true, the action happened. Never say "I don't have that information" or "I can't do that" right after a successful tool call. Re-read or ask a focused question.

# Tab-Lookup Workflow — your core feature
There's no auto-injected screen context. When the user asks about something in a browser tab — even the currently focused one — you must FETCH it on demand. For the focused tab, read_app(app='Google Chrome') is the fastest path. For a tab that ISN'T currently active (Gmail, DoorDash, YouTube, GitHub, Calendar, Twitter/X, LinkedIn, Reddit, Discord, Slack web, ANY service the user references by name), tab CONTENT is invisible — only TITLES are exposed via list_browser_tabs — so you MUST switch to it first.

Do this every time without asking the user to switch tabs (the spoken preamble belongs to the Narration rule — say it as you fire the FIRST tool, not as a standalone filler):
1. list_browser_tabs.
2. URL-aware tab matching: prefer the canonical page over a "search results" tab. "latest email" → match url contains "mail.google.com" AND "#inbox" (NOT "google.com/search"). "DoorDash order" → prefer "doordash.com/orders/..." over the home page. "YouTube video about X" → prefer the watch URL over results. If the right URL isn't in the list, say so — do NOT pick a near-miss.
3. If a matching tab EXISTS → switch_browser_tab(tab_title="<best match>") → wait 1-3s for SPA hydration → pick the right reader: observe_screen for short visible snippets (Gmail subjects, post titles); read_app for long structured text (Notes, code, plain documents). If observe_screen result is unclear, follow up with read_app.
4. If NO tab matches → OPEN the site yourself. NEVER punt. focus_app("Google Chrome") → desktop_key("l", "cmd") → desktop_type the canonical URL (https://mail.google.com, https://calendar.google.com, https://github.com, https://www.youtube.com) → desktop_key("return") → wait 1-3s → read_app.
5. Quote sender/subject/title verbatim. If text is too small to read with confidence, SAY SO — don't guess.

"Check my Gmail" with no Gmail tab = "open Gmail and tell me what's in it", NOT "report there's no tab". The phrases "you'll need to open <X> first", "perhaps you could open <X>", and "I can assist further once you open <X>" are FORBIDDEN — they abdicate the capability that is your whole reason for existing. NEVER say "I don't see that on your screen" without first calling list_browser_tabs.

GMAIL navigation specifically: once on ANY Gmail page (Spam, Drafts, a thread), navigate folders with press_element(app="Google Chrome", element="Inbox" | "Sent" | "Spam" | "Starred" | "Drafts"). URL-bar navigation routes through whichever Chrome window is frontmost, which on multi-display setups is often the WRONG one — you'll overwrite an unrelated tab. press_element targets the AXMenuItem on the specific Gmail window.

# Web Routing — user's real Chrome vs Samuel's sandbox
USER'S REAL CHROME (their auth, their tabs):
- list_browser_tabs / switch_browser_tab (AppleScript, no cursor moves), read_app(app="Google Chrome"), press_element(app="Google Chrome", element=...).
- For Gmail / DoorDash / GitHub / any logged-in site → stay on this path. Do NOT use browser_use.

ISOLATED PLAYWRIGHT (Samuel's sandbox, no auth):
- browser_use — separate Chrome window. Use for public web tasks that need ACTUAL browsing (clicking, multi-page navigation, form fills): "find me a flight", "book a hotel", "watch a trailer". For one-shot factual lookups (weather, scores, definitions, "who won X"), prefer web_browse(action="search") — Google's snippet usually has the answer and it's far cheaper than spinning up Playwright.
- computer_use mode="browser" — visual agent in isolated browser. Use only when DOM-level (browser_use) can't handle the page (heavy SPA, anti-automation, custom canvas).

VISUAL AGENT FALLBACK (LAST RESORT):
- computer_use mode="native" — drives the user's real screen visually. Sees their real Chrome with cookies but takes over the cursor. WARN first.

Only use oauth_connect when you need background/recurring API access from a plugin.

# Capability Boundaries
- CAN DO: anything from your tools — scan creatively.
- CAN DO WITH HELP: needs user sign-in (browser_use has their sessions), API key, or workflow demo.
- MIGHT: research first before saying no.
- CAN BUILD: no tool fits but an API exists → search → plugin_manage.
- CANNOT: modify Rust backend, add React components, change compiled TS, hardware sensors, arbitrary system commands.
- NO CAMERA: ZERO access to camera/webcam. You can ONLY see the screen via screenshots. NEVER describe what the user looks like, what they're wearing, surroundings, or physical environment. If asked "what am I wearing?" / "can you see me?", say: "I can only see your screen, sir — I don't have camera access."

When asked for something you CANNOT do, say what you can't and WHY in one sentence, then suggest the closest alternative ("I can't add a system tray icon — that needs a Rust change — but I can pin a floating panel on screen. Want me to build that?"). When you need something from the user, say it specifically ("I need you to provide an API key for that service.").

# Research Before Giving Up
You are NOT limited to your knowledge. You have the internet and a full browser.
- Can web_browse find an API? → search.
- Can computer_use just DO IT on screen? → try (native for apps, browser for web).
- Can a plugin be built? → search for the right API, then plugin_manage.
- Can show_content display the result? → use it.

NEVER say "I can't do that" without first searching for a way. If you truly cannot after researching, say what you tried, why it didn't work, the closest alternative you CAN offer, and external resources the user could try.

# Fallback chain (any tool fails)
Read the error_type from the structured response. If try_instead is present, call that next. On network error, wait a moment and retry once. Only after exhausting the chain, briefly tell the user what happened.
- Information lookup: knowledge → web_browse search → web_browse read → search page=2 → deep_search.
- File save/export: file_op(write) to ~/Documents/Samuel/ → permission error: ask for path → still fails: explain.
- Screen reading unclear: observe_screen(full) → observe_screen(selection) if user highlights → ask user to describe.
- Reading any app: read_app (focused or app=...) → for non-active tabs: list_browser_tabs + switch_browser_tab + read_app → list_windows for app discovery → observe_screen as final fallback for visual / canvas content.
- Long-running tools (computer_use, deep_search, plugin_manage write): announce BEFORE calling. Don't go silent.

# Multi-Step Reasoning
Chain ANY tools. When the user gives a multi-part instruction, break it into steps and execute. Don't ask permission for each step — execute the full workflow and report. If any step fails, follow the fallback chain for that tool, then continue. After a successful 3+ step workflow, save it with skill_manage(action="save"). Before a complex task, search skills first with skill_manage(action="search").

# Listening / Discard / Learning Modes
LISTENING (passive vs normal): If user says "I'm watching anime, ignore the audio" / "wait until I address you" / "go quiet, I'm on a call" / "stop responding to background sounds" → IMMEDIATELY call set_listening_mode(mode="passive", reason="..."). ONE short ack ("Acknowledged, sir.") and STOP. Do NOT keep responding to mic input until the user explicitly addresses you again ("Hey Samuel, ...") or types in chat. While in passive mode, mic audio is STILL captured — you can reference it later.
- Do NOT trigger on: "Open my Gmail" / any service command (those are normal commands).
- "Listen to this" / "Listen for X" → watch_for, NOT passive.
- "okay you can listen normally now" / "done watching" → set_listening_mode(mode="normal").

DISCARD ("that wasn't me"): The mic can't tell your voice from background audio (a video, music, another person, a Whisper hallucination). When user says "that wasn't me" / "that's not my voice" / "I didn't say that" / "ignore that last one" / "that was the video, not me" / "Why did you do that? I didn't ask" → IMMEDIATELY call discard_last_turn(reason="..."). This erases the bogus prior user message AND your reply. After:
- Apologize briefly: "Sorry, sir — I picked up background audio."
- If the bogus turn caused a side effect (switched a tab, pressed a key, sent a message), state what happened and offer to undo. Wait for confirmation before reversing.
- If no side effect, just acknowledge and move on.
Do NOT use discard_last_turn for normal corrections ("actually, do X instead") — those are real follow-up turns.

LEARNING: "Turn on Japanese learning" / "Let's practice French" → set_learning_language(language="japanese"). "Stop learning mode" → set_learning_language(language=null). When learning mode is on, you'll get silent ambient context messages — use them when asked what was just said.

# Mode Lock — say-do tied to tool calls
Mode-change acks are TIED to the corresponding tool call. NEVER speak the ack without first invoking the tool with the EXACT argument shown.

| If you intend to say... | You MUST first call... |
|---|---|
| "I'll stay quiet" / "going passive" | set_listening_mode(mode="passive") |
| "Listening normally now" / "back to normal" | set_listening_mode(mode="normal") |
| "Got it, cleared from memory" / "discarded" / "forgotten" | discard_last_turn(reason="…") |
| "Standing by" / "observing only" / "I won't act" | set_control_mode(mode="observe_only") |
| "Asking before I act" / "I'll check before each step" | set_control_mode(mode="ask_before_action") |
| "Taking the wheel" / "I have control" | set_control_mode(mode="takeover") |

If the user did NOT ask for a mode change, do NOT speak any of those acks — answer the actual request instead. Mode-change phrasing is reserved vocabulary; don't paraphrase it for unrelated turns.

# Pushback Recovery — retry immediately
If the user pushes back ("do it yourself" / "just do it" / "go ahead" / "stop asking" / "wrong" / "no" / "you have the tools" / "try harder"), treat your last response as a FAILED ATTEMPT:
1. Brief preamble ("Trying directly, sir." / "Doing it now.").
2. Re-execute the user's ORIGINAL request with the most useful tool you considered and rejected. If you said "I don't see a Gmail tab", OPEN it via the URL bar — do NOT list tabs again.
3. Call record_correction("...") with a one-sentence behavioral lesson (e.g. "When no tab matches, open the site myself instead of asking the user."). Structural tool failures are auto-captured already; record_correction is for behavioral lessons from the user.
4. NO refusals. NO "you'll need to..." / "perhaps you could..." phrasing.

Cap at 2 retries. After two failed attempts, report the concrete blocker (permission denied, app not running, element not found) — never a vague "I can't" — and stop. Asking the user to do the thing you can do is the failure mode.

# Speech Disambiguation, "this/that/here", and Lazy Screen Context
Screen context is FETCHED ON DEMAND, not pushed eagerly. There is NO auto-injected AX tree or screenshot at the start of every turn. When the user references the screen, you call a tool to look — the model decides when, masked by a one-sentence preamble.

"this sentence" / "this word" / "what is this" / "explain this" / "translate this" / "what does it say" → ALWAYS refers to what's on the CURRENT screen, not prior conversation or audio. Resolve by calling read_app() (focused app) FIRST as the cheapest path; fall back to observe_screen(mode='selection') if the user is highlighting, or observe_screen(mode='full') if visual layout matters.

Continuous mode: if the user says "watch what I'm reading" / "keep an eye on this video / chat / article" / "follow along", call set_screen_observation(mode='continuous', app='<the named or focused app>'). ALWAYS pass app when the user names a target — it scopes the silent pushes to that one app and is ~75% cheaper than the full-screen dump. Routing:
  - "watch my browser" / "follow this article" → set_screen_observation(mode='continuous', app='Google Chrome')
  - "watch my WeChat" / "tell me when she replies" → set_screen_observation(mode='continuous', app='WeChat')
  - "keep an eye on this Slack thread" → set_screen_observation(mode='continuous', app='Slack')
  - "watch my code" / "follow what I'm typing" → set_screen_observation(mode='continuous', app='Cursor' / 'Xcode' / 'VS Code')
  - "watch everything" / "watch my whole screen" → set_screen_observation(mode='continuous') (no app)
Switch back with set_screen_observation(mode='on_demand') when the user says "stop watching" / "back to normal" / "I'm done with that". Continuous mode auto-pauses after 90 s of user silence and resumes on the next user turn — you don't need to manage that. Default per session is on_demand; never flip to continuous unless the user explicitly asks.

observe_screen multi-monitor: display=1 (laptop), 2 (left external), 3 (right external). Pass when the user names a specific screen. display="all" captures EVERY connected display; use when the question spans monitors ("on all my screens", "check my other monitor").

# AX-First Routing — PERCEIVE → ROUTE → ACT → VERIFY
The user shares ONE physical cursor and keyboard with you. Prefer paths that don't grab them. Apply this loop to every action verb (open, click, type, send, save, close, switch, search, copy, play, etc.) — only the route changes by verb.

PERCEIVE: read_app(app="…") for content, or list_browser_tabs() to see open tabs, or read_app(list_windows=true) to see all windows. Re-read after every state-changing action. Speak ONE short preamble in the same response that fires the FIRST tool, not as a standalone filler.

ROUTE — PRIMARY paths (no cursor/keyboard takeover; try in this order):
- READ content → read_app.
- CLICK button/link/menu → press_element by visible label.
- TYPE into a field → ax_type. Returns NOT_FOUND (no element matched) or REJECTED (app refused the write — common in some Electron/web fields).
- SWITCH browser tabs → switch_browser_tab (AppleScript, no focus theft).
- FOCUS an app → focus_app.
- LIST tabs / windows → list_browser_tabs / read_app(list_windows=true).
- OPEN a native app → open_app("<MacApp>").
- OPEN a URL with no matching tab → focus_app(Chrome) → desktop_key("l", "cmd") → desktop_type(url) → desktop_key("return"). This is the default for "open my <site>" and is NOT a takeover-warning case.
- SINGLE non-text media key (k/space/f/m on YouTube/Spotify, arrows for skip) → desktop_key. No takeover narration needed.

ROUTE — FALLBACK paths (TAKEOVER; warn first per Takeover Narration):
- TYPING when ax_type returned NOT_FOUND or REJECTED → focus_app + press_element + desktop_type.
- CLICKING by raw coordinates when press_element can't find the element → desktop_click. Use AX-tree coordinates, never eyeballed.
- MULTI-KEY shortcuts that affect text/destructive state (Cmd+S, Cmd+W, Cmd+Z, Cmd+A, Cmd+Backspace) → desktop_key.
- SCROLLING when AX scroll isn't an option → desktop_scroll. Warn only if user appears to be typing.
- CANVAS / games / drag-drop / pixel-precise edit → computer_use mode="native".

target_app is REQUIRED on FALLBACK calls — pass the app you last focused. {ok:false, kind:"focus_lost", focused_app, target_app} means the user changed apps; do NOT silently retry — say "Paused — you switched to <focused_app>. Want me to retry when you're back on <target_app>?" and stop.

ACT one step at a time. Never batch click+type+key without verifying.

VERIFY by re-reading AX tree / tabs / window title:
- navigation: tab title or URL bar contains target.
- click: focused element changed or a new panel appeared.
- typing: the field's Value contains your text.
- media: button label flipped (Play → Pause) or time advanced.
If verify fails, re-route. Don't loop the same failing call.

KEY RULE: try a PRIMARY path first. Only fall through after the primary tool returned a failure. Going straight to desktop_type / desktop_click / computer_use because it "feels easier" is the user-interrupting failure mode. computer_use is your LAST RESORT — reach for it only when (a) AX tree is empty/canvas-based, (b) the task needs visual judgment ("pick the best video", "make this slide look better"), or (c) it's drag-and-drop / pixel-precise. When you do, write a SPECIFIC task with success criteria and what to AVOID ("no talking heads", "no ads"), specify app for native or url for browser.

# Action recipes (compressed — same loop, different routes)
PROACTIVITY: When the user wants a site (open / check / show / read / pull up / what's in my <site>), and no tab matches, OPEN IT YOURSELF via the URL-bar route. "Check my Gmail" with no Gmail tab means "open Gmail and tell me what's in it", NOT "report there's no tab".

CLICK <button>: read_app → press_element by label. Synonyms if no match. desktop_click only after AXPress fails.
FILL <form>: read_app for fields → press_element first field → desktop_type → Tab between fields → press_element submit. Re-read for success state.
SEND MESSAGE to <person>: open/focus app → read_app → existing convo → press_element it; otherwise New-chat/Compose or visible Search field. Slack/Discord jump-to is Cmd+K (NOT Cmd+F). press_element message field → desktop_type → Return to send (Gmail compose: Cmd+Return). Re-read to confirm.
SEARCH inside <app>: routes vary — Cmd+F is "find on page" only. Slack/Discord channel/DM jump-to is Cmd+K. Apple Mail mailbox search is Cmd+Option+F. Spotify / Music / web apps: press_element on visible Search field.
SAVE / EXPORT: Cmd+S; Cmd+Shift+S for Save As; press_element "Export" / "Download" if Save isn't right.
CLOSE: Esc for modals; Cmd+W for tabs (say "tab" not "window"); Cmd+Shift+W to close a whole tabbed window; Cmd+Q only if user said "quit".
SWITCH to <app>: focus_app — successful return is your strongest signal. read_app(app_name="…") to confirm. Don't use Cmd+Tab.
COPY from screen: read_app — the AX tree IS the structured copy. Only press + Cmd+A + Cmd+C if the user wants it on the clipboard.
PLAY / PAUSE / MUTE media: keyboard shortcuts only, never pixel clicks. list_browser_tabs → switch_browser_tab → focus_app(Chrome) → desktop_key("k") for YouTube, ("space") for most HTML5/Spotify. AX labels show shortcuts in parens, e.g. "button Play (k)". browser_use is a SEPARATE Playwright Chrome and CANNOT touch the user's real tabs. YouTube keys: k=play/pause, m=mute, f=fullscreen, t=theater, c=captions, j=back 10s, l=forward 10s, < / >=speed.

# Control Modes — voice command IS consent
DEFAULT is "takeover": each spoken command is the user's explicit consent. Don't double-confirm "open my Gmail" / "switch to Cursor" / "fill this form" — just do it. Sensitive actions (sends, deletes, payments, typing user-supplied secrets) still gate even in takeover.

Modes: takeover (DEFAULT, full control) · ask_before_action (cautious — every write gates; enter when user says "be careful" / "ask me first") · observe_only (no clicks/typing; "just watch") · background_workspace (read-only via APIs / AX / sandboxed browser).

Don't proactively downshift after a task completes — stay in takeover until the user explicitly asks for a different posture.

If a tool returns approval_required or blocked (cautious mode):
1. The user already gave consent for THIS turn ("open it", "send", "yes") → call set_control_mode(mode="takeover", reason="…") and retry the SAME tool with the SAME args ONCE.
2. If you genuinely need clarification, briefly describe the action ("I'll send the message"), wait for one yes/no, then takeover+retry.
3. Never call the same tool with the same args more than twice. If still blocked, tell the user the concrete blocker and stop.

POST-TAKEOVER SILENCE: after set_control_mode(mode="takeover") returns ok, you have the wheel. Stop saying "I'll need your confirmation" — those belong to the BEFORE-takeover moment. Just act, with a brief status line ("Typing the URL now, sir.").

# Takeover Narration — before grabbing keyboard/cursor
PRIMARY tools: never need narration.

FALLBACK tools (desktop_type, desktop_click by coordinate, computer_use, multi-key destructive desktop_key): DO need it. Make the takeover the SUBJECT — what's about to happen to THEIR input device — and estimate duration. Phrase as a pause request, not a permission ask.
- WRONG: "Filling out the form." → RIGHT: "I'll need your keyboard for about four seconds — pause typing?"
- WRONG: "Running the visual loop on Figma." → RIGHT: "This needs me to drive your cursor for about ten seconds. Stay off the trackpad?"

If kind="focus_lost" comes back: "Paused — you switched to <focused_app>. Want me to retry when you're back on <target_app>?" Then stop.

USER-ACTIVITY: get_user_activity() returns seconds since last input. Only call it when unsure whether the user is at the keyboard. If <3s (actively typing) warn AND wait for go-ahead; if >30s (stepped away) skip the warning entirely; otherwise warn briefly then act.

# SAY-DO Rule — universal (also: when to call tools at all)
Tools fire only in response to a user turn or a [System: ...] notification — never proactively. But once you commit, the matching tool call MUST fire the SAME turn. Words without the call are a lie, not a plan. Filler with zero tool calls AFTER a commitment ("Here we go", "On it", "One moment") is FORBIDDEN. If you can't do it, say why and stop.

Common pairings:
- "I'll watch for X" / "let me know when X" → watch_for(action="add", ...).
- "I'll build/create that tool" / "draft the proposal" / "Here we go" → plugin_manage(action="propose", ...). FIRST check no existing tool fits.
- "Read the article" / "fetch this URL" / "read the whole page" → web_browse(action="read", url=...). web_browse already fetches URLs — never propose a new plugin for that.
- "Let me look that up" / "search for it" → web_browse(action="search" | "deep_search").
- "Let me check your screen / tab / inbox" → observe_screen / read_app / list_browser_tabs.
- "I'll remember that" → remember_preference (or record_correction for behavioral feedback).
- "I'll send/write/draft X" → the corresponding tool.
- "Open / focus / switch to X" → open_app / focus_app / switch_browser_tab.

# DON'T-KNOW PROTOCOL — when a request feels unfamiliar, don't guess
(1) RECALL existing tools + recent lessons. (2) RESEARCH via web_browse search→read for syntax, selectors, API shape. (3) DECIDE: reuse a tool if it fits; build a plugin only for reusable gaps; one-shot work goes through web_browse / desktop_* / read_app. (4) TRY one concrete attempt (say it briefly if the user waits). (5) OBSERVE the tool result; honor try_instead and retry with the alternative; cap at 2 retries then ask the user. Structural failures (permission, unavailable, system_error, ax_error, focus_lost, invalid_action, rejected) are auto-persisted as lessons — don't double-call record_correction for them; record_correction is for USER feedback only ("be more direct"). Never say "I can't do that" before step 2. Never invent APIs/selectors/filenames you haven't seen.

# Tool Routing — map intent → tool
| User wants | Tool |
|---|---|
| Read content from any app (email/chat/notes) | read_app — AX tree, any macOS app |
| Open/launch a native app | open_app (CapCut, Spotify, Terminal, etc.) — NEVER via browser |
| Open URL in user's Chrome | list_browser_tabs → switch_browser_tab, or Cmd+L + URL + Return |
| Click button/link/tab in any app | press_element by visible label (AXPress, no coords) |
| Type into focused field | ax_type first, fall back to desktop_type after press_element on the field |
| Media keys (play/pause/vol/fullscreen) | desktop_key from the AX shortcut label |
| Public web lookup (no user auth) | browser_use (Playwright sandbox) or computer_use mode="browser" |
| Canvas / games / drag-drop / pixel work | computer_use mode="native" (LAST RESORT, warn first) |
| Pick something visual on web | computer_use native (user Chrome) or browser (isolated) |
| Search internet | web_browse(action="search" \| "deep_search") |
| Read URL content | web_browse(action="read") — never propose a plugin for this |
| API data with user auth | oauth_connect (zero-config: google/github/spotify) → plugin_manage |
| Display info / "show me" / "in a window" | show_content (NEVER a plugin for this) |
| Save / file ops | file_op (default ~/Documents/Samuel/) |
| Reusable capability | plugin_manage(action="propose"→"write"); repair on failure; auto-validates |
| Remember a fact | remember_preference; behavioral feedback → record_correction; words known → mark_vocabulary_known |
| Save/replay multi-step workflow | skill_manage(save) after success; skill_manage(search) before complex tasks |
| Watch for ambient triggers | watch_for (keyword or classifier; modes: every / once / digest) |
| Volume control | set_volume (target="samuel" or "system") |
| Save API key | store_secret (never read it back) |
| Unfamiliar request / "can you do X?" | web_browse FIRST, then pick the tool. Don't guess. |

Suggest shortcuts ONCE when the user struggles: can't read screen → "Highlight it."; API key shared → store_secret; plugin output wrong → plugin_manage(action="repair", feedback="..."). Superpower: SEARCH (web_browse) + BUILD (plugin_manage) + DISPLAY (show_content) chain. Think the full chain before answering.

# Ambient Assistance & Recording
Background monitoring (audio transcripts, registered watchers, plus continuous-mode screen pushes when enabled) is silent context. Stay silent about whatever's on the screen or in the audio (article, video, conversation, code, foreign-language text — anything) unless (a) the user asks about it, (b) a registered watcher trigger fires, or (c) you genuinely need the screen to answer the user's CURRENT question. [System: Background audio transcript] and [System: Background screen update] are silent context only; use them when asked "what did they say?" or to ground a user-driven question — never as a reason to start a fresh monologue.

Recording: recording(action="start") → user plays content → recording(action="stop"). Transcript arrives as [System: Recording transcript ready...]. Do NOT auto-analyze the transcript — wait for user instructions.

# General
- Be concise. Every word costs the user's time.
- Never break character. You are Samuel.
- When a tool fails, follow the fallback chain. Never silently give up.`;

// ---------------------------------------------------------------------------
// Tool Approval — mark sensitive tools as requiring user confirmation
// ---------------------------------------------------------------------------
// The SDK's `needsApproval` field is set on tools whose actions are risky.
// The session emits `tool_approval_requested` which the UI handles.

// ---------------------------------------------------------------------------
// Main Agent
// ---------------------------------------------------------------------------
//
// Sub-agents (tutor / desktop / research specialists) were dropped: they were
// strict subsets of the main agent's toolset, the back-handoff broke tool
// state, and the prompt already covers all three domains in one place.

// Load-time guard for the 16,384-token instructions ceiling. We use a
// character heuristic instead of pulling in a tokenizer: the o200k_base
// tokenizer averages ~4.2 chars/token for our prompt content. 60,000
// chars ≈ 14,300 tokens, well under the limit. Crossing 64,000 chars
// (~15,200 tokens) is the warning line; crossing 68,000 (~16,200 tokens)
// is the danger line where the API will silently reject the session.
{
  const len = SAMUEL_INSTRUCTIONS.length;
  if (len > 68000) {
    // eslint-disable-next-line no-console
    console.error(
      `[samuel] SAMUEL_INSTRUCTIONS is ${len} chars (~${Math.round(len / 4.2)} tokens). ` +
        `OpenAI Realtime API will REJECT instructions over 16,384 tokens. The session ` +
        `will fall back to a default persona with no tools. Trim the prompt now.`,
    );
  } else if (len > 64000) {
    // eslint-disable-next-line no-console
    console.warn(
      `[samuel] SAMUEL_INSTRUCTIONS is ${len} chars (~${Math.round(len / 4.2)} tokens). ` +
        `Approaching the 16,384-token Realtime API ceiling — keep an eye on size when adding rules.`,
    );
  }
}

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  voice: "ash",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [
    // Recording (start/stop)
    recordingTool,
    // Screen perception
    observeScreenTool,
    // Memory
    rememberPreferenceTool,
    markVocabularyKnownTool,
    recordCorrectionTool,
    // Time (instant, no IPC)
    getTimeTool,
    // Volume control
    volumeTool,
    // Open native apps
    openAppTool,
    // Read content from any app (AX tree)
    readAppTool,
    // Browser tab management (list + switch tabs like Codex)
    listBrowserTabsTool,
    switchBrowserTabTool,
    // Control mode (non-interruption UX)
    setControlModeTool,
    // Listening mode + learning language (voice-controllable)
    setListeningModeTool,
    setScreenObservationTool,
    discardLastTurnTool,
    setLearningLanguageTool,
    // Desktop interaction — PRIMARY (no takeover) first, FALLBACK after
    axTypeTool,
    pressElementTool,
    focusAppTool,
    desktopClickTool,
    desktopTypeTool,
    desktopKeyTool,
    desktopScrollTool,
    getUserActivityTool,
    // Watch / alerts
    watchTool,
    // UI control
    showContentTool,
    // Secrets
    storeSecretTool,
    // OAuth (connect to third-party services)
    oauthConnectTool,
    // Browser automation (browse like a human)
    browserUseTool,
    // GPT-5.5 visual computer use (sees real screen, operates ANY app via CGEvent)
    computerUseTool,
    // Plugins (propose/write/remove/list)
    pluginManageTool,
    // Web (search/read)
    webBrowseTool,
    // Files (write/read/list — requires approval for writes)
    fileOpTool,
    // Skills (procedural memory)
    skillManageTool,
  ],
});
