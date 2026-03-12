import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RealtimeSession } from "@openai/agents/realtime";
import { samuelAgent } from "../lib/samuel";
import { registerSendImage } from "../lib/session-bridge";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "status";
  text: string;
  timestamp: number;
}

export interface UseRealtimeReturn {
  status: ConnectionStatus;
  transcript: TranscriptEntry[];
  agentState: "idle" | "listening" | "thinking" | "speaking";
  connect: () => Promise<void>;
  disconnect: () => void;
  mute: (muted: boolean) => void;
  isMuted: boolean;
  setWakeWordMode: (on: boolean) => void;
}

// Common hallucinations the transcriber produces from speaker echo / room reverb.
// Checked only within the echo guard window (first few seconds after agent speaks).
const ECHO_PHRASES = new Set([
  "thank you",
  "thanks",
  "you",
  "bye",
  "okay",
  "ok",
  "yes",
  "yeah",
  "no",
  "hmm",
  "hm",
  "hello",
  "hi",
  "hey",
  "good evening",
  "good morning",
  "good night",
  "sir",
  "chatgpt",
  "send me",
  "thank you sir",
  "thanks sir",
]);

let entryCounter = 0;
function makeEntry(
  role: TranscriptEntry["role"],
  text: string,
): TranscriptEntry {
  return { id: String(++entryCounter), role, text, timestamp: Date.now() };
}

