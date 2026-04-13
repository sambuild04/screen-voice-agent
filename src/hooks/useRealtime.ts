import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import { samuelAgent } from "../lib/samuel";
import { registerSendImage, registerSendText, registerScreenTarget, registerSendSilentContext, registerSendTextAndRespond, registerReloadPlugins, notifyLearningLanguage } from "../lib/session-bridge";
import { loadAllPlugins } from "../lib/plugin-loader";
import type { FunctionTool } from "@openai/agents/realtime";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

/** Merge core + plugin tools, letting plugins override core tools by name. */
function mergeTools(coreTools: FunctionTool[], pluginTools: FunctionTool[]): FunctionTool[] {
  const pluginNames = new Set(pluginTools.map((t) => t.name));
  const filtered = coreTools.filter((t) => !pluginNames.has(t.name));
  return [...filtered, ...pluginTools];
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "status";
  text: string;
  timestamp: number;
}

// Session keepalive & rotation constants
const HEARTBEAT_INTERVAL_MS = 30_000; // ping every 30s to prevent server-side idle timeout
const SESSION_ROTATION_MS = 25 * 60 * 1000; // reconnect every 25 min (before 60-min hard cap)
const CONTEXT_WINDOW_TURNS = 6; // carry this many turns across reconnections

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface UseRealtimeReturn {
  status: ConnectionStatus;
  transcript: TranscriptEntry[];
  agentState: "idle" | "listening" | "thinking" | "speaking";
  screenTarget: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  mute: (muted: boolean) => void;
  isMuted: boolean;
  setWakeWordMode: (on: boolean) => void;
  setSuppressIdle: (suppress: boolean) => void;
  prefetchKey: () => void;
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
  "good day",
  "good day sir",
  "good evening sir",
  "good morning sir",
  "sir",
  "chatgpt",
  "send me",
  "thank you sir",
  "thanks sir",
  "at your service",
  "how may i",
  "how may i assist",
  "how may i assist you",
  "how may i be of assistance",
  "how can i help",
  "how can i assist",
  "samuel",
  "samly",
  "kit",
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
  const [screenTarget, setScreenTarget] = useState<string | null>(null);
  const screenTargetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);

  // Conversation context buffer — carried across reconnections
  const contextRef = useRef<ConversationTurn[]>([]);

  // Timers for keepalive and session rotation
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRotatingRef = useRef(false);

  // Pre-fetched ephemeral key — start the API call before connect() to overlap latency
  const prefetchedKeyRef = useRef<Promise<string> | null>(null);

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

  // Keep track of the last full agent response text — used to detect echo that
  // partially repeats what Samuel just said.
  const lastAgentTextRef = useRef("");

  // Count completed agent responses. The first response is always the greeting —
  // any VAD trigger immediately after it is guaranteed to be echo, not user speech.
  const agentResponseCountRef = useRef(0);

  // True while a response is being generated (audio may still be playing).
  // Mic stays muted until this goes false + delay, preventing mid-sentence cutoff.
  const responseInProgressRef = useRef(false);

  // Wake word mode: after Samuel speaks, don't auto-unmute. Instead start an
  // inactivity timer. If user speaks within the window, keep going. If not,
  // mute mic and set agentState to "idle" (signals wake word should re-enable).
  const wakeWordModeRef = useRef(false);
  const suppressIdleRef = useRef(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  };

  // No client-side inactivity timer — once awake, Samuel stays listening.
  const startInactivityTimer = () => {};

  const stopKeepalive = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (rotationTimerRef.current) {
      clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
  }, []);

  // Record a conversation turn into the rolling context buffer
  const recordTurn = useCallback((role: "user" | "assistant", text: string) => {
    if (!text.trim()) return;
    contextRef.current.push({ role, text });
    if (contextRef.current.length > CONTEXT_WINDOW_TURNS) {
      contextRef.current = contextRef.current.slice(-CONTEXT_WINDOW_TURNS);
    }
  }, []);

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
              silenceDurationMs: 1200,
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
    // Mic stays muted until response.done + delay (not audio_stopped) so the
    // full sentence plays without risk of VAD-triggered cancellation mid-speech.
    session.on("audio_start", () => {
      setAgentState("speaking");
      responseInProgressRef.current = true;
      if (!userMutedRef.current) {
        session.mute(true);
      }
    });

    session.on("audio_stopped", () => {
      lastAgentSpeechEndRef.current = Date.now();
      // Don't unmute here — wait for response.done to ensure full playback
      if (!responseInProgressRef.current) {
        setAgentState("listening");
      }
    });

    session.on("agent_tool_start", () => setAgentState("thinking"));
    session.on("agent_tool_end", () => setAgentState("listening"));

    session.on("error", (error: unknown) => {
      console.error("[session] error:", error);
      const msg =
        typeof error === "object" && error !== null
          ? JSON.stringify(error, null, 2)
          : String(error);
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Error: ${msg}`),
      ]);
    });

    // Detect server-side session close (idle timeout, network drop, etc.)
    // so the next wake word triggers a fresh reconnect.
    // Handled via transport wildcard events ("session.closed" / "close").

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

          // Echo guard: transcriptions arriving shortly after agent speech are
          // likely the mic picking up speaker output / room reverb.
          // Greeting window is extra wide (8s) because WebRTC echo cancellation
          // has no reference data yet. During that window, also drop anything
          // under 50 chars — greeting echoes are always short fragments.
          const msSinceAgentSpoke = Date.now() - lastAgentSpeechEndRef.current;
          const isGreetingWindow = agentResponseCountRef.current <= 1;
          const echoWindow = isGreetingWindow ? 8000 : 4000;
          const normalized = text ? text.toLowerCase().replace(/[.!?,'"]/g, "").trim() : "";

          // Check if the transcription is a partial echo of what Samuel just said
          const lastAgentLower = lastAgentTextRef.current.toLowerCase();
          const isPartialEcho = normalized.length > 3 && lastAgentLower.includes(normalized);

          const isLikelyEcho =
            msSinceAgentSpoke < echoWindow &&
            !!text &&
            (
              (isGreetingWindow && text.length < 50) ||
              text.length < 30 ||
              ECHO_PHRASES.has(normalized) ||
              isPartialEcho
            );

          if (isNoise || isLikelyEcho) {
            if (isLikelyEcho) {
              console.log(`[echo-guard] dropped "${text}" (${msSinceAgentSpoke}ms after agent)`);
            }
            if (pendingId) {
              setTranscript((prev) => prev.filter((e) => e.id !== pendingId));
            }
            break;
          }

          recordTurn("user", text);
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
          if (finalText) {
            lastAgentTextRef.current = finalText;
            recordTurn("assistant", finalText);
            if (assistantEntryIdRef.current) {
              const id = assistantEntryIdRef.current;
              setTranscript((prev) =>
                prev.map((e) =>
                  e.id === id ? { ...e, text: finalText } : e,
                ),
              );
            }
          }
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          break;
        }

        case "response.done": {
          // Finalize the transcript entry
          if (assistantBufferRef.current && assistantEntryIdRef.current) {
            lastAgentTextRef.current = assistantBufferRef.current;
          }
          assistantBufferRef.current = "";
          assistantEntryIdRef.current = null;
          agentResponseCountRef.current += 1;
          responseInProgressRef.current = false;
          setAgentState("listening");

          // NOW unmute — the full response has been generated and audio
          // buffers are flushing. Delay lets remaining audio play out.
          if (!userMutedRef.current && session.muted === true) {
            const isGreeting = agentResponseCountRef.current <= 1;
            const unmuteDelay = isGreeting ? 3000 : 1500;
            setTimeout(() => {
              if (!userMutedRef.current && sessionRef.current) {
                try { sessionRef.current.mute(false); } catch {}
              }
              if (wakeWordModeRef.current) {
                startInactivityTimer();
              }
            }, unmuteDelay);
          }
          break;
        }

        case "error": {
          const err = event.error as Record<string, unknown>;
          const msg = (err?.message as string) ?? "Unknown error";
          setTranscript((prev) => [
            ...prev,
            makeEntry("status", `Error: ${msg}`),
          ]);
          break;
        }

        case "session.closed":
        case "close": {
          stopKeepalive();
          if (isRotatingRef.current) {
            // Planned rotation — reconnect() handles the rest
            console.log("[session] planned rotation close");
          } else {
            // Unexpected drop — auto-reconnect if we were connected
            console.log("[session] transport closed unexpectedly, will auto-reconnect");
            setStatus("disconnected");
            setAgentState("idle");
            // Auto-reconnect after a short delay
            setTimeout(() => {
              if (sessionRef.current) {
                console.log("[session] auto-reconnecting...");
                connectRef.current?.();
              }
            }, 2000);
          }
          break;
        }

        default:
          break;
      }
    });

    // Register screen target callback — shows a brief toast of which app was captured
    registerScreenTarget((appName: string) => {
      setScreenTarget(appName);
      if (screenTargetTimerRef.current) clearTimeout(screenTargetTimerRef.current);
      screenTargetTimerRef.current = setTimeout(() => setScreenTarget(null), 3000);
    });

    // Register text bridge so UI actions can prompt Samuel to speak
    registerSendText((text: string) => {
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      session.transport.sendEvent({ type: "response.create" });
    });

    // Plugin reload: loads all dynamic plugins and updates the live agent
    const doReloadPlugins = async () => {
      try {
        const pluginTools = await loadAllPlugins();
        const coreTools = samuelAgent.tools as FunctionTool[];
        const merged = mergeTools(coreTools, pluginTools);
        const updatedAgent = new RealtimeAgent({
          name: samuelAgent.name,
          instructions: samuelAgent.instructions as string,
          tools: merged,
        });
        await session.updateAgent(updatedAgent);
        console.log(`[plugins] agent updated: ${merged.length} tools (${pluginTools.length} from plugins)`);
      } catch (err) {
        console.error("[plugins] reload failed:", err);
      }
    };
    registerReloadPlugins(doReloadPlugins);

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

    // Silent context: inject background info Samuel can reference but won't speak about.
    // Uses a rolling ID so we replace the previous context instead of accumulating
    // dozens of items that bloat the conversation and slow down the model.
    let silentContextId: string | null = null;
    registerSendSilentContext((text: string) => {
      // Delete previous silent context to keep conversation lean
      if (silentContextId) {
        try {
          session.transport.sendEvent({
            type: "conversation.item.delete",
            item_id: silentContextId,
          });
        } catch {}
      }
      const id = `ctx_${Date.now()}`;
      silentContextId = id;
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
    });

    // Bridge for learning mode: inject a system hint and trigger Samuel to respond.
    // Skips if the model is already generating a response to avoid session saturation.
    registerSendTextAndRespond((text: string) => {
      if (responseInProgressRef.current) {
        console.log("[session] skipping sendTextAndRespond — model is busy");
        return;
      }
      session.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      session.transport.sendEvent({ type: "response.create" });
    });

    return () => {
      registerSendImage(null);
      registerSendText(null);
      registerScreenTarget(null);
      registerSendSilentContext(null);
      registerSendTextAndRespond(null);
      registerReloadPlugins(null);
      stopKeepalive();
      session.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectRef = useRef<(() => Promise<void>) | null>(null);

  const prefetchKey = useCallback(() => {
    if (!prefetchedKeyRef.current) {
      console.log("[session] prefetching ephemeral key");
      prefetchedKeyRef.current = invoke<string>("create_ephemeral_key").catch((err) => {
        prefetchedKeyRef.current = null;
        throw err;
      });
    }
  }, []);

  const connect = useCallback(async () => {
    if (status === "connected" && !isRotatingRef.current) return;
    stopKeepalive();

    const session = sessionRef.current;
    if (!session) return;

    // If previous session died or rotating, close it cleanly
    try { session.close(); } catch {}

    const isReconnect = contextRef.current.length > 0;
    setStatus("connecting");
    if (!isReconnect) {
      setTranscript([makeEntry("status", "Connecting...")]);
    }

    try {
      // Use prefetched key if available, otherwise fetch with a 10s timeout
      let keyPromise = prefetchedKeyRef.current || invoke<string>("create_ephemeral_key");
      prefetchedKeyRef.current = null;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Ephemeral key request timed out")), 10_000),
      );
      let ephemeralKey: string;
      try {
        ephemeralKey = await Promise.race([keyPromise, timeout]);
      } catch (firstErr) {
        console.warn("[session] first key attempt failed, retrying:", firstErr);
        keyPromise = invoke<string>("create_ephemeral_key");
        ephemeralKey = await Promise.race([keyPromise, timeout]);
      }
      await session.connect({ apiKey: ephemeralKey });

      setStatus("connected");
      setAgentState("listening");
      isRotatingRef.current = false;

      agentResponseCountRef.current = 0;
      session.mute(true);

      if (isReconnect) {
        // Replay context so Samuel remembers the conversation
        const turns = contextRef.current.slice(-CONTEXT_WINDOW_TURNS);
        for (const turn of turns) {
          session.transport.sendEvent({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: turn.role,
              content: [{ type: "input_text", text: turn.text }],
            },
          });
        }
        console.log(`[session] restored ${turns.length} context turns`);
        setTranscript((prev) => [...prev, makeEntry("status", "Session refreshed")]);

        // Don't re-greet — just unmute after a short delay
        setTimeout(() => {
          if (!userMutedRef.current && sessionRef.current) {
            try { sessionRef.current.mute(false); } catch {}
          }
        }, 500);
      } else {
        setTranscript([makeEntry("status", "Connected")]);

        // Inject local time so Samuel's greeting is time-appropriate
        const now = new Date();
        const timeCtx = `[System: Current local time is ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })} on ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Use this for a time-appropriate greeting.]`;
        session.transport.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: timeCtx }],
          },
        });
        session.transport.sendEvent({ type: "response.create" });
      }

      // Load dynamic plugins and merge with core tools
      const session_ = sessionRef.current;
      if (session_) {
        loadAllPlugins().then((pluginTools) => {
          if (pluginTools.length > 0) {
            const coreTools = samuelAgent.tools as FunctionTool[];
            const merged = mergeTools(coreTools, pluginTools);
            const updatedAgent = new RealtimeAgent({
              name: samuelAgent.name,
              instructions: samuelAgent.instructions as string,
              tools: merged,
            });
            session_.updateAgent(updatedAgent).then(() => {
              console.log(`[plugins] loaded ${pluginTools.length} plugin(s), ${merged.length} total tools`);
            }).catch((err) => console.error("[plugins] updateAgent failed:", err));
          }
        }).catch((err) => console.error("[plugins] load on connect failed:", err));
      }

      // Auto-detect learning language from stored memory and silently activate
      invoke<string>("memory_get_context").then((ctx) => {
        const match = ctx.match(/proficiency:(\w+)/i);
        if (match) {
          console.log(`[session] auto-detected learning language: ${match[1]}`);
          notifyLearningLanguage(match[1]);
        }
      }).catch(() => {});

      // Start heartbeat — keeps the Realtime API connection alive during silence
      heartbeatRef.current = setInterval(() => {
        if (sessionRef.current) {
          try {
            sessionRef.current.transport.sendEvent({ type: "session.update", session: {} });
          } catch {
            console.warn("[heartbeat] failed to send ping");
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Schedule session rotation before the 60-min hard cap
      rotationTimerRef.current = setTimeout(() => {
        console.log("[session] planned rotation at 25 min");
        isRotatingRef.current = true;
        connectRef.current?.();
      }, SESSION_ROTATION_MS);

    } catch (err) {
      console.error("[connect]", err);
      isRotatingRef.current = false;
      setTranscript((prev) => [
        ...prev,
        makeEntry("status", `Connection failed: ${err}`),
      ]);
      setStatus("disconnected");
      setAgentState("idle");
    }
  }, [status, stopKeepalive, recordTurn]);

  // Keep connectRef current so auto-reconnect and rotation can call it
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    stopKeepalive();
    contextRef.current = [];
    registerSendImage(null);
    registerScreenTarget(null);
    sessionRef.current?.close();
    setStatus("disconnected");
    setAgentState("idle");
    setIsMuted(false);
    userMutedRef.current = false;
    setTranscript((prev) => [...prev, makeEntry("status", "Disconnected.")]);
  }, [stopKeepalive]);

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

  const setSuppressIdle = useCallback((suppress: boolean) => {
    suppressIdleRef.current = suppress;
  }, []);

  return {
    status,
    transcript,
    agentState,
    screenTarget,
    connect,
    disconnect,
    mute,
    isMuted,
    setWakeWordMode,
    setSuppressIdle,
    prefetchKey,
  };
}
