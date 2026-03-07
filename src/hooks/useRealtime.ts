import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RealtimeSession } from "@openai/agents/realtime";
import { samuelAgent } from "../lib/samuel";

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
}

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
      if (!userMutedRef.current && session.muted === true) {
        // 500ms buffer after agent finishes speaking so tail-end audio doesn't echo back
        setTimeout(() => {
          if (!userMutedRef.current && sessionRef.current) {
            try { sessionRef.current.mute(false); } catch {}
          }
        }, 500);
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

          if (!text || text.length <= 2) {
            // Noise/echo — remove the placeholder
            if (pendingId) {
              setTranscript((prev) => prev.filter((e) => e.id !== pendingId));
            }
            break;
          }

          if (pendingId) {
            // Replace the placeholder with the real transcription
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

    return () => {
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

  return {
    status,
    transcript,
    agentState,
    connect,
    disconnect,
    mute,
    isMuted,
  };
}
