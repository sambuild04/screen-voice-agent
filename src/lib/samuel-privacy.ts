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
 *   - "tool" (screen_read, audio_record, computer_use): default ON.
 *     Controls the tools the model can call directly during a turn.
 *     These are master kill-switches for the corresponding capability.
 *   - "ambient context" (local_time, location): default varies. Gates
 *     ambient context that's injected at session boot or fetched on
 *     demand by tools. The model receives a clear "gated" signal so it
 *     can ask the user to flip the toggle instead of guessing.
 *
 * Voice input (privacy.voice_input) is a fourth axis enforced at the
 * React layer — see App.tsx — because the realtime mic is renderer-side
 * and there's no tool to gate. It doesn't have a helper here.
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
  /**
   * Explicit on-demand system-audio capture via the `recording` tool —
   * "record this song", "capture what's playing". Distinct from
   * canListenAmbient() (the passive audio buffer + learning loop), which
   * is gated by privacy.audio_listen. Users who want zero audio capture
   * under any circumstance need both off.
   */
  canRecordAudio(): boolean {
    return readBool("privacy.audio_record", true);
  },
  /** Desktop automation: clicks, typing, key presses, computer_use loop. */
  canControlComputer(): boolean {
    return readBool("privacy.computer_use", true);
  },
  /**
   * Knowledge of the user's local time + IANA timezone. Default OFF —
   * opt-in. When off:
   *   - Session-boot inject in useRealtime.ts sends UTC instead of local time.
   *   - get_time() with no `tz` argument falls back to UTC.
   *   - get_time(tz="...") still works because the user named the zone.
   * Timezone leaks region (~country/state granularity) so this is treated
   * as ambient context, not a tool guard — there's no "permission denied"
   * surface; instead the model gets UTC and is told why.
   */
  canKnowTime(): boolean {
    return readBool("privacy.local_time", false);
  },
  /**
   * Approximate physical location via IP geolocation (city, region, country).
   * Default OFF — opt-in. Calling get_location while disabled returns a
   * permission error. Does NOT cover GPS-grade location; that would need a
   * separate CoreLocation bridge.
   */
  canKnowLocation(): boolean {
    return readBool("privacy.location", false);
  },
};

/**
 * Standard JSON-serialized error envelope returned to the model when a tool
 * is blocked by a privacy toggle. Uses `error_type: "permission"` so the
 * model treats it like other permission denials and surfaces it cleanly to
 * the user instead of retrying.
 */
export function privacyBlockError(
  capability: "screen reading" | "audio recording" | "voice input" | "computer use" | "location",
): string {
  return JSON.stringify({
    ok: false,
    error_type: "permission",
    message: `${capability[0].toUpperCase()}${capability.slice(1)} is disabled in Settings → Privacy. Tell the user to re-enable it if they want this action.`,
    try_instead: null,
  });
}
