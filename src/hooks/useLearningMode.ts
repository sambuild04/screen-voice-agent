import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerLearningLanguage, sendTextAndRespond, sendSilentContext } from "../lib/session-bridge";
import type { ConnectionStatus } from "./useRealtime";
import type { Suggestion } from "../components/PassiveSuggestion";

const STORAGE_KEY = "samuel-learning-language";
const CHECK_INTERVAL_MS = 20_000; // check every 20s — fast enough to feel present
const MIN_PROACTIVE_GAP_MS = 45_000; // at least 45s between proactive speech

interface TriageDecision {
  classification: string;
  confidence: number;
  message: string;
}

interface AudioCheckResult {
  transcript: string | null;
  hint: string | null;
  clip_path: string | null;
}

export interface UseLearningModeReturn {
  learningLanguage: string | null;
  learningActive: boolean;
  clearLearning: () => void;
  passiveSuggestion: Suggestion | null;
  dismissSuggestion: () => void;
  elaborateSuggestion: () => void;
}

export function useLearningMode(sessionStatus: ConnectionStatus): UseLearningModeReturn {
  const [language, setLanguage] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const [active, setActive] = useState(false);
  const [passiveSuggestion, setPassiveSuggestion] = useState<Suggestion | null>(null);
  const checkInFlightRef = useRef(false);
  const lastProactiveRef = useRef(0);

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

  const dismissSuggestion = useCallback(() => {
    setPassiveSuggestion(null);
  }, []);

  const elaborateSuggestion = useCallback(() => {
    const s = passiveSuggestion;
    setPassiveSuggestion(null);
    if (s) {
      sendTextAndRespond(
        `[System: The user wants to know more about this: ${s.text}. Explain in detail.]`,
      );
    }
  }, [passiveSuggestion]);

  useEffect(() => {
    registerLearningLanguage(updateLanguage);
    return () => registerLearningLanguage(null);
  }, [updateLanguage]);

  // Audio recorder runs whenever learning language is set — independent of session.
  // Captures audio even before Samuel is awake.
  useEffect(() => {
    if (language) {
      invoke("start_learning_audio").catch((e) =>
        console.warn("[learning-mode] failed to start audio:", e),
      );
    } else {
      invoke("stop_learning_audio").catch(() => {});
    }
    return () => {
      invoke("stop_learning_audio").catch(() => {});
    };
  }, [language]);

  // Main observation loop — checks BOTH audio and screen every cycle
  useEffect(() => {
    if (!language || sessionStatus !== "connected") {
      setActive(false);
      return;
    }

    setActive(true);

    const runCheck = async () => {
      if (checkInFlightRef.current) return;
      checkInFlightRef.current = true;

      try {
        // Run audio and screen checks in parallel
        const [audioResult, screenHint] = await Promise.all([
          invoke<AudioCheckResult>("check_learning_audio", { language }).catch(
            () => ({ transcript: null, hint: null, clip_path: null }) as AudioCheckResult,
          ),
          invoke<string | null>("check_screen_for_language", { language }).catch(
            () => null,
          ),
        ]);

        // Always inject raw context so Samuel "knows" what's happening
        if (audioResult.transcript) {
          sendSilentContext(
            `[System: Background audio — you just overheard: "${audioResult.transcript}". ` +
            `This is ambient context. Do NOT speak about it unless the user asks.]`,
          );
        }
        if (screenHint && !screenHint.startsWith("NONE")) {
          sendSilentContext(
            `[System: Screen observation — you just noticed: "${screenHint}". ` +
            `This is ambient context. Do NOT speak about it unless the user asks.]`,
          );
        }

        // Pick the best hint for proactive speech (prefer audio, fall back to screen)
        const bestHint = audioResult.hint || screenHint;
        const bestSource = audioResult.hint ? "audio" : "screen";

        if (!bestHint) return;

        // Proactive speech gating
        const attention = await invoke<string>("get_attention_state");
        if (attention === "focused") return;

        const now = Date.now();
        if (now - lastProactiveRef.current < MIN_PROACTIVE_GAP_MS) return;

        const decision = await invoke<TriageDecision>("triage_observation", {
          observation: bestHint,
          source: bestSource,
          language,
        });

        // All ambient observations go through the vocab card — Samuel never
        // speaks unprompted about screen/audio content. The user taps "Explain"
        // on the card if they want to hear it.
        if (
          (decision.classification === "act" && decision.confidence > 0.65) ||
          (decision.classification === "notify" && decision.confidence > 0.5)
        ) {
          lastProactiveRef.current = Date.now();
          setPassiveSuggestion({
            text: decision.message,
            source: bestSource,
            confidence: decision.confidence,
            clipPath: audioResult.clip_path ?? undefined,
            transcript: audioResult.transcript ?? undefined,
          });
        }
      } catch (e) {
        console.error("[learning-mode] check error:", e);
      } finally {
        checkInFlightRef.current = false;
      }
    };

    // Immediate first check on connect — flush any pre-connect audio
    runCheck();

    // Then check every CHECK_INTERVAL_MS — setInterval is more robust than recursive setTimeout
    const interval = setInterval(runCheck, CHECK_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      setActive(false);
    };
  }, [language, sessionStatus]);

  return {
    learningLanguage: language,
    learningActive: active,
    clearLearning,
    passiveSuggestion,
    dismissSuggestion,
    elaborateSuggestion,
  };
}
