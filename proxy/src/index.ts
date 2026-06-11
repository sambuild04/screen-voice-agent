// Samuel trial proxy — relays a small allowlist of OpenAI endpoints
// behind per-installation rate limits, so DMG users get a no-setup
// trial without the dev's API key being extractable from the app bundle.
//
// Routes:
//   POST /v1/realtime/client_secrets    → mint ephemeral key for voice
//   POST /v1/audio/transcriptions       → Whisper / gpt-4o-transcribe
//   POST /v1/chat/completions           → text classifiers, plugins
//   POST /v1/responses                  → reasoning, Computer Use
//   GET  /trial/status                  → today's quota usage
//
// Rate limiting:
//   - Per-installation daily count (X-Installation-Id required)
//   - Per-IP daily count (secondary defense; behind-NAT users may hit this)
//   - Global daily USD budget circuit breaker (hard stop if a botnet
//     finds the URL — protects the dev's bill)
//
// State lives in Workers KV (env.RATE_LIMIT_KV). Counter keys auto-expire
// after 48h so KV doesn't grow unbounded.

export interface Env {
	OPENAI_KEY: string;
	RATE_LIMIT_KV: KVNamespace;
	DAILY_BUDGET_USD: string;
	// Approximate per-call cost ($). Used to update spend after each
	// upstream success. Real costs are token-dependent; these are upper-
	// bound estimates so the circuit breaker errs on the side of stopping
	// early. Override per-route in the limits table when needed.
	COST_PER_REALTIME_MINT?: string;
	COST_PER_TRANSCRIBE?: string;
	COST_PER_CHAT?: string;
	COST_PER_RESPONSES?: string;
}

interface RouteLimit {
	perInstallationPerDay: number;
	perIpPerDay: number;
	approxCostUsd: number;
}

// Per-route trial limits. The global DAILY_BUDGET_USD circuit breaker (set as
// a Cloudflare secret, default $10) is still enforced regardless of these,
// so a stuck-in-a-loop client can't burn unbounded money — when the daily
// USD spend exceeds the budget, every route returns 429 budget_exceeded.
//
// History: initial caps (3/30/100/5) were tuned for "let a curious user kick
// the tires once or twice and then go BYOK". They turned out to be way too
// tight for active dev iteration and even modest multi-session usage. Bumped
// roughly 100-200x to be effectively unlimited for any single-user workflow,
// while leaving the per-IP secondary-defense numbers proportionally higher so
// shared-NAT cohorts don't trip the wrong limit. Trim back later by lowering
// individual rows; the per-route shape stays the same.
const LIMITS: Record<string, RouteLimit> = {
	"/v1/realtime/client_secrets": {
		perInstallationPerDay: 500,
		perIpPerDay: 2000,
		approxCostUsd: 1.5,
	},
	"/v1/audio/transcriptions": {
		perInstallationPerDay: 5000,
		perIpPerDay: 20000,
		approxCostUsd: 0.01,
	},
	"/v1/chat/completions": {
		perInstallationPerDay: 10000,
		perIpPerDay: 50000,
		approxCostUsd: 0.005,
	},
	"/v1/responses": {
		perInstallationPerDay: 1000,
		perIpPerDay: 5000,
		approxCostUsd: 0.5,
	},
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_TTL_SEC = 60 * 60 * 48;

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "Content-Type, X-Installation-Id",
		},
	});
}

async function getCounter(kv: KVNamespace, key: string): Promise<number> {
	const raw = await kv.get(key);
	return raw ? parseInt(raw, 10) || 0 : 0;
}

async function setCounter(kv: KVNamespace, key: string, value: number): Promise<void> {
	await kv.put(key, String(value), { expirationTtl: DAY_TTL_SEC });
}

async function setSpend(kv: KVNamespace, key: string, value: number): Promise<void> {
	await kv.put(key, value.toFixed(4), { expirationTtl: DAY_TTL_SEC });
}

interface QuotaCheckResult {
	ok: boolean;
	reason?: "trial_limit" | "ip_limit" | "budget_exceeded";
	message?: string;
	installationUsed: number;
	installationLimit: number;
}

async function checkQuotas(
	env: Env,
	path: string,
	installationId: string,
	ip: string,
): Promise<QuotaCheckResult> {
	const limit = LIMITS[path];
	if (!limit) {
		return {
			ok: false,
			reason: "trial_limit",
			message: "Endpoint not allowed.",
			installationUsed: 0,
			installationLimit: 0,
		};
	}

	const day = today();

	// Global daily budget circuit breaker
	const budget = parseFloat(env.DAILY_BUDGET_USD || "10");
	const spend = parseFloat((await env.RATE_LIMIT_KV.get(`spend:${day}`)) ?? "0") || 0;
	if (spend >= budget) {
		return {
			ok: false,
			reason: "budget_exceeded",
			message: "Trial service is temporarily paused for the day. Please add your own OpenAI API key in Settings to continue.",
			installationUsed: 0,
			installationLimit: limit.perInstallationPerDay,
		};
	}

	// Per-installation daily count
	const installKey = `inst:${installationId}:${day}:${path}`;
	const installUsed = await getCounter(env.RATE_LIMIT_KV, installKey);
	if (installUsed >= limit.perInstallationPerDay) {
		return {
			ok: false,
			reason: "trial_limit",
			message: `Daily trial limit reached for this capability (${installUsed}/${limit.perInstallationPerDay}). Add your OpenAI API key in Settings to continue without limits.`,
			installationUsed: installUsed,
			installationLimit: limit.perInstallationPerDay,
		};
	}

	// Per-IP daily count (secondary defense)
	const ipKey = `ip:${ip}:${day}:${path}`;
	const ipUsed = await getCounter(env.RATE_LIMIT_KV, ipKey);
	if (ipUsed >= limit.perIpPerDay) {
		return {
			ok: false,
			reason: "ip_limit",
			message: "Too many trial requests from this network. Try again tomorrow or add your own API key.",
			installationUsed: installUsed,
			installationLimit: limit.perInstallationPerDay,
		};
	}

	return {
		ok: true,
		installationUsed: installUsed,
		installationLimit: limit.perInstallationPerDay,
	};
}

