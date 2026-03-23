import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type WakeWordState = "off" | "listening" | "processing" | "detected";

interface UseWakeWordOptions {
  enabled: boolean;
  onDetected: () => void;
}

function containsFullWakeWord(text: string): boolean {
  const lower = text.toLowerCase().replace(/[.,!?'"]/g, "").trim();
  if (!lower) return false;
  return (
    lower.includes("hey samuel") ||
    lower.includes("hay samuel") ||
    lower.includes("hey samual") ||
    lower.includes("hey samuell") ||
    (lower.includes("hey sam") && !lower.includes("same"))
  );
}

function containsHeyOnly(text: string): boolean {
  const lower = text.toLowerCase().replace(/[.,!?'"]/g, "").trim();
  return lower === "hey" || lower === "hay" || lower === "hate" || lower === "hey.";
}

function containsSamuelOnly(text: string): boolean {
  const lower = text.toLowerCase().replace(/[.,!?'"]/g, "").trim();
  return (
    lower.includes("samuel") ||
    lower.includes("samual") ||
    lower.includes("samuell") ||
    (lower.includes("sam") && !lower.includes("same") && !lower.includes("sample"))
  );
}

/**
 * Wake word detection: records 3s clips in a loop, sends to Whisper,
 * checks for "Hey Samuel". Uses a partial-match buffer so "Hey" in
 * one clip + "Samuel" in the next still triggers detection.
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

      console.log("[wake] mic acquired, starting continuous listen loop");
      setState("listening");

      let heardHey = false;
      let heardHeyAt = 0;
      let pendingTranscription: Promise<string> | null = null;

      while (active) {
        // Start recording and transcription in parallel — the next clip
        // records while the previous one is being transcribed, so there's
        // never a gap in listening.
        const clipPromise = recordClip(stream, 3000);

        // Process the pending transcription result (if any) while recording
        if (pendingTranscription) {
          try {
            const text = await pendingTranscription;
            console.log(`[wake] whisper: "${text}"`);

            if (active && containsFullWakeWord(text)) {
              console.log("[wake] >>> DETECTED (full match) <<<");
              setState("detected");
              onDetectedRef.current();
              return;
            }

            if (active && heardHey && Date.now() - heardHeyAt < 5000 && containsSamuelOnly(text)) {
              console.log("[wake] >>> DETECTED (cross-clip: Hey + Samuel) <<<");
              setState("detected");
              onDetectedRef.current();
              return;
            }

            if (containsHeyOnly(text)) {
              heardHey = true;
              heardHeyAt = Date.now();
            } else if (!containsSamuelOnly(text)) {
              heardHey = false;
            }
          } catch (err) {
            console.error("[wake] error:", err);
          }
        }

        // Wait for the current clip to finish recording
        const clip = await clipPromise;
        if (!active || !clip) break;

        const arrayBuf = await clip.arrayBuffer();
        if (arrayBuf.byteLength < 500) {
          pendingTranscription = null;
          continue;
        }

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

        // Fire off transcription — it runs while the next clip records
        pendingTranscription = invoke<string>("transcribe_audio", {
          audioBase64: base64,
          extension: ext,
        });
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
