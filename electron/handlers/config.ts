import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openaiFetch } from "./openai-client.js";

// The DMG ships with this proxy URL hardcoded. The proxy mints OpenAI
// ephemeral keys for trial users and relays a few REST endpoints behind
// per-installation rate limits — see proxy/src/index.ts. Override per-
// install by setting `proxyUrl` in ~/.books-reader.json or
// SAMUEL_PROXY_URL in the environment (used during development against
// `wrangler dev`). Empty string disables proxy mode → app requires the
// user to bring their own key.
const DEFAULT_PROXY_URL = "https://samuel-proxy.boshenfeng.workers.dev";

export interface Config {
	apiKey: string | null;
	proxyUrl: string;
	provider: string | null;
	model: string | null;
	delayMs: number | null;
}

export function readConfigInternal(): Config {
	const configPath = join(homedir(), ".books-reader.json");
	const envProxy = process.env.SAMUEL_PROXY_URL;

	if (!existsSync(configPath)) {
		return {
			apiKey: process.env.OPENAI_API_KEY ?? null,
			proxyUrl: envProxy ?? DEFAULT_PROXY_URL,
			provider: "openai",
			model: null,
			delayMs: 800,
		};
	}

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		return {
			apiKey: raw.apiKey ?? process.env.OPENAI_API_KEY ?? null,
			proxyUrl: raw.proxyUrl ?? envProxy ?? DEFAULT_PROXY_URL,
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

	const resp = await openaiFetch("/v1/realtime/client_secrets", {
		method: "POST",
		body: JSON.stringify({
			session: { type: "realtime", model: "gpt-realtime-2" },
		}),
	});

	const json = (await resp.json()) as {
		value?: string;
		error?: { message?: string };
	};
	if (json.error) throw new Error(`OpenAI error: ${json.error.message}`);
	if (!json.value) throw new Error("No 'value' in ephemeral key response");
	console.error("[ephemeral-key] success");
	return json.value;
}

// Persist a user-provided OpenAI key into ~/.books-reader.json. Once set,
// openaiFetch() routes directly to OpenAI with this key, bypassing the
// trial proxy. Empty/whitespace value clears the key (back to trial mode).
export async function set_user_api_key(args: { apiKey: string }): Promise<{ ok: boolean }> {
	const configPath = join(homedir(), ".books-reader.json");
	const trimmed = (args.apiKey ?? "").trim();

	let raw: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			raw = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch {
			raw = {};
		}
	}

	if (trimmed) {
		raw.apiKey = trimmed;
	} else {
		delete raw.apiKey;
	}

	writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
	return { ok: true };
}