async function incrementCounters(
	env: Env,
	path: string,
	installationId: string,
	ip: string,
): Promise<void> {
	const limit = LIMITS[path];
	if (!limit) return;
	const day = today();
	const installKey = `inst:${installationId}:${day}:${path}`;
	const ipKey = `ip:${ip}:${day}:${path}`;
	const spendKey = `spend:${day}`;
	const [installUsed, ipUsed, spend] = await Promise.all([
		getCounter(env.RATE_LIMIT_KV, installKey),
		getCounter(env.RATE_LIMIT_KV, ipKey),
		env.RATE_LIMIT_KV.get(spendKey).then((v) => parseFloat(v ?? "0") || 0),
	]);
	await Promise.all([
		setCounter(env.RATE_LIMIT_KV, installKey, installUsed + 1),
		setCounter(env.RATE_LIMIT_KV, ipKey, ipUsed + 1),
		setSpend(env.RATE_LIMIT_KV, spendKey, spend + limit.approxCostUsd),
	]);
}

function corsHeaders(): HeadersInit {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Content-Type, X-Installation-Id",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	};
}

async function handleStatus(req: Request, env: Env): Promise<Response> {
	const installationId = req.headers.get("X-Installation-Id") ?? "";
	if (!UUID_RE.test(installationId)) {
		return jsonResponse(400, { error: "missing_installation_id" });
	}
	const day = today();
	const usage: Record<string, { used: number; limit: number }> = {};
	for (const [path, limit] of Object.entries(LIMITS)) {
		const used = await getCounter(env.RATE_LIMIT_KV, `inst:${installationId}:${day}:${path}`);
		usage[path] = { used, limit: limit.perInstallationPerDay };
	}
	const spend = parseFloat((await env.RATE_LIMIT_KV.get(`spend:${day}`)) ?? "0") || 0;
	const budget = parseFloat(env.DAILY_BUDGET_USD || "10");
	return jsonResponse(200, {
		mode: "trial",
		day,
		usage,
		budget: { spent: spend, cap: budget, paused: spend >= budget },
	});
}

async function handleRelay(
	req: Request,
	env: Env,
	ctx: ExecutionContext,
	path: string,
): Promise<Response> {
	if (req.method !== "POST") {
		return jsonResponse(405, { error: "method_not_allowed" });
	}

	const installationId = req.headers.get("X-Installation-Id") ?? "";
	if (!UUID_RE.test(installationId)) {
		return jsonResponse(400, {
			error: "missing_installation_id",
			message: "X-Installation-Id header missing or malformed.",
		});
	}

	const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";

	const quota = await checkQuotas(env, path, installationId, ip);
	if (!quota.ok) {
		return jsonResponse(429, {
			error: quota.reason ?? "trial_limit",
			message: quota.message,
			usage: { used: quota.installationUsed, limit: quota.installationLimit },
		});
	}

	const upstreamHeaders: Record<string, string> = {
		Authorization: `Bearer ${env.OPENAI_KEY}`,
	};
	const contentType = req.headers.get("Content-Type");
	if (contentType) upstreamHeaders["Content-Type"] = contentType;

	const upstream = await fetch(`https://api.openai.com${path}`, {
		method: "POST",
		headers: upstreamHeaders,
		body: req.body,
	});

	// Only count successful upstream calls toward the user's quota and
	// the daily budget. Failed calls (4xx/5xx from OpenAI) are free.
	if (upstream.ok) {
		ctx.waitUntil(incrementCounters(env, path, installationId, ip));
	}

	// Pass the response through. Streaming bodies (SSE) flow naturally
	// because we're using ReadableStream both ways.
	const respHeaders = new Headers(upstream.headers);
	respHeaders.set("Access-Control-Allow-Origin", "*");
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: respHeaders,
	});
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		const url = new URL(req.url);
		const path = url.pathname;

		if (path === "/trial/status") {
			return handleStatus(req, env);
		}
		if (path === "/" || path === "/health") {
			return jsonResponse(200, { ok: true, service: "samuel-proxy" });
		}
		if (path in LIMITS) {
			return handleRelay(req, env, ctx, path);
		}
		return jsonResponse(404, { error: "not_found" });
	},
};
