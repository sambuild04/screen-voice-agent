import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetchLyricsForYouTube, extractVideoId, type LyricsResult } from "../lib/lyrics";

export interface ContentLine {
  text: string;
  timestamp: number | null;
  source_index: number;
}

export interface VocabAnnotation {
  word: string;
  reading: string | null;
  meaning: string;
  line_index: number;
  level: string | null;
}

export interface GrammarAnnotation {
  pattern: string;
  explanation: string;
  example: string | null;
  line_index: number;
}

export interface AnnotatedContent {
  content_type: string;
  title: string | null;
  lines: ContentLine[];
  vocabulary: VocabAnnotation[];
  grammar: GrammarAnnotation[];
  summary: string | null;
  videoId?: string;
  synced?: boolean;
  /** Local path to downloaded audio file (YouTube songs) */
  audio_file?: string | null;
}

export type TeachState = "idle" | "input" | "processing" | "ready" | "error";

export interface UseTeachModeReturn {
  state: TeachState;
  content: AnnotatedContent | null;
  error: string | null;
  progress: string;
  openInput: () => void;
  closeInput: () => void;
  submit: (input: string, language?: string) => void;
  close: () => void;
  selectedLine: number | null;
  selectLine: (idx: number | null) => void;
}

function isYouTubeUrl(input: string): boolean {
  const t = input.trim();
  return t.includes("youtube.com/watch") || t.includes("youtu.be/");
}

export function useTeachMode(): UseTeachModeReturn {
  const [state, setState] = useState<TeachState>("idle");
  const [content, setContent] = useState<AnnotatedContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const busyRef = useRef(false);

  const openInput = useCallback(() => {
    if (state === "idle" || state === "error") {
      setState("input");
    }
  }, [state]);

  const closeInput = useCallback(() => {
    if (state === "input") {
      setState("idle");
    }
  }, [state]);

  const submit = useCallback((input: string, language?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    console.log("[teach] submitting:", input.slice(0, 80));
    setState("processing");
    setError(null);
    setContent(null);
    setSelectedLine(null);

    if (isYouTubeUrl(input)) {
      handleYouTube(input, language);
    } else {
      setProgress(input.trim().startsWith("http") ? "Fetching…" : "Processing…");
      handleGeneric(input, language);
    }
  }, []);

  // YouTube: oEmbed → LRCLIB → annotate (all API, no download)
  function handleYouTube(url: string, language?: string) {
    fetchLyricsForYouTube(url, setProgress)
      .then((result: LyricsResult) => {
        if (result.lines.length === 0) {
          // No lyrics found anywhere — fall back to backend yt-dlp+Whisper
          console.log("[teach] no lyrics found, falling back to Whisper");
          setProgress("Transcribing audio…");
          const vid = extractVideoId(url);
          return invoke<AnnotatedContent>("teach_from_content", {
            input: url,
            language: language ?? null,
          }).then((r) => ({
            ...r,
            videoId: vid ?? undefined,
            // Whisper segmented transcription now returns timestamps
            synced: r.lines.some((l) => l.timestamp !== null),
          }));
        }

        // Got lyrics — send to backend for annotation + download audio for playback
        console.log("[teach] got", result.lines.length, "lyric lines from", result.source);
        setProgress("Annotating…");

        const annotatePromise = invoke<AnnotatedContent>("annotate_lines", {
          lines: result.lines,
          contentType: "youtube",
          title: result.title,
          language: language ?? null,
        });
        // Download audio in parallel (non-blocking — playback works once it finishes)
        const audioPromise = invoke<string>("download_song_audio", { url })
          .catch((e) => { console.warn("[teach] audio download failed:", e); return null; });

        return Promise.all([annotatePromise, audioPromise]).then(([annotated, audioPath]) => ({
          ...annotated,
          videoId: result.videoId,
          synced: result.synced,
          audio_file: audioPath,
        }));
      })
      .then((result) => {
        if (result) {
          console.log("[teach] success:", result.lines.length, "lines");
          setContent(result as AnnotatedContent);
          setState("ready");
          setProgress("");
        }
      })
      .catch((e) => {
        console.error("[teach] error:", e);
        setError(String(e));
        setState("error");
        setProgress("");
      })
      .finally(() => {
        busyRef.current = false;
      });
  }

  // Non-YouTube: send to backend for full extraction + annotation
  function handleGeneric(input: string, language?: string) {
    invoke<AnnotatedContent>("teach_from_content", {
      input,
      language: language ?? null,
    })
      .then((result) => {
        console.log("[teach] success:", result.lines.length, "lines");
        setContent(result);
        setState("ready");
        setProgress("");
      })
      .catch((e) => {
        console.error("[teach] error:", e);
        setError(String(e));
        setState("error");
        setProgress("");
      })
      .finally(() => {
        busyRef.current = false;
      });
  }

  const close = useCallback(() => {
    setState("idle");
    setContent(null);
    setError(null);
    setSelectedLine(null);
    setProgress("");
  }, []);

  return {
    state,
    content,
    error,
    progress,
    openInput,
    closeInput,
    submit,
    close,
    selectedLine,
    selectLine: setSelectedLine,
  };
}
