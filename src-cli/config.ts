import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VisionConfig, VisionProvider } from "./vision.js";

const CONFIG_PATH = join(homedir(), ".books-reader.json");

export interface Config {
  provider: VisionProvider;
  apiKey: string;
  model?: string;
  delayMs?: number;
  ttsProvider?: "say" | "openai";
  ttsVoice?: string;
  ttsModel?: string;
  ttsInstructions?: string;
  ttsApiKey?: string;
  ttsSpeed?: number;
}

function loadConfig(): Partial<Config> {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Partial<Config>;
  } catch {
    return {};
  }
}

export function getConfig(): Config {
  const file = loadConfig();
  const provider = (process.env.BOOKS_READER_PROVIDER ?? file.provider ?? "openai") as VisionProvider;

  const apiKey =
    process.env.BOOKS_READER_API_KEY ??
    file.apiKey ??
    (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) ??
    (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) ??
    "";

  if (!apiKey) {
    throw new Error(
      `No API key for ${provider}. Set ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}, or BOOKS_READER_API_KEY, or add apiKey to ~/.books-reader.json`
    );
  }

  const ttsProvider = (file.ttsProvider ?? "openai") as "say" | "openai";
  // Always resolve OpenAI key for TTS (used when --tts openai is passed or ttsProvider is openai)
  const ttsApiKey =
    file.ttsApiKey ??
    process.env.OPENAI_API_KEY ??
    process.env.BOOKS_READER_OPENAI_API_KEY ??
    (provider === "openai" ? apiKey : "");

  // openai: onyx/echo (deep); say: Fred/Daniel (macOS male)
  const defaultVoice = ttsProvider === "say" ? "Fred" : "onyx";

  return {
    provider,
    apiKey,
    model: file.model,
    delayMs: file.delayMs ?? 800,
    ttsProvider,
    ttsVoice: file.ttsVoice ?? defaultVoice,
    ttsModel: file.ttsModel ?? "gpt-4o-mini-tts",
    ttsInstructions: file.ttsInstructions,
    ttsApiKey,
    ttsSpeed: file.ttsSpeed,
  };
}

export function getVisionConfig(config: Config): VisionConfig {
  return {
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
  };
}
