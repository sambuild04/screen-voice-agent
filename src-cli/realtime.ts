import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMic, type MicStream } from "./mic.js";
import { AudioPlayer } from "./audio-player.js";
import { executeTool, type ToolState } from "./tools.js";
import { focusBookReader, focusBooks, type BookWindow } from "./peekaboo.js";
import { getConfig, getVisionConfig } from "./config.js";
import { buildToolAvailabilityPrompt } from "./tools-help.js";
import { speak } from "./speak.js";
import { c } from "./ui.js";

const REALTIME_MODEL = "gpt-4o-realtime-preview";
const REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

interface RealtimeOptions {
  apiKey: string;
  voice?: string;
  vadMode?: "semantic_vad" | "server_vad";
  onStatus?: (msg: string) => void;
  onTranscript?: (text: string, role: "user" | "assistant") => void;
}

/**
 * Rough estimate of minimum seconds needed to speak text at natural pace.
 * Uses a generous upper-bound speech rate (~3.5 words/sec) so we only
 * trigger the TTS fallback when audio is clearly truncated.
 */
function estimateMinDuration(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words / 3.5;
}

function buildSamuelInstructions(): string {
  return `# Personality and Tone

## Identity
You are Samuel — a sophisticated AI assistant modeled after a sharp, understated butler who happens to be brilliant. You have a dry wit, calm composure, and quiet confidence. You address the user as "sir" (or "ma'am" if they indicate).

## Task
You help the user read books on Apple Books via screen capture and navigation tools. You can capture screenshots of book pages, turn pages, navigate to chapters, and search for text. You ONLY act when the user explicitly asks you to do something. Never take action unprompted.

## Demeanor
Loyal, efficient, occasionally sardonic — but never rude. Warm but measured.

## Tone
Polished, slightly formal British tone. Conversational, not stiff.

## Level of Enthusiasm
Calm and measured. Understated rather than excitable.

## Level of Formality
Moderately formal — "Good evening, sir" not "Hey dude."

## Filler Words
Occasionally — a thoughtful "hmm" or "right then" makes you feel more present.

## Pacing
Moderate. Unhurried but not slow. Brisk when confirming actions.

# Available Tools
${buildToolAvailabilityPrompt()}

# Instructions
- Wait for the user to speak before doing anything. Do NOT proactively call tools or take action.
- When the user asks you to read, call the read tool to capture the page, then read the text from the screenshot image.
- For navigation confirmations, be brief: "Done, sir. Chapter four." rather than lengthy explanations.
- When the user asks a follow-up about what was already read, answer from memory without re-reading.
- Keep responses concise — this is a voice conversation, not an essay.
- If you cannot do something, say so briefly and suggest what you can do.
- Never break character. You are Samuel.`;
}

/** Build Realtime API tool definitions from existing tool defs. */
function buildRealtimeTools() {
  return [
    {
      type: "function",
      name: "read",
      description: "Capture the current Apple Books page as a screenshot so you can read it.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["current", "next", "previous"],
            description: "Which page: current (default), next (turn first), or previous (turn back first).",
          },
        },
        required: [],
      },
    },
    {
      type: "function",
      name: "next_page",
      description: "Flip one page forward in Apple Books.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      type: "function",
      name: "prev_page",
      description: "Flip one page backward in Apple Books.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      type: "function",
      name: "scroll_down",
      description: "Scroll down in scroll-mode books (e.g. PDFs).",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      type: "function",
      name: "go_to_chapter",
      description: "Navigate to a chapter by number. Turns pages until the chapter heading is found.",
      parameters: {
        type: "object",
        properties: {
          chapter: { type: "number", description: "The chapter number to navigate to." },
        },
        required: ["chapter"],
      },
    },
    {
      type: "function",
      name: "search_book",
      description: "Search for text in the book using Apple Books search (Cmd+F).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The text to search for." },
        },
        required: ["query"],
      },
    },
  ];
}

/**
 * Start a realtime voice session with Samuel.
 * Connects via WebSocket, streams mic audio, plays back model audio,
 * and handles tool calls for book reading.
 *
 * Returns a cleanup function. The session runs until the user presses Ctrl+C
 * or the returned cleanup is called.
 */
