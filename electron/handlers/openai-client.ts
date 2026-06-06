import { readConfigInternal } from "./config.js";
import { getInstallationId } from "./installation-id.js";

// Single source of truth for hitting OpenAI endpoints from the main
// process. Routes to either:
//
//   • the Samuel proxy (Cloudflare Worker) — when the user has NOT set
//     their own API key. The proxy holds the real OpenAI key, applies
//     per-installation trial rate limits, and adds the Authorization
//     header upstream. The DMG ships with no key on disk.
//
//   • OpenAI directly — when the user has set their own key in
//     ~/.books-reader.json (or via the Settings UI). All requests bypass
//     the proxy; the user is paying for their own usage with no caps.
//
// Callers pass the OpenAI path (e.g. "/v1/chat/completions") and a
// fetch-style RequestInit. The helper handles URL construction,
// Authorization, and the X-Installation-Id header used by the proxy
// for rate limiting.

export interface OpenAIFetchInit extends Omit<RequestInit, "headers"> {
	headers?: Record<string, string>;
}

export class TrialLimitError extends Error {
	readonly code = "trial_limit";
	constructor(message: string) {
		super(message);
		this.name = "TrialLimitError";
	}
}

export class NoCredentialsError extends Error {
	readonly code = "no_credentials";
	constructor() {
		super(
			"No way to reach OpenAI: no user-provided API key and no proxy URL is bundled. Set apiKey in ~/.books-reader.json or set proxyUrl in the build.",
		);
		this.name = "NoCredentialsError";
	}
}

// Routing decision in a structured form so callers/tests can inspect it
// without parsing the URL after the fact.
export type RoutingMode = "direct" | "proxy";

export interface RoutingDecision {
	mode: RoutingMode;
	url: string;
	headers: Record<string, string>;
}

function decideRouting(path: string): RoutingDecision {
	const cfg = readConfigInternal();
	const userKey = cfg.apiKey;

	if (userKey) {
		return {
			mode: "direct",
			url: `https://api.openai.com${path}`,
			headers: { Authorization: `Bearer ${userKey}` },
		};
	}

	const proxyUrl = cfg.proxyUrl?.trim();
	if (!proxyUrl) {
		throw new NoCredentialsError();
	}

	const installationId = getInstallationId();
	// Proxy strips trailing slash so callers can be sloppy with the env
	const cleanProxy = proxyUrl.replace(/\/$/, "");
	return {
		mode: "proxy",
		url: `${cleanProxy}${path}`,
		headers: { "X-Installation-Id": installationId },
	};
}

export async function openaiFetch(path: string, init: OpenAIFetchInit = {}): Promise<Response> {
	const routing = decideRouting(path);
	const headers: Record<string, string> = {
		...routing.headers,
		...(init.headers ?? {}),
	};
	// Don't set Content-Type for FormData bodies — the runtime adds the
	// multipart boundary automatically. Caller can still override.
	if (
		!("Content-Type" in headers) &&
		!(init.body instanceof FormData) &&
		init.body != null
	) {
		headers["Content-Type"] = "application/json";
	}

	const resp = await fetch(routing.url, { ...init, headers });

	// Map the proxy's structured 429 into a typed error so callers can
	// distinguish "you hit your trial cap" from "OpenAI rate-limited the
	// upstream" without parsing the body string.
	if (routing.mode === "proxy" && resp.status === 429) {
		try {
			const cloned = resp.clone();
			const data = (await cloned.json()) as { error?: string; message?: string };
			if (data.error === "trial_limit") {
				throw new TrialLimitError(
					data.message ??
						"Daily trial limit reached. Add your OpenAI key in Settings to continue.",
				);
			}
		} catch (err) {
			// JSON parse failure — fall through and hand back the raw response.
			if (err instanceof TrialLimitError) throw err;
		}
	}

	return resp;
}

// Convenience: many existing callsites end with `if (!resp.ok) throw new
// Error(await resp.text())` then `await resp.json()`. This wraps that
// pattern so the migration is cleaner.
export async function openaiJson<T>(path: string, init: OpenAIFetchInit = {}): Promise<T> {
	const resp = await openaiFetch(path, init);
	if (!resp.ok) {
		const text = await resp.text().catch(() => "<no body>");
		throw new Error(`OpenAI ${path} ${resp.status}: ${text}`);
	}
	return (await resp.json()) as T;
}

// Public so the renderer can read trial status (rendered in Settings as
// "Trial: X of Y used today"). Passed through unchanged from the proxy.
export async function fetch_trial_status(): Promise<unknown> {
	const cfg = readConfigInternal();
	if (cfg.apiKey) {
		return { mode: "byok", message: "Using your own OpenAI key — no trial limits apply." };
	}
	const proxyUrl = cfg.proxyUrl?.trim();
	if (!proxyUrl) return { mode: "no_proxy", message: "No proxy configured." };

	const installationId = getInstallationId();
	const cleanProxy = proxyUrl.replace(/\/$/, "");
	const resp = await fetch(`${cleanProxy}/trial/status`, {
		headers: { "X-Installation-Id": installationId },
	});
	if (!resp.ok) {
		return { mode: "proxy_error", status: resp.status };
	}
	return await resp.json();
}
