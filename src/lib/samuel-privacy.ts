/**
 * Privacy gating helpers for tool-level enforcement.
 *
 * Tools defined in `samuel.ts` run in the renderer process, so they can read
 * UI prefs directly from localStorage rather than going through the React
 * hook (which would require threading a context all the way into each tool's
 * `execute()`). This module is the seam between the two layers.
 *
 * The canonical schema lives in `src/hooks/useUIPreferences.ts` — keep keys
 * in sync with the SCHEMA there. We fail OPEN: if prefs are missing/corrupt
 * (e.g. fresh install before the hook has mounted), tools keep working with
 * their default behavior. Privacy enforcement happens once the user has
 * actively interacted with the prefs at least once.
 *
 * Two scopes of privacy keys exist:
 *
 *   - "proactive" (screen_watch, audio_listen): default OFF. Controls the
 *     ambient watcher and learning loops. Does NOT block on-demand tools.
 *   - "tool" (screen_read, voice_input, computer_use): default ON. Controls
 *     the tools the model can call directly during a turn. These are
 *     master kill-switches for the corresponding capability.
 */

const PREFS_KEY = "samuel-ui-prefs";

function readBool(prefKey: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultValue;
    const prefs = JSON.parse(raw) as Record<string, unknown>;
    const value = prefs[prefKey];
    if (typeof value === "boolean") return value;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Tool-scope privacy capabilities exposed in the Settings panel. Defaults
 * mirror the schema defaults in `useUIPreferences.ts` so behavior stays
 * identical when prefs aren't initialized yet.
 */
export const privacy = {
  /** On-demand screen reading: read_app, observe_screen, list_browser_tabs. */
  canReadScreen(): boolean {
    return readBool("privacy.screen_read", true);
  },
  /** Realtime voice mic + wake word — Samuel hearing the user's voice. */
  canHearVoice(): boolean {
    return readBool("privacy.voice_input", true);
  },
  /** Desktop automation: clicks, typing, key presses, computer_use loop. */
  canControlComputer(): boolean {
    return readBool("privacy.computer_use", true);
  },
};

/**
 * Standard JSON-serialized error envelope returned to the model when a tool
 * is blocked by a privacy toggle. Uses `error_type: "permission"` so the
 * model treats it like other permission denials and surfaces it cleanly to
 * the user instead of retrying.
 */
export function privacyBlockError(
  capability: "screen reading" | "voice input" | "computer use",
): string {
  return JSON.stringify({
    ok: false,
    error_type: "permission",
    message: `${capability[0].toUpperCase()}${capability.slice(1)} is disabled in Settings → Privacy. Tell the user to re-enable it if they want this action.`,
    try_instead: null,
  });
}