export function useRealtime(): UseRealtimeReturn {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [agentState, setAgentState] = useState<
    "idle" | "listening" | "thinking" | "speaking"
  >("idle");
  const [isMuted, setIsMuted] = useState(false);

  const sessionRef = useRef<RealtimeSession | null>(null);

  // Streaming assistant buffer
  const assistantBufferRef = useRef("");
  const assistantEntryIdRef = useRef<string | null>(null);

  // Placeholder entry for the user's speech (inserted early so ordering is correct)
  const userPendingIdRef = useRef<string | null>(null);

  // Track whether the user manually muted so we don't override their choice
  const userMutedRef = useRef(false);

  // Echo guard: timestamp when agent last finished speaking.
  // Transcriptions arriving shortly after are likely echo, not real user speech.
  const lastAgentSpeechEndRef = useRef(0);

  // Wake word mode: after Samuel speaks, don't auto-unmute. Instead start an
  // inactivity timer. If user speaks within the window, keep going. If not,
  // mute mic and set agentState to "idle" (signals wake word should re-enable).
  const wakeWordModeRef = useRef(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  };

  const startInactivityTimer = () => {
    clearInactivityTimer();
    inactivityTimerRef.current = setTimeout(() => {
      // No user speech detected — go back to wake word mode
      if (wakeWordModeRef.current && sessionRef.current) {
        try { sessionRef.current.mute(true); } catch {}
        setIsMuted(true);
        setAgentState("idle");
      }
    }, 6000);
  };

  useEffect(() => {
    const session = new RealtimeSession(samuelAgent, {
      model: "gpt-realtime",
      config: {
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
              language: "en",
            },
            noiseReduction: { type: "far_field" },
            turnDetection: {
              type: "server_vad",
              threshold: 0.9,
              prefixPaddingMs: 300,
              silenceDurationMs: 1000,
            },
          },
          output: {
            voice: "ash",
          },
        },
      },
    });

    sessionRef.current = session;

    // Auto-mute mic while Samuel speaks to prevent echo feedback in WKWebView.
    // Unmute after a short delay once he finishes.
    session.on("audio_start", () => {
      setAgentState("speaking");
      if (!userMutedRef.current) {
        session.mute(true);
      }
    });

    session.on("audio_stopped", () => {
      setAgentState("listening");
      lastAgentSpeechEndRef.current = Date.now();
      if (!userMutedRef.current && session.muted === true) {
        // 1.5s buffer after agent finishes — room reverb and speaker tail need
        // time to die down before the mic reopens, otherwise the tail gets
        // transcribed as phantom user speech ("Thank you.", etc).
        setTimeout(() => {
          if (!userMutedRef.current && sessionRef.current) {
            try { sessionRef.current.mute(false); } catch {}
          }
          if (wakeWordModeRef.current) {
            startInactivityTimer();
          }
        }, 1500);
      }
    });

    session.on("agent_tool_start", () => setAgentState("thinking"));
    session.on("agent_tool_end", () => setAgentState("listening"));

    session.on("error", (error: unknown) => {
      console.error("[session] error:", error);
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Error: ${error}`),
      ]);
    });

    // Raw transport events for real-time transcript display
    session.transport.on("*", (event: Record<string, unknown>) => {
      const type = event.type as string;

      switch (type) {
        case "input_audio_buffer.speech_started": {
          setAgentState("listening");
          // User is speaking — cancel any inactivity timer (keep conversation alive)
          clearInactivityTimer();
          // Insert a placeholder now so the user bubble appears before the agent reply
          const placeholder = makeEntry("user", "...");
          userPendingIdRef.current = placeholder.id;
          setTranscript((prev) => [...prev, placeholder]);
          break;
        }

        case "input_audio_buffer.speech_stopped":
          setAgentState("thinking");
          break;

        case "conversation.item.input_audio_transcription.completed": {
          const text = (event.transcript as string)?.trim();
          const pendingId = userPendingIdRef.current;
          userPendingIdRef.current = null;

          const isNoise = !text || text.length <= 2;

          // Echo guard: if transcription arrives within 3s of the agent
          // finishing speech and the text is short/generic, it's almost
          // certainly the mic picking up speaker output or room reverb.
          const msSinceAgentSpoke = Date.now() - lastAgentSpeechEndRef.current;
          const isLikelyEcho =
            msSinceAgentSpoke < 3000 &&
            !!text &&
            (text.length < 30 || ECHO_PHRASES.has(text.toLowerCase().replace(/[.!?,]/g, "")));

          if (isNoise || isLikelyEcho) {
            if (isLikelyEcho) {
              console.log(`[echo-guard] dropped "${text}" (${msSinceAgentSpoke}ms after agent)`);
            }
            if (pendingId) {
              setTranscript((prev) => prev.filter((e) => e.id !== pendingId));
            }
            break;
          }

          if (pendingId) {
            setTranscript((prev) =>
              prev.map((e) => (e.id === pendingId ? { ...e, text } : e)),
            );
          } else {
            setTranscript((prev) => [...prev, makeEntry("user", text)]);
          }
          break;
        }

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta": {
          const delta = event.delta as string;
          if (delta) {
            setAgentState("speaking");
            assistantBufferRef.current += delta;
            if (!assistantEntryIdRef.current) {
              const entry = makeEntry(
                "assistant",
                assistantBufferRef.current,
              );
              assistantEntryIdRef.current = entry.id;
              setTranscript((prev) => [...prev, entry]);
            } else {
              const id = assistantEntryIdRef.current;
              const text = assistantBufferRef.current;
              setTranscript((prev) =>
                prev.map((e) => (e.id === id ? { ...e, text } : e)),
              );
            }
          }
          break;
        }

        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done": {
          const finalText = event.transcript as string;
          if (finalText && assistantEntryIdRef.current) {
            const id = assistantEntryIdRef.current;
            setTranscript((prev) =>
              prev.map((e) =>
                e.id === id ? { ...e, text: finalText } : e,
              ),
            );
          }
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          break;
        }

        case "response.done":
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          setAgentState("listening");
          break;

        case "error": {
          const err = event.error as Record<string, unknown>;
          const msg = (err?.message as string) ?? "Unknown error";
          setTranscript((prev) => [
            ...prev,
            makeEntry("status", `Error: ${msg}`),
          ]);
          break;
        }

        default:
          break;
      }
    });

    // Register the image bridge so tools can inject screenshots
    registerSendImage((base64Jpeg: string) => {
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${base64Jpeg}`,
            },
          ],
        },
      });
    });

    return () => {
      registerSendImage(null);
      session.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    if (status === "connected") return;

    setStatus("connecting");
    setTranscript([makeEntry("status", "Connecting...")]);

    try {
      const ephemeralKey = await invoke<string>("create_ephemeral_key");
      await session.connect({ apiKey: ephemeralKey });

      setStatus("connected");
      setAgentState("listening");
      setTranscript([makeEntry("status", "Connected")]);

      // Pre-mute before greeting so the mic can't pick up the very start
      session.mute(true);
      // Trigger Samuel's greeting (no visible user message)
      session.transport.sendEvent({ type: "response.create" });
    } catch (err) {
      console.error("[connect]", err);
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Connection failed: ${err}`),
      ]);
      setStatus("disconnected");
      setAgentState("idle");
    }
  }, [status]);

  const disconnect = useCallback(() => {
    registerSendImage(null);
    sessionRef.current?.close();
    setStatus("disconnected");
    setAgentState("idle");
    setIsMuted(false);
    userMutedRef.current = false;
    setTranscript((prev) => [...prev, makeEntry("status", "Disconnected.")]);
  }, []);

  const mute = useCallback((muted: boolean) => {
    const session = sessionRef.current;
    userMutedRef.current = muted;
    if (session && session.muted !== null) {
      session.mute(muted);
    }
    setIsMuted(muted);
  }, []);

  const setWakeWordMode = useCallback((on: boolean) => {
    wakeWordModeRef.current = on;
    if (!on) clearInactivityTimer();
  }, []);

  return {
    status,
    transcript,
    agentState,
    connect,
    disconnect,
    mute,
    isMuted,
    setWakeWordMode,
  };
}
