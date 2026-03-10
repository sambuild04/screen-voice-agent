import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type WakeWordState = "off" | "listening" | "processing" | "detected";

interface UseWakeWordOptions {
  enabled: boolean;
  onDetected: () => void;
}

function containsWakeWord(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  return (
    lower.includes("hey samuel") ||
    lower.includes("hay samuel") ||
    lower.includes("hey, samuel") ||
    lower.includes("hey samual") ||
    lower.includes("hey samuell") ||
    lower.includes("a samuel") ||
    lower.includes("hey, sam") ||
    (lower.includes("samuel") && lower.length < 40) ||
    (lower.includes("hey sam") && !lower.includes("same") && lower.length < 30)
  );
}

/**
 * Dead-simple wake word: MediaRecorder records 3s clips in a loop,
 * each clip sent to Whisper API, checked for "Hey Samuel".
 */
export function useWakeWord({ enabled, onDetected }: UseWakeWordOptions) {
  const [state, setState] = useState<WakeWordState>("off");
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const cleanupRef = useRef<(() => void) | null>(null);

  const stopListening = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setState("off");
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopListening();
      return;
    }

    let active = true;
    let stream: MediaStream | null = null;

    async function run() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.error("[wake] mic denied:", err);
        setState("off");
        return;
      }

      if (!active) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      console.log("[wake] mic acquired, starting record loop");
      setState("listening");

      while (active) {
        // Record a 3-second clip
        const clip = await recordClip(stream, 3000);
        if (!active || !clip) break;

        // Convert to base64
        const arrayBuf = await clip.arrayBuffer();
        if (arrayBuf.byteLength < 500) continue; // too small

        const bytes = new Uint8Array(arrayBuf);
        let raw = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          raw += String.fromCharCode(
            ...bytes.subarray(i, Math.min(i + 8192, bytes.length)),
          );
        }
        const base64 = btoa(raw);
        const ext = clip.type.includes("webm") ? "webm" : "mp4";

        console.log(
          `[wake] recorded ${(arrayBuf.byteLength / 1024).toFixed(1)}KB (${clip.type})`,
        );
        setState("processing");

        try {
          const text = await invoke<string>("transcribe_audio", {
            audioBase64: base64,
            extension: ext,
          });

          console.log(`[wake] whisper: "${text}"`);

          if (active && containsWakeWord(text)) {
            console.log("[wake] >>> DETECTED <<<");
            setState("detected");
            onDetectedRef.current();
            return;
          }
        } catch (err) {
          console.error("[wake] error:", err);
        }

        if (active) setState("listening");
        // Brief pause before next recording
        await sleep(200);
      }
    }

    run();

    const cleanup = () => {
      active = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
    cleanupRef.current = cleanup;
    return cleanup;
  }, [enabled, stopListening]);

  return { state };
}

function recordClip(stream: MediaStream, durationMs: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;

    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      resolve(null);
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };

    recorder.onerror = () => resolve(null);

    recorder.start();
    setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, durationMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
