import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerLearningLanguage, sendTextAndRespond, sendSilentContext } from "../lib/session-bridge";
import type { ConnectionStatus } from "./useRealtime";
import type { VocabCardMode } from "../hooks/useUIPreferences";

const STORAGE_KEY = "samuel-learning-language";
const CHECK_INTERVAL_MS = 20_000;
const DEFAULT_PROACTIVE_GAP_MS = 45_000;
const MIN_REVIEW_WARMUP_MS = 2 * 60 * 1000;

interface AudioCheckResult {
  transcript: string | null;
  hint: string | null;
  clip_path: string | null;
}

export interface UseLearningModeReturn {
  learningLanguage: string | null;
  learningActive: boolean;
  clearLearning: () => void;
}

export function useLearningMode(
  sessionStatus: ConnectionStatus,
  vocabCardIntervalSec?: number,
  agentState?: "idle" | "listening" | "thinking" | "speaking",
  cardMode: VocabCardMode = "manual",
): UseLearningModeReturn {
  const proactiveGapMs = vocabCardIntervalSec
    ? vocabCardIntervalSec * 1000
    : DEFAULT_PROACTIVE_GAP_MS;

  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;
  const cardModeRef = useRef(cardMode);
  cardModeRef.current = cardMode;
  const proactiveGapRef = useRef(proactiveGapMs);
  proactiveGapRef.current = proactiveGapMs;

  const [language, setLanguage] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const [active, setActive] = useState(false);
  const checkInFlightRef = useRef(false);

  // Accumulates ambient context snippets for Samuel's periodic review
  const contextBufferRef = useRef<string[]>([]);

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

  // Tracks when the session started (for warmup gating)
  const sessionStartRef = useRef(0);

  // Main observation loop — checks BOTH audio and screen every cycle
  useEffect(() => {
    if (!language || sessionStatus !== "connected") {
      setActive(false);
      return;
    }

    setActive(true);
    sessionStartRef.current = Date.now();
    contextBufferRef.current = [];

    const runCheck = async () => {
      if (checkInFlightRef.current) return;
      // Suppress learning checks while Samuel is executing a tool or speaking.
      // Uses ref to avoid the interval being torn down on every state change.
      const state = agentStateRef.current;
      if (state === "thinking" || state === "speaking") return;
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

        // Feed transcript to the viewing assessment window
        if (audioResult.transcript) {
          invoke("append_transcript_window", { text: audioResult.transcript }).catch(() => {});
        }

        // Inject ONE combined silent context (replaces the previous one to keep
        // conversation lean — avoids flooding the Realtime session with dozens of
        // background messages that make the model unresponsive).
        const contextParts: string[] = [];
        if (audioResult.transcript) {
          contextParts.push(`Audio: "${audioResult.transcript}"`);
        }
        if (screenHint && !screenHint.startsWith("NONE")) {
          contextParts.push(`Screen: "${screenHint}"`);
        }
        if (contextParts.length > 0) {
          const contextMsg = contextParts.join(" | ");
          sendSilentContext(
            `[System: Ambient context — ${contextMsg}. Do NOT speak about this unless the user asks.]`,
          );
          // Accumulate for Samuel's periodic review (auto mode)
          contextBufferRef.current.push(contextMsg);
          if (contextBufferRef.current.length > 15) {
            contextBufferRef.current = contextBufferRef.current.slice(-15);
          }
        }
      } catch (e) {
        console.error("[learning-mode] check error:", e);
      } finally {
        checkInFlightRef.current = false;
      }
    };

    // Samuel review loop — in auto mode, periodically sends accumulated context
    // to Samuel and asks him to review for teaching opportunities. Samuel decides
    // what to highlight based on stored preferences (language, proficiency, goals).
    const runSamuelReview = () => {
      if (cardModeRef.current !== "auto") return;
      if (Date.now() - sessionStartRef.current < MIN_REVIEW_WARMUP_MS) return;

      const state = agentStateRef.current;
      if (state === "thinking" || state === "speaking") return;

      const buffer = contextBufferRef.current;
      if (buffer.length === 0) return;

      // Drain the buffer
      const snippets = buffer.splice(0, buffer.length);
      const contextText = snippets.join("\n");

      console.log(`[learning-mode] Samuel review: ${snippets.length} snippets`);

      sendTextAndRespond(
        `[System: Ambient review — You are in auto card mode. Review the recent ambient context below ` +
        `and decide if there's anything worth teaching the user (interesting words, phrases, or concepts ` +
        `in ${language}). Use show_word_card for vocabulary, or speak briefly for broader insights. ` +
        `Respect the user's proficiency level from memory. If nothing is interesting, stay silent — ` +
        `respond with just "Nothing notable." and do NOT speak to the user.\n\n${contextText}]`,
      );
    };

    // Immediate first check on connect — flush any pre-connect audio
    runCheck();

    // Observation loop every 20s
    const checkInterval = setInterval(runCheck, CHECK_INTERVAL_MS);
    // Samuel review runs at the user-configured interval (default ~45s),
    // gated by auto mode and warmup period
    const reviewInterval = setInterval(runSamuelReview, proactiveGapRef.current);

    return () => {
      clearInterval(checkInterval);
      clearInterval(reviewInterval);
      setActive(false);
    };
  }, [language, sessionStatus, proactiveGapMs]);

  return {
    learningLanguage: language,
    learningActive: active,
    clearLearning,
  };
}
