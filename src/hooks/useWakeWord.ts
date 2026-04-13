import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type WakeWordState = "off" | "listening" | "processing" | "detected";

interface UseWakeWordOptions {
  enabled: boolean;
  onDetected: () => void;
}

// Common Whisper mistranscriptions of "Hey": hej (Swedish), hey, hay
const HEY_VARIANTS = ["hey", "hay", "hej", "hate"];
// Common Whisper mistranscriptions of "Samuel": samu, semi, samuell, samual, sammy
const SAMUEL_VARIANTS = ["samuel", "samual", "samuell", "samu", "sammy", "semi"];

function containsFullWakeWord(text: string): boolean {
  const lower = text.toLowerCase().replace(/[.,!?'"é]/g, "").trim();
  if (!lower) return false;

  // Direct matches: "hey samuel", "hej samu", etc.
  for (const hey of HEY_VARIANTS) {
    for (const sam of SAMUEL_VARIANTS) {
      if (lower.includes(`${hey} ${sam}`)) return true;
    }
  }
  // "hey sam" but not "same"
  for (const hey of HEY_VARIANTS) {
    if (lower.includes(`${hey} sam`) && !lower.includes("same")) return true;
  }
  // Standalone exact matches
  if (SAMUEL_VARIANTS.includes(lower)) return true;

  return false;
}

function containsHeyOnly(text: string): boolean {
  const lower = text.toLowerCase().replace(/[.,!?'"é]/g, "").trim();
  return HEY_VARIANTS.includes(lower);
}

function containsSamuelOnly(text: string): boolean {
  const lower = text.toLowerCase().replace(/[.,!?'"é]/g, "").trim();
  return (
    SAMUEL_VARIANTS.some((v) => lower.includes(v)) ||
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

      // Record + transcribe a short clip, returning the text
      async function transcribeClip(s: MediaStream, ms: number): Promise<string> {
        const clip = await recordClip(s, ms);
        if (!clip) return "";
        const buf = await clip.arrayBuffer();
        if (buf.byteLength < 500) return "";
        const bytes = new Uint8Array(buf);
        let raw = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          raw += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
        }
        const ext = clip.type.includes("webm") ? "webm" : "mp4";
        return invoke<string>("transcribe_audio", { audioBase64: btoa(raw), extension: ext });
      }

      // Verify a candidate detection with a second short clip
      async function confirmWake(s: MediaStream): Promise<boolean> {
        console.log("[wake] confirming with 2s verification clip...");
        const text = await transcribeClip(s, 2000);
        console.log(`[wake] confirm whisper: "${text}"`);
        // Accept if the confirmation clip has speech that also matches,
        // or is empty/short (user stopped talking after the wake phrase)
        const lower = text.toLowerCase().replace(/[.,!?'"]/g, "").trim();
        if (!lower || lower.length < 3) return true;
        // If Whisper picked up more speech that still mentions Samuel, confirm
        if (containsFullWakeWord(text) || containsSamuelOnly(text)) return true;
        // If it transcribed something completely unrelated (anime dialogue),
        // the original detection was likely a hallucination
        console.log("[wake] confirmation failed — likely hallucination");
        return false;
      }

      while (active) {
        const clipPromise = recordClip(stream, 2000);

        if (pendingTranscription) {
          try {
            const text = await pendingTranscription;
            console.log(`[wake] whisper: "${text}"`);

            if (active && containsFullWakeWord(text)) {
              // High-confidence: full "Hey Samuel" in one clip — skip confirmation
              console.log("[wake] >>> DETECTED (full match, fast path) <<<");
              setState("detected");
              onDetectedRef.current();
              return;
            }

            if (active && heardHey && Date.now() - heardHeyAt < 5000 && containsSamuelOnly(text)) {
              // Cross-clip match is lower confidence — still confirm
              if (await confirmWake(stream)) {
                console.log("[wake] >>> DETECTED (cross-clip, confirmed) <<<");
                setState("detected");
                onDetectedRef.current();
                return;
              }
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
