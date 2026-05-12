import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/invoke-bridge";
import { registerLearningLanguage, sendSilentContext } from "../lib/session-bridge";
import { runWatchEvaluation } from "../lib/watcher-eval";
import type { ConnectionStatus } from "./useRealtime";

const STORAGE_KEY = "samuel-learning-language";
const CHECK_INTERVAL_MS = 20_000;

interface AudioCheckResult {
  transcript: string | null;
  hint: string | null;
  pcm_audio_base64: string | null;
}

export interface UseLearningModeReturn {
  learningLanguage: string | null;
  learningActive: boolean;
  clearLearning: () => void;
}

export function useLearningMode(
  sessionStatus: ConnectionStatus,
  agentState?: "idle" | "listening" | "thinking" | "speaking",
  screenWatchEnabled = true,
  audioListenEnabled = true,
): UseLearningModeReturn {
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;
  const screenWatchRef = useRef(screenWatchEnabled);
  screenWatchRef.current = screenWatchEnabled;
  const audioListenRef = useRef(audioListenEnabled);
  audioListenRef.current = audioListenEnabled;

  const [language, setLanguage] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const [active, setActive] = useState(false);
  const checkInFlightRef = useRef(false);

  const updateLanguage = useCallback((lang: string | null) => {
    setLanguage(lang);
    if (lang) {
      localStorage.setItem(STORAGE_KEY, lang);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const clearLearning = useCallback(() => {
    updateLanguage(null);
  }, [updateLanguage]);

  useEffect(() => {
    registerLearningLanguage(updateLanguage);
    return () => registerLearningLanguage(null);
  }, [updateLanguage]);

  // Audio recorder runs whenever learning language is set AND audio listening is enabled.
  useEffect(() => {
    if (language && audioListenEnabled) {
      invoke("start_learning_audio").catch((e) =>
        console.warn("[learning-mode] failed to start audio:", e),
      );
    } else {
      invoke("stop_learning_audio").catch(() => {});
    }
    return () => {
      invoke("stop_learning_audio").catch(() => {});
    };
  }, [language, audioListenEnabled]);

  // STOP the audio recorder while Samuel is speaking or thinking — his own
  // voice leaks into system audio capture despite PID/bundle exclusion.
  // Only restart 1.5s after he finishes to let the audio pipeline clear.
  const wasSpeakingRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isBusy = agentState === "speaking" || agentState === "thinking";
    if (isBusy && !wasSpeakingRef.current) {
      wasSpeakingRef.current = true;
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      if (language && audioListenEnabled) {
        invoke("stop_learning_audio").catch(() => {});
      }
    } else if (!isBusy && wasSpeakingRef.current) {
      wasSpeakingRef.current = false;
      // Delay restart so Samuel's audio fully clears from the system buffer
      if (language && audioListenEnabled) {
        restartTimerRef.current = setTimeout(() => {
          invoke("start_learning_audio").catch(() => {});
          restartTimerRef.current = null;
        }, 1500);
      }
    }
    return () => {
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
      }
    };
  }, [agentState, language, audioListenEnabled]);

  // Main observation loop — checks BOTH audio and screen every cycle
  useEffect(() => {
    if (!language || sessionStatus !== "connected") {
      setActive(false);
      return;
    }

    setActive(true);

    const runCheck = async () => {
      if (checkInFlightRef.current) return;
      // Suppress learning checks while Samuel is executing a tool or speaking.
      // Uses ref to avoid the interval being torn down on every state change.
      const state = agentStateRef.current;
      if (state === "thinking" || state === "speaking") return;
      checkInFlightRef.current = true;

      try {
        const noAudio: AudioCheckResult = { transcript: null, hint: null, pcm_audio_base64: null };
        const [audioResult, screenHint] = await Promise.all([
          audioListenRef.current
            ? invoke<AudioCheckResult>("check_learning_audio", { language }).catch(() => noAudio)
            : Promise.resolve(noAudio),
          screenWatchRef.current
            ? invoke<string | null>("check_screen_for_language", { language }).catch(() => null)
            : Promise.resolve(null),
        ]);

        // Feed transcript to the viewing assessment window
        if (audioResult.transcript) {
          invoke("append_transcript_window", { text: audioResult.transcript }).catch(() => {});
        }

        // NOTE: We intentionally do NOT inject raw PCM audio into the Realtime
        // session. The model treats input_audio as user speech, which confuses
        // it about the user's language (English mic vs Japanese anime audio).
        // Instead we use text transcripts + hints as silent context.
        const contextParts: string[] = [];

        if (audioResult.transcript) {
          contextParts.push(`Audio heard from speakers: "${audioResult.transcript}"`);
        }
        if (audioResult.hint) {
          contextParts.push(`Vocab note: ${audioResult.hint}`);
        }
        if (screenHint && !screenHint.startsWith("NONE")) {
          contextParts.push(`Screen: "${screenHint}"`);
        }

        // ── Watcher Loop (ambient agent) ─────────────────────────────
        // Only send audio to watch triggers if the Rust side confirmed it's
        // target-language content (hint !== null). When Whisper detects a
        // non-target language, hint is null and we skip watch evaluation to
        // prevent false positives from English audio being classified as Japanese.
        const audioText = (audioResult.transcript && audioResult.hint) ? audioResult.transcript : "";
        const screenText = screenHint && !screenHint.startsWith("NONE") ? screenHint : "";

        const { triggerCount } = await runWatchEvaluation({ audioText, screenText });
        if (triggerCount > 0) {
          console.log(`[watcher] ${triggerCount} trigger(s) fired`);
        }

        // Passive ambient context — Samuel can reference it when asked
        // ("what did they just say?") but won't speak proactively.
        if (contextParts.length > 0) {
          const contextMsg = contextParts.join(" | ");
          sendSilentContext(
            `[System: Ambient context — ${contextMsg}. ` +
            `You are passively listening. Do not speak unless prompted by the user or a trigger alert.]`,
          );
        }
      } catch (e) {
        console.error("[learning-mode] check error:", e);
      } finally {
        checkInFlightRef.current = false;
      }
    };

    // Immediate first check on connect — flush any pre-connect audio
    runCheck();

    const checkInterval = setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => {
      clearInterval(checkInterval);
      setActive(false);
    };
  }, [language, sessionStatus]);

  return {
    learningLanguage: language,
    learningActive: active,
    clearLearning,
  };
}
