import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
	apiKey: string | null;
	provider: string | null;
	model: string | null;
	delayMs: number | null;
}

export function readConfigInternal(): Config {
	const configPath = join(homedir(), ".books-reader.json");

	if (!existsSync(configPath)) {
		return {
			apiKey: process.env.OPENAI_API_KEY ?? null,
			provider: "openai",
			model: null,
			delayMs: 800,
		};
	}

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		return {
			apiKey: raw.apiKey ?? process.env.OPENAI_API_KEY ?? null,
			provider: raw.provider ?? null,
			model: raw.model ?? null,
			delayMs: raw.delayMs ?? 800,
		};
	} catch (err) {
		throw new Error(`Parse config: ${err}`);
	}
}

export async function get_config(): Promise<Config> {
	return readConfigInternal();
}

export async function create_ephemeral_key(): Promise<string> {
	console.error("[ephemeral-key] requesting...");
	const cfg = readConfigInternal();
	const apiKey = cfg.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	const resp = await fetch(
		"https://api.openai.com/v1/realtime/client_secrets",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				session: { type: "realtime", model: "gpt-realtime-2" },
			}),
		},
	);

	const json = (await resp.json()) as {
		value?: string;
		error?: { message?: string };
	};
	if (json.error) throw new Error(`OpenAI error: ${json.error.message}`);
	if (!json.value) throw new Error("No 'value' in ephemeral key response");
	console.error("[ephemeral-key] success");
	return json.value;
}
