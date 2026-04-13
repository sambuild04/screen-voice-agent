import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface UseAudioPlayerReturn {
  isReady: boolean;
  seekAndPlay: (startSec: number, endSec: number) => Promise<void>;
  pause: () => void;
}

/**
 * Loads a local audio file (via Tauri base64 bridge) into an HTML5 Audio
 * element and provides seek-and-play-to-end controls.
 */
export function useAudioPlayer(audioFilePath: string | null): UseAudioPlayerReturn {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isReady, setIsReady] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    resolveRef.current = null;
  }, []);

  useEffect(() => {
    if (!audioFilePath) return;

    let cancelled = false;
    setIsReady(false);

    (async () => {
      try {
        console.log("[audio-player] loading", audioFilePath);
        const b64 = await invoke<string>("read_audio_base64", { path: audioFilePath });
        if (cancelled) return;

        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "audio/mp4" });
        const url = URL.createObjectURL(blob);

        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url;

        const audio = new Audio(url);
        audio.preload = "auto";
        audioRef.current = audio;

        audio.addEventListener("canplaythrough", () => {
          if (!cancelled) {
            console.log(`[audio-player] ready (duration=${audio.duration.toFixed(1)}s)`);
            setIsReady(true);
          }
        }, { once: true });

        audio.addEventListener("error", (e) => {
          console.error("[audio-player] error", e);
        });
      } catch (err) {
        console.error("[audio-player] failed to load audio:", err);
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
      audioRef.current?.pause();
      audioRef.current = null;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setIsReady(false);
    };
  }, [audioFilePath, cleanup]);

  const seekAndPlay = useCallback(
    (startSec: number, endSec: number): Promise<void> => {
      return new Promise<void>((resolve) => {
        const audio = audioRef.current;
        if (!audio) {
          console.warn("[audio-player] seekAndPlay: no audio loaded");
          resolve();
          return;
        }

        cleanup();

        audio.currentTime = startSec;
        audio.play().catch((e) => {
          console.error("[audio-player] play failed:", e);
          resolve();
        });
        console.log(`[audio-player] playing ${startSec.toFixed(1)}s → ${endSec.toFixed(1)}s`);

        pollRef.current = setInterval(() => {
          if (audio.currentTime >= endSec - 0.1 || audio.paused || audio.ended) {
            audio.pause();
            cleanup();
            console.log(`[audio-player] segment done at ${audio.currentTime.toFixed(1)}s`);
            resolve();
          }
        }, 100);

        resolveRef.current = resolve;
      });
    },
    [cleanup],
  );

  const pause = useCallback(() => {
    cleanup();
    audioRef.current?.pause();
  }, [cleanup]);

  return { isReady, seekAndPlay, pause };
}
