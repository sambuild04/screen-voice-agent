import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TTSProvider = "say" | "openai";

const OPENAI_MAX_CHARS = 4096;

/**
 * Speak text aloud using macOS `say`. Returns a promise that resolves when done.
 * Use voice for macOS voice name (e.g. "Fred" or "Daniel" for male).
 */
function speakWithSay(text: string, voice?: string): Promise<void> {
  if (!text.trim()) return Promise.resolve();
  const args = voice ? ["-v", voice] : [];
  return new Promise((resolve, reject) => {
    const proc = spawn("say", args, { stdio: ["pipe", "inherit", "inherit"] });
    proc.stdin.write(text, (err) => {
      if (err) {
        reject(err);
        return;
      }
      proc.stdin.end();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`say exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

/** Default instructions for natural book-reading voice (gpt-4o-mini-tts). */
const DEFAULT_TTS_INSTRUCTIONS =
  "Speak in a deep male voice. Warm, natural tone suitable for reading aloud. Speak at a brisk, confident pace. Avoid sounding robotic or monotone.";

/**
 * Speak text using OpenAI TTS API (gpt-4o-mini-tts). Chunks long text and plays via afplay.
 * Uses the instructions parameter to control tone, pacing, and naturalness.
 */
async function speakWithOpenAI(
  text: string,
  apiKey: string,
  voice: string,
  model: string,
  instructions?: string,
  speed?: number,
): Promise<void> {
  if (!text.trim()) return;
  const chunks = chunkText(text, OPENAI_MAX_CHARS);
  const tempDir = mkdtempSync(join(tmpdir(), "books-reader-tts-"));
  const speechInstructions = instructions ?? DEFAULT_TTS_INSTRUCTIONS;
  const ttsSpeed = Math.max(0.25, Math.min(4.0, speed ?? 1.25));
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const body: Record<string, unknown> = {
        model,
        input: chunk,
        voice,
        response_format: "mp3",
        speed: ttsSpeed,
      };
      if (speechInstructions) {
        body.instructions = speechInstructions;
      }
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI TTS error: ${response.status} ${err}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const file = join(tempDir, `speech-${i}.mp3`);
      writeFileSync(file, buffer);
      await playAudioFile(file);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let split = remaining.slice(0, maxChars).lastIndexOf("\n");
    if (split <= 0) split = remaining.slice(0, maxChars).lastIndexOf(". ");
    if (split <= 0) split = remaining.slice(0, maxChars).lastIndexOf(" ");
    if (split <= 0) split = maxChars;
    chunks.push(remaining.slice(0, split + 1).trim());
    remaining = remaining.slice(split + 1).trim();
  }
  return chunks;
}

function playAudioFile(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("afplay", [path], { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`afplay exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

export interface SpeakOptions {
  provider?: TTSProvider;
  apiKey?: string;
  voice?: string;
  model?: string;
  /** Instructions for gpt-4o-mini-tts (tone, pacing, naturalness). */
  instructions?: string;
  /** Playback speed for OpenAI TTS (0.25–4.0, default 1.25). */
  speed?: number;
}

/**
 * Speak text aloud. Uses say by default, or OpenAI TTS when provider is "openai".
 */
export async function speak(
  text: string,
  options: SpeakOptions = {}
): Promise<void> {
  const {
    provider = "say",
    apiKey = "",
    voice = "marin",
    model = "gpt-4o-mini-tts",
    instructions,
    speed,
  } = options;
  if (provider === "openai") {
    if (!apiKey) {
      throw new Error(
        "OpenAI API key required for TTS. Set OPENAI_API_KEY, or add ttsApiKey to ~/.books-reader.json"
      );
    }
    await speakWithOpenAI(text, apiKey, voice, model, instructions, speed);
  } else {
    // For say: voice is macOS voice name (e.g. Alex, Daniel). Pass through when set.
    await speakWithSay(text, voice);
  }
}
