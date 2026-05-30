import { useEffect, useRef } from "react";
import { invoke } from "../lib/invoke-bridge";
import { runWatchEvaluation, type WatchAlert } from "../lib/watcher-eval";
import type { ConnectionStatus } from "./useRealtime";

const WATCHER_INTERVAL_MS = 20_000;

/**
 * Standalone watcher loop (Loop 2 of the ambient agent architecture).
 * Runs whenever the Realtime session is connected, regardless of learning mode.
 *
 * Evaluates active triggers against screen content AND system-audio
 * transcripts every cycle. The audio path is decoupled from learning mode:
 * if any active watch declares source="audio" or "both", this hook acquires
 * a watcher-side audio capture (refcounted on the Electron side, so it
 * cohabits with learning mode) and transcribes a chunk per tick.
 *
 * When learning mode is active, this loop defers entirely — useLearningMode
 * already evaluates both screen and audio inline on its own cadence.
 */
export function useWatcherLoop(
  sessionStatus: ConnectionStatus,
  agentState?: "idle" | "listening" | "thinking" | "speaking",
  learningActive?: boolean,
  screenWatchEnabled = true,
  audioListenEnabled = true,
) {
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;
  const learningActiveRef = useRef(learningActive);
  learningActiveRef.current = learningActive;
  const screenWatchRef = useRef(screenWatchEnabled);
  screenWatchRef.current = screenWatchEnabled;
  // Mirrors privacy.audio_listen. When the user flips this off, any
  // watcher-side audio capture must be released even if a watcher with
  // source="audio"/"both" is still active — the toggle is the master gate.
  const audioListenRef = useRef(audioListenEnabled);
  audioListenRef.current = audioListenEnabled;
  const inFlightRef = useRef(false);
  // Tracks whether we currently hold the watcher-side slot of the shared
  // audio capture. Used to decide when to acquire/release per tick.
  const audioHeldRef = useRef(false);

  useEffect(() => {
    if (sessionStatus !== "connected") return;

    const runWatcher = async () => {
      // Skip if learning mode is running (it handles watcher evaluation itself)
      if (learningActiveRef.current) {
        // Learning mode owns the audio cycle now — release our slot if we
        // were holding it, so the helper isn't kept alive unnecessarily
        // when learning mode is the only active path.
        if (audioHeldRef.current) {
          await invoke("stop_watcher_audio").catch(() => {});
          audioHeldRef.current = false;
        }
        return;
      }
      if (inFlightRef.current) return;

      const state = agentStateRef.current;
      if (state === "thinking" || state === "speaking") return;

      // Check if there are any active triggers at all (avoid unnecessary work)
      let watches: WatchAlert[];
      try {
        watches = await invoke<WatchAlert[]>("watch_list");
      } catch {
        return;
      }
      const enabled = watches.filter((w) => w.enabled);

      const hasScreenTriggers = enabled.some((w) => w.source === "screen" || w.source === "both");
      const hasAudioTriggers = enabled.some((w) => w.source === "audio" || w.source === "both");
      // Audio capture is gated by BOTH a watcher needing it and the user
      // having privacy.audio_listen enabled. Without this AND, flipping
      // audio_listen off in Settings wouldn't actually stop watcher-side
      // capture if any audio/both trigger was active.
      const wantAudio = hasAudioTriggers && audioListenRef.current;

      // Drive watcher audio capture lifecycle: acquire when needed, release
      // when not. The Electron side refcounts so this composes with learning
      // mode's audio capture without double-spawning the helper.
      if (wantAudio && !audioHeldRef.current) {
        await invoke("start_watcher_audio").catch(() => {});
        audioHeldRef.current = true;
        console.log("[watcher-standalone] acquired audio capture");
      } else if (!wantAudio && audioHeldRef.current) {
        await invoke("stop_watcher_audio").catch(() => {});
        audioHeldRef.current = false;
        console.log("[watcher-standalone] released audio capture");
      }

      if (enabled.length === 0) return;

      inFlightRef.current = true;

      try {
        // Screen content: capture and describe via GPT-4o-mini
        let screenText = "";
        if (hasScreenTriggers && screenWatchRef.current) {
          try {
            screenText = await invoke<string>("check_screen_text") ?? "";
          } catch {
            // check_screen_text may not exist yet; fall back to nothing
          }
        }

        // Audio content: language-agnostic chunk via the watcher-side check.
        // Only transcribe when we actually hold the capture slot — which
        // already implies privacy.audio_listen is on (see wantAudio above).
        let audioText = "";
        if (hasAudioTriggers && audioHeldRef.current && audioListenRef.current) {
          try {
            const res = await invoke<{ transcript: string | null }>("check_watcher_audio");
            audioText = res?.transcript ?? "";
          } catch {
            // check_watcher_audio may not exist yet on older builds; degrade silently
          }
        }

        const { triggerCount } = await runWatchEvaluation({ audioText, screenText });
        if (triggerCount > 0) {
          console.log(`[watcher-standalone] ${triggerCount} trigger(s) fired`);
        }
      } catch (e) {
        console.error("[watcher-standalone] error:", e);
      } finally {
        inFlightRef.current = false;
      }
    };

    const interval = setInterval(runWatcher, WATCHER_INTERVAL_MS);
    runWatcher();

    return () => {
      clearInterval(interval);
      // Release audio capture on unmount/disconnect so the helper can shut
      // down if no other consumer is holding it.
      if (audioHeldRef.current) {
        invoke("stop_watcher_audio").catch(() => {});
        audioHeldRef.current = false;
      }
    };
  }, [sessionStatus]);
}
