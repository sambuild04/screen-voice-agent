import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerRecordingAction, sendTextToSession } from "../lib/session-bridge";

export interface ScriptLine {
  timestamp: string;
  text: string;
}

export interface VocabEntry {
  word: string;
  reading: string;
  meaning: string;
  level: string;
}

export interface GrammarPoint {
  pattern: string;
  explanation: string;
  examples: string[];
}

export interface TranslatedLine {
  timestamp: string;
  text: string;
}

export interface RecordingAnalysis {
  transcript: ScriptLine[];
  translated_transcript: TranslatedLine[];
  vocabulary: VocabEntry[];
  grammar: GrammarPoint[];
  summary: string;
}

export type RecordingState = "idle" | "recording" | "processing" | "results";

export type AnalysisStage = "transcribing" | "analyzing" | "done";

export function useRecordMode() {
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [analysis, setAnalysis] = useState<RecordingAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [analysisStage, setAnalysisStage] = useState<AnalysisStage | null>(null);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analysisTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (state === "recording" || state === "processing") return;
    setError(null);
    setAnalysis(null);

    try {
      await invoke("start_recording");
      setState("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } catch (e) {
      setError(String(e));
    }
  }, [state]);

  const clearAnalysisTimer = useCallback(() => {
    if (analysisTimerRef.current) {
      clearInterval(analysisTimerRef.current);
      analysisTimerRef.current = null;
    }
  }, []);

  // Transcribe the recording in the background and give the raw transcript to Samuel.
  // No auto-analysis — the user tells Samuel what to do with it.
  const runTranscription = useCallback(() => {
    setAnalysisStage("transcribing");
    setAnalysisElapsed(0);

    analysisTimerRef.current = setInterval(() => {
      setAnalysisElapsed((prev) => prev + 1);
    }, 1000);

    (async () => {
      try {
        const transcript = await invoke<string>("transcribe_recording");
        clearAnalysisTimer();
        setAnalysisStage("done");
        setState("idle");

        if (!transcript.trim()) {
          sendTextToSession(
            "[System: Recording transcript ready — no speech was detected. Let the user know.]",
          );
          return;
        }

        sendTextToSession(
          "[System: Recording transcript ready. The full transcript is below. " +
          "Do NOT auto-analyze or summarize — let the user know the transcript is ready " +
          "and wait for them to tell you what to do with it (summarize, find specific info, " +
          "break down grammar, translate, fact-check, etc.).\n\n" +
          `Transcript:\n${transcript}]`,
        );
      } catch (e) {
        clearAnalysisTimer();
        setAnalysisStage(null);
        setError(String(e));
        setState("idle");
      }
    })();
  }, [clearAnalysisTimer]);

  const stopRecording = useCallback(async () => {
    if (state !== "recording") return;
    clearTimer();
    setState("processing");

    try {
      await invoke("stop_recording");
      // Transcribe in background — Samuel waits for user to ask about it
      runTranscription();
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  }, [state, clearTimer, runTranscription]);

  const dismiss = useCallback(() => {
    setPanelOpen(false);
  }, []);

  const togglePanel = useCallback(() => {
    if (analysis) setPanelOpen((prev) => !prev);
  }, [analysis]);

  const clearAnalysis = useCallback(() => {
    clearAnalysisTimer();
    setAnalysis(null);
    setPanelOpen(false);
    setAnalysisStage(null);
    setAnalysisElapsed(0);
    setState("idle");
    setElapsed(0);
    setError(null);
  }, [clearAnalysisTimer]);

  // Register bridge so voice tools (samuel.ts) can drive recording state
  useEffect(() => {
    registerRecordingAction((action, payload) => {
      switch (action) {
        case "start":
          setState("recording");
          setElapsed(0);
          setError(null);
          setAnalysis(null);
          timerRef.current = setInterval(() => {
            setElapsed((prev) => prev + 1);
          }, 1000);
          break;
        case "processing":
          clearTimer();
          setState("processing");
          // Show progress bar immediately while the recording file finalizes.
          // The voice tool sends "analyze" once the file is ready.
          setAnalysisStage("transcribing");
          setAnalysisElapsed(0);
          clearAnalysisTimer();
          analysisTimerRef.current = setInterval(() => {
            setAnalysisElapsed((prev) => {
              if (prev >= 14) setAnalysisStage("analyzing");
              return prev + 1;
            });
          }, 1000);
          break;
        case "analyze":
          // Recording file is finalized — safe to start transcription
          runTranscription();
          break;
        case "results":
          setState("results");
          setAnalysis(payload as RecordingAnalysis);
          break;
        case "error":
          clearTimer();
          setError(String(payload));
          setState("idle");
          break;
        case "stop":
          clearTimer();
          setState("idle");
          break;
      }
    });
    return () => {
      registerRecordingAction(null);
      clearTimer();
      clearAnalysisTimer();
    };
  }, [clearTimer, clearAnalysisTimer]);

  return {
    recordingState: state,
    elapsed,
    analysis,
    panelOpen,
    analysisStage,
    analysisElapsed,
    error,
    startRecording,
    stopRecording,
    dismiss,
    togglePanel,
    clearAnalysis,
  };
}