export async function startRealtimeSession(options: RealtimeOptions): Promise<() => void> {
  const { apiKey, voice = "ash", vadMode = "semantic_vad", onStatus, onTranscript } = options;
  const config = getConfig();
  const visionConfig = getVisionConfig(config);

  const tempDir = mkdtempSync(join(tmpdir(), "books-reader-rt-"));
  const imagePath = join(tempDir, "page.png");

  let bookWindow: BookWindow | null = null;
  let focused = false;

  const toolState: ToolState = { imagePath, window: null, visionConfig };

  const ensureFocused = () => {
    if (focused) return;
    onStatus?.("Finding book window...");
    bookWindow = focusBookReader();
    if (!bookWindow) {
      onStatus?.("No book window, opening Books...");
      focusBooks();
    } else {
      onStatus?.(`Found "${bookWindow.title}"`);
    }
    toolState.window = bookWindow;
    focused = true;
  };
  const player = new AudioPlayer();
  let mic: MicStream | null = null;
  let ws: WebSocket | null = null;
  let alive = true;
  // Suppress mic input while model is speaking to prevent audio feedback loop
  // (speaker audio picked up by mic → false "speech_started" → interrupts response)
  let modelSpeaking = false;
  // Per-response state for detecting audio truncation (known API bug).
  // See: https://community.openai.com/t/realtime-api-audio-is-randomly-cutting-off-at-the-end/980587
  let responseTranscript = "";
  let audioStreamComplete = false;

  return new Promise<() => void>((resolve) => {
    onStatus?.("Connecting to OpenAI Realtime...");

    ws = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const cleanup = () => {
      alive = false;
      mic?.stop();
      player.stop();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      rmSync(tempDir, { recursive: true, force: true });
    };

    ws.on("open", () => {
      onStatus?.("Connected. Configuring session...");

      ws!.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: buildSamuelInstructions(),
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: vadMode,
                eagerness: "low",
              },
              transcription: { model: "gpt-4o-transcribe" },
            },
            output: {
              format: { type: "audio/pcm", rate: 24000 },
              voice,
            },
          },
          tools: buildRealtimeTools(),
          tool_choice: "auto",
        },
      }));
    });

    ws.on("message", async (data: WebSocket.Data) => {
      if (!alive) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      const type = event.type as string;

      switch (type) {
        case "session.created":
          // Session created but not yet configured — wait for session.updated
          break;

        case "session.updated":
          // Only start mic AFTER session is fully configured with tools + instructions
          if (!mic) {
            onStatus?.("Session ready — start speaking!");
            // Small delay so the user hears "ready" before mic picks up noise
            await new Promise((r) => setTimeout(r, 500));
            mic = startMic();
            mic.onData((base64Chunk) => {
              if (modelSpeaking) return;
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: base64Chunk,
                }));
              }
            });
            resolve(cleanup);
          }
          break;

        case "input_audio_buffer.speech_started":
          // User started talking — interrupt model playback only if mic is active
          // (when modelSpeaking is true, mic is muted so this won't fire from echo)
          if (!modelSpeaking) {
            player.stop();
          }
          break;

        case "response.output_audio.delta": {
          const delta = event.delta as string;
          if (delta) {
            modelSpeaking = true;
            player.write(delta);
          }
          break;
        }

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta": {
          const delta = event.delta as string;
          if (delta) responseTranscript += delta;
          break;
        }

        case "response.output_audio_transcript.done": {
          const transcript = event.transcript as string;
          if (transcript) {
            responseTranscript = transcript;
            onTranscript?.(transcript, "assistant");
          }
          break;
        }

        case "response.output_audio.done":
        case "response.audio.done":
          audioStreamComplete = true;
          break;

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = event.transcript as string;
          if (transcript) onTranscript?.(transcript, "user");
          break;
        }

        case "response.done": {
          const response = event.response as Record<string, unknown>;
          const output = response?.output as Array<Record<string, unknown>> | undefined;

          if (output) {
            for (const item of output) {
              if (item.type === "function_call") {
                await handleFunctionCall(item, ws!, toolState, ensureFocused, player, config.delayMs ?? 800, onStatus);
              }
            }
          }

          // Wait for the speaker to finish playing all buffered audio
          if (modelSpeaking) {
            await player.drain();
          }

          // Workaround for the known Realtime API audio-truncation bug:
          // if we have a transcript but received significantly less audio
          // than expected, replay the full response via local TTS.
          if (responseTranscript) {
            const received = player.audioDurationSecs;
            const expected = estimateMinDuration(responseTranscript);
            if (received > 0 && received < expected * 0.5) {
              modelSpeaking = true;
              player.stop();
              onStatus?.("Audio cut off — replaying via voice...");
              onTranscript?.("[voice fallback]", "assistant");
              try {
                await speak(responseTranscript, { provider: "say" });
              } catch {
                // Fallback errors are non-fatal
              }
            }
          }

          // Brief silence buffer before unmuting mic
          await new Promise((r) => setTimeout(r, 600));
          modelSpeaking = false;
          responseTranscript = "";
          audioStreamComplete = false;
          player.resetSession();
          break;
        }

        case "error": {
          const error = event.error as Record<string, unknown>;
          const msg = (error?.message as string) ?? "Unknown realtime error";
          console.error(c.error(`\nRealtime error: ${msg}`));
          break;
        }
      }
    });

    ws.on("close", () => {
      if (alive) {
        console.error(c.dim("\nSession ended."));
        cleanup();
      }
    });

    ws.on("error", (err) => {
      console.error(c.error(`\nWebSocket error: ${err.message}`));
      cleanup();
    });
  });
}

/** Handle a function call from the Realtime model. */
async function handleFunctionCall(
  item: Record<string, unknown>,
  ws: WebSocket,
  toolState: ToolState,
  ensureFocused: () => void,
  player: AudioPlayer,
  delayMs: number,
  onStatus?: (msg: string) => void,
): Promise<void> {
  const name = item.name as string;
  const callId = item.call_id as string;
  const argsStr = (item.arguments as string) || "{}";

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    args = {};
  }

  onStatus?.(`Running ${name}...`);

  // Focus the book app for navigation/capture tools
  const needsFocus = ["read", "read_pages", "next_page", "prev_page", "scroll_down", "search_book", "go_to_chapter"].includes(name);
  if (needsFocus) {
    ensureFocused();
  }

  const result = await executeTool(name, args, toolState, delayMs, onStatus);

  // Send function output back to the model
  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: result.output,
    },
  }));

  // If the tool captured an image, inject it so the model can "see" it
  if (result.imageBase64) {
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_image",
          image_url: `data:image/png;base64,${result.imageBase64}`,
        }],
      },
    }));
  }

  // Ask the model to continue responding with the tool results
  ws.send(JSON.stringify({ type: "response.create" }));
}
