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

  // Run analysis in the background — doesn't block the conversation
  const runAnalysisInBackground = useCallback(() => {
    setAnalysisStage("transcribing");
    setAnalysisElapsed(0);

    // Tick every second + estimate stage transitions:
    // ~15s for Whisper transcription, then GPT-4o analysis kicks in
    analysisTimerRef.current = setInterval(() => {
      setAnalysisElapsed((prev) => {
        if (prev >= 14) setAnalysisStage("analyzing");
        return prev + 1;
      });
    }, 1000);

    (async () => {
      try {
        const result = await invoke<RecordingAnalysis>("analyze_recording");
        clearAnalysisTimer();
        setAnalysisStage("done");
        setAnalysis(result);
        setState("results");
        setPanelOpen(true);

        // Notify Samuel casually — conversation continues naturally
        const transcriptText = result.transcript
          .map((l) => `[${l.timestamp}] ${l.text}`)
          .join("\n");
        const vocabText = result.vocabulary
          .map((v) => `${v.word} (${v.reading}) — ${v.meaning} [${v.level}]`)
          .join("\n");
        const grammarText = result.grammar
          .map((g) => `${g.pattern}: ${g.explanation}`)
          .join("\n");

        sendTextToSession(
          "[System: A language analysis just completed in the background and is now visible on the user's screen. " +
          "Casually let them know — something like 'By the way sir, the language breakdown from that clip is ready on screen.' " +
          "Then briefly mention 1-2 highlights. Don't read the whole analysis. Keep it natural — the user may be mid-conversation about something else. " +
          "Here is the full context for follow-up questions:]\n\n" +
          `Summary: ${result.summary}\n\nTranscript:\n${transcriptText}\n\nVocabulary:\n${vocabText}\n\nGrammar:\n${grammarText}`
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
      // Analysis runs in background — conversation continues immediately
      runAnalysisInBackground();
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  }, [state, clearTimer, runAnalysisInBackground]);

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
          // Recording file is finalized — safe to start analysis
          runAnalysisInBackground();
          break;
        case "results":
          setState("results");
          setAnalysis(payload as RecordingAnalysis);
          setPanelOpen(true);
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
