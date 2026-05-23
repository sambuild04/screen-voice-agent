import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readConfigInternal } from "./config.js";

const MEMORY_DIR = ".samuel";
const MEMORY_FILE = "memory.json";
const MAX_RECENT_OBSERVATIONS = 10;
const MAX_RECENT_TRANSCRIPTS = 5;
const VOCABULARY_COOLDOWN_SECS = 24 * 60 * 60;
const PERMANENT_KNOWN = Number.MAX_SAFE_INTEGER;
const MAX_WATCH_ENTRIES = 100;
const MAX_CORRECTIONS = 50;
const MAX_WATCHES = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export interface Correction {
	timestamp: number;
	what: string;
	source: string;
}

export interface WatchEntry {
	content_hash: number;
	title_hint: string;
	first_seen: number;
	last_seen: number;
	session_count: number;
	total_minutes: number;
}

// Delivery cadence for a watch.
//   "every"  — fire on each match, gated only by cooldown_secs (default).
//   "once"   — fire on the first match then auto-disable; ignores cooldown.
//   "digest" — accumulate match details into digest_buffer; deliver one
//              summary per digest_window_secs window (or whenever the
//              watcher loop next flushes after the window elapses).
export type WatchMode = "every" | "once" | "digest";

export interface WatchAlert {
	id: string;
	description: string;
	condition_type: string;
	keywords: string[];
	source: string;
	message_template: string;
	created_at: number;
	fire_count: number;
	cooldown_secs: number;
	last_fired_at: number;
	enabled: boolean;
	// Frequency knobs — all optional so previously-saved watches still load.
	mode?: WatchMode;
	digest_window_secs?: number;
	digest_buffer?: string[];
	digest_started_at?: number;
	// Debounce — if > 0, the match must hold for at least this many seconds
	// (i.e. across multiple consecutive watcher ticks) before the trigger
	// fires. pending_since is runtime state — the timestamp of the first
	// uninterrupted match in the current run; reset to 0 when a tick goes by
	// without a match.
	debounce_secs?: number;
	pending_since?: number;
	// Per-watch suppression list. Case-insensitive substrings — if any one of
	// them appears in a candidate fire's detail string, that fire is skipped.
	// Populated by the user via watch_for(action="suppress"): "don't remind
	// me about <term> again".
	suppress_terms?: string[];
	// Optional expiry. If set and now > expires_at, the watch is auto-removed
	// on the next memory load or cleanup sweep. 0/undefined = never expire.
	expires_at?: number;
	// Tracked for stale-watch cleanup. Updated whenever the trigger condition
	// matches (even if the fire is suppressed/buffered/debounced).
	last_match_at?: number;
}

export interface WatchCheckMatch {
	id: string;
	description: string;
	message_template: string;
}

export interface ClassifierMatch {
	watch_id: string;
	description: string;
	message_template: string;
	detail: string;
}

export interface SamuelMemory {
	vocabulary_seen: Record<string, number>;
	recent_observations: string[];
	facts: Record<string, string>;
	recent_transcripts: string[];
	corrections: Correction[];
	watch_history: WatchEntry[];
	active_watches: WatchAlert[];
}

// ── Module-level cache (analogous to Rust's static Mutex) ────────────────────

let memory: SamuelMemory | null = null;

function defaultMemory(): SamuelMemory {
	return {
		vocabulary_seen: {},
		recent_observations: [],
		facts: {},
		recent_transcripts: [],
		corrections: [],
		watch_history: [],
		active_watches: [],
	};
}

function memoryPath(): string {
	const dir = join(homedir(), MEMORY_DIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return join(dir, MEMORY_FILE);
}

function loadMemory(): SamuelMemory {
	try {
		const path = memoryPath();
		if (!existsSync(path)) return defaultMemory();
		const data = readFileSync(path, "utf-8");
		const parsed = JSON.parse(data) as Partial<SamuelMemory>;
		const merged = { ...defaultMemory(), ...parsed };
		// Sweep watches whose explicit expires_at has elapsed. Stale-by-age
		// cleanup is handled by the explicit watch_cleanup_stale call so it
		// can surface what got removed; load-time sweep is just for the
		// hard time-bomb case ("remind me before 3pm today").
		if (Array.isArray(merged.active_watches)) {
			const now = Math.floor(Date.now() / 1000);
			merged.active_watches = merged.active_watches.filter(
				(w) => !(w.expires_at && w.expires_at > 0 && now > w.expires_at),
			);
		}
		return merged;
	} catch {
		return defaultMemory();
	}
}

function saveMemory(mem: SamuelMemory): void {
	try {
		const path = memoryPath();
		writeFileSync(path, JSON.stringify(mem, null, 2));
	} catch {
		// silently ignore write errors, matching Rust behavior
	}
}

function withMemory<R>(fn: (mem: SamuelMemory) => R): R {
	if (memory === null) {
		memory = loadMemory();
	}
	const result = fn(memory);
	saveMemory(memory);
	return result;
}

function nowSecs(): number {
	return Math.floor(Date.now() / 1000);
}

// ── Simple hash for content dedup (mirrors Rust's DefaultHasher on normalized text) ──

function hashContent(text: string): number {
	const normalized = text
		.toLowerCase()
		.replace(/[^\w\s]/g, "")
		.split(/\s+/)
		.join(" ");
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized.charCodeAt(i);
		hash = ((hash << 5) - hash + ch) | 0;
	}
	return Math.abs(hash);
}

// ── Internal helpers (exported for use by other modules) ─────────────────────

export function get_context(): string {
	return withMemory((mem) => {
		const parts: string[] = [];

		for (const [k, v] of Object.entries(mem.facts)) {
			parts.push(`${k}: ${v}`);
		}

		const recent = mem.recent_observations.slice().reverse().slice(0, 3);
		if (recent.length > 0) {
			parts.push(`Recent: ${recent.join("; ")}`);
		}

		const now = nowSecs();

		const knownForever = Object.entries(mem.vocabulary_seen)
			.filter(([, ts]) => ts === PERMANENT_KNOWN)
			.map(([w]) => w)
			.slice(0, 30);
		if (knownForever.length > 0) {
			parts.push(`User already knows (NEVER mention): ${knownForever.join(", ")}`);
		}

		const recentVocab = Object.entries(mem.vocabulary_seen)
			.filter(([, ts]) => ts !== PERMANENT_KNOWN && now - ts < VOCABULARY_COOLDOWN_SECS)
			.map(([w]) => w)
			.slice(0, 15);
		if (recentVocab.length > 0) {
			parts.push(`Recently taught (don't repeat today): ${recentVocab.join(", ")}`);
		}

		const corrections = mem.corrections
			.slice()
			.reverse()
			.slice(0, 5)
			.map((c) => c.what);
		if (corrections.length > 0) {
			parts.push(`User corrections (FOLLOW THESE): ${corrections.join("; ")}`);
		}

		return parts.length === 0 ? "No prior context." : parts.join(". ");
	});
}

export function record_observation(summary: string): void {
	withMemory((mem) => {
		mem.recent_observations.push(summary);
		if (mem.recent_observations.length > MAX_RECENT_OBSERVATIONS) {
			mem.recent_observations.shift();
		}
	});
}

export function record_transcript(text: string): void {
	withMemory((mem) => {
		mem.recent_transcripts.push(text);
		if (mem.recent_transcripts.length > MAX_RECENT_TRANSCRIPTS) {
			mem.recent_transcripts.shift();
		}
	});
}

export function get_recent_transcripts(): string[] {
	return withMemory((mem) => [...mem.recent_transcripts]);
}

export function record_vocabulary(words: string[]): void {
	const now = nowSecs();
	withMemory((mem) => {
		for (const word of words) {
			mem.vocabulary_seen[word] = now;
		}
	});
}

export function get_watches_context(): string | null {
	const watches = listWatchesInternal();
	const enabled = watches.filter((w) => w.enabled);
	if (enabled.length === 0) return null;

	const lines = enabled.map((w) => {
		const cond =
			w.condition_type === "keyword"
				? `keywords: ${w.keywords.join(", ")}`
				: "classifier (LLM judgment)";
		const mode = watchMode(w);
		const cadence =
			mode === "digest"
				? `digest every ${w.digest_window_secs ?? 60}s`
				: mode === "once"
					? "once"
					: `every (cooldown ${w.cooldown_secs}s)`;
		return `- [${w.id}] ${w.description} (${cond}, source: ${w.source}, ${cadence}, fired: ${w.fire_count}x)`;
	});
	return `Active watches:\n${lines.join("\n")}`;
}

// ── Watch/alert internal helpers ─────────────────────────────────────────────

function addWatchInternal(
	description: string,
	conditionType: string,
	keywords: string[],
	source: string,
	messageTemplate: string,
	cooldownSecs: number,
	mode: WatchMode = "every",
	digestWindowSecs = 0,
	debounceSecs = 0,
	expiresAt = 0,
): string {
	const id = `w_${nowSecs()}`;
	withMemory((mem) => {
		mem.active_watches.push({
			id,
			description,
			condition_type: conditionType,
			keywords: keywords.map((k) => k.toLowerCase()),
			source,
			message_template: messageTemplate,
			created_at: nowSecs(),
			fire_count: 0,
			cooldown_secs: cooldownSecs,
			last_fired_at: 0,
			enabled: true,
			mode,
			digest_window_secs: digestWindowSecs,
			digest_buffer: [],
			digest_started_at: 0,
			debounce_secs: debounceSecs,
			pending_since: 0,
			suppress_terms: [],
			expires_at: expiresAt,
			last_match_at: 0,
		});
		if (mem.active_watches.length > MAX_WATCHES) {
			mem.active_watches.shift();
		}
	});
	return id;
}

function watchMode(w: WatchAlert): WatchMode {
	const m = w.mode ?? "every";
	return m === "once" || m === "digest" ? m : "every";
}

// Apply the mode-aware delivery rules to a freshly-detected match.
//   "fire"       → caller emits a trigger now.
//   "buffered"   → digest mode swallowed it; flushDigests will deliver later.
//   "suppressed" → once-mode trigger already spent, debounce window not yet
//                  reached, or detail contains a user-suppressed term.
type WatchOutcome =
	| { kind: "fire"; detail: string }
	| { kind: "buffered" }
	| { kind: "suppressed" };

// Case-insensitive substring check against the watch's user-curated
// suppress list. Empty/missing list → never suppresses.
function detailIsSuppressed(watch: WatchAlert, detail: string): boolean {
	const terms = watch.suppress_terms;
	if (!terms || terms.length === 0) return false;
	const lower = detail.toLowerCase();
	return terms.some((t) => t && lower.includes(t.toLowerCase()));
}

function applyWatchOutcome(watch: WatchAlert, detail: string): WatchOutcome {
	const now = nowSecs();
	// Track the most recent raw match regardless of fire decision; used by
	// the stale-cleanup sweep to distinguish "registered but never seen the
	// condition" from "still relevant, just not delivering right now".
	watch.last_match_at = now;

	// User has previously said "don't remind me about <term>". Skip silently.
	if (detailIsSuppressed(watch, detail)) {
		return { kind: "suppressed" };
	}

	const mode = watchMode(watch);

	if (mode === "once" && watch.fire_count > 0) {
		return { kind: "suppressed" };
	}

	// Debounce — require the condition to remain matching for at least
	// debounce_secs continuous seconds before firing. State machine:
	//   pending_since = 0 → first sighting; record it, suppress.
	//   pending_since > 0 && now - pending_since < debounce_secs → still
	//     ramping up, suppress.
	//   pending_since > 0 && elapsed >= debounce_secs → confirmed, fall
	//     through to mode-specific firing and reset pending_since.
	// pending_since is reset to 0 by `resetPendingForUnmatched` when a tick
	// goes by without a match for this watch (see classifier/keyword paths).
	const debounce = watch.debounce_secs ?? 0;
	if (debounce > 0 && mode !== "digest") {
		if (!watch.pending_since || watch.pending_since === 0) {
			watch.pending_since = now;
			return { kind: "suppressed" };
		}
		if (now - watch.pending_since < debounce) {
			return { kind: "suppressed" };
		}
		// Confirmed match → fall through to fire, clear pending state.
		watch.pending_since = 0;
	}

	if (mode === "digest") {
		if (!watch.digest_buffer) watch.digest_buffer = [];
		watch.digest_buffer.push(detail);
		if (!watch.digest_started_at || watch.digest_started_at === 0) {
			watch.digest_started_at = now;
		}
		return { kind: "buffered" };
	}

	// "every" or first-match "once": fire immediately.
	watch.fire_count += 1;
	watch.last_fired_at = now;
	if (mode === "once") watch.enabled = false; // self-disable after spending
	return { kind: "fire", detail };
}

// Called by the renderer's watcher loops with the set of watch ids that
// matched this tick. Watches that did NOT match must have their pending
// debounce window reset, otherwise a flickering condition would fire after
// any 2 matches separated by an arbitrary gap. One-shot per source, called
// once per tick after the matched-set is finalized.
export async function watch_reset_unmatched(args: {
	source: string;
	matched_ids: string[];
}): Promise<void> {
	const matched = new Set(args.matched_ids);
	withMemory((mem) => {
		for (const watch of mem.active_watches) {
			if (!watch.enabled) continue;
			if (watch.source !== "both" && watch.source !== args.source) continue;
			if ((watch.debounce_secs ?? 0) === 0) continue;
			if (matched.has(watch.id)) continue;
			if (watch.pending_since && watch.pending_since !== 0) {
				watch.pending_since = 0;
			}
		}
	});
}

function removeWatchInternal(id: string): boolean {
	return withMemory((mem) => {
		const before = mem.active_watches.length;
		mem.active_watches = mem.active_watches.filter((w) => w.id !== id);
		return mem.active_watches.length < before;
	});
}

function listWatchesInternal(): WatchAlert[] {
	return withMemory((mem) => [...mem.active_watches]);
}

function clearWatchesInternal(): void {
	withMemory((mem) => {
		mem.active_watches = [];
	});
}

function checkWatchesKeyword(text: string, source: string): Array<[string, string, string]> {
	const lower = text.toLowerCase();
	const now = nowSecs();
	return withMemory((mem) => {
		const matches: Array<[string, string, string]> = [];
		for (const watch of mem.active_watches) {
			if (!watch.enabled) continue;
			if (watch.source !== "both" && watch.source !== source) continue;
			if (watch.condition_type !== "keyword" || watch.keywords.length === 0) continue;
			// Cooldown gates "every"-mode firing only. "digest" paces itself via
			// the digest window; "once" self-disables after the first fire.
			const mode = watchMode(watch);
			if (mode === "every" && watch.last_fired_at > 0 && now - watch.last_fired_at < watch.cooldown_secs) continue;

			const matchedKw = watch.keywords.find((kw) => lower.includes(kw));
			if (!matchedKw) continue;

			const detail = `keyword "${matchedKw}" matched`;
			const outcome = applyWatchOutcome(watch, detail);
			if (outcome.kind === "fire") {
				matches.push([watch.id, watch.description, watch.message_template]);
			}
		}
		return matches;
	});
}

function getClassifierWatchesInternal(source: string): WatchAlert[] {
	const now = nowSecs();
	return withMemory((mem) =>
		mem.active_watches.filter((w) => {
			if (!w.enabled) return false;
			if (w.condition_type !== "classifier") return false;
			if (w.source !== "both" && w.source !== source) return false;
			// Cooldown only applies to "every"-mode triggers. Digest watches
			// must keep collecting between flushes (cooldown would silently
			// drop matches in the gap), and once-mode watches self-disable
			// after firing so this branch is unreachable for them anyway.
			if (watchMode(w) !== "every") return true;
			return w.last_fired_at === 0 || now - w.last_fired_at >= w.cooldown_secs;
		}),
	);
}

function markWatchFiredInternal(id: string): void {
	withMemory((mem) => {
		const w = mem.active_watches.find((w) => w.id === id);
		if (w) {
			w.fire_count += 1;
			w.last_fired_at = nowSecs();
		}
	});
}

function addCorrectionInternal(what: string, source: string): void {
	withMemory((mem) => {
		mem.corrections.push({ timestamp: nowSecs(), what, source });
		if (mem.corrections.length > MAX_CORRECTIONS) {
			mem.corrections.splice(0, mem.corrections.length - MAX_CORRECTIONS);
		}
	});
}

function markKnownInternal(words: string[]): void {
	withMemory((mem) => {
		for (const word of words) {
			mem.vocabulary_seen[word] = PERMANENT_KNOWN;
		}
	});
}

// ── Exported memory command handlers ─────────────────────────────────────────

export async function memory_clear(): Promise<void> {
	const path = memoryPath();
	if (existsSync(path)) {
		unlinkSync(path);
	}
	memory = defaultMemory();
	console.error("[memory] cleared all data");
}

// ── Per-item inspection + deletion ───────────────────────────────────────────
//
// The settings panel's Memory Browser uses these to surface and prune
// individual entries. Every category is keyed by either a string name (facts,
// vocabulary, watch ids, corrections — by timestamp) or a numeric index
// (observations, transcripts) — pick whichever is stable for that category.
// Returns the post-delete count so the renderer can refresh without a
// follow-up list call.

export interface MemorySnapshot {
	facts: Array<{ key: string; value: string }>;
	observations: Array<{ index: number; text: string }>;
	transcripts: Array<{ index: number; text: string }>;
	vocabulary: Array<{ word: string; timestamp: number; permanent: boolean }>;
	corrections: Array<{ timestamp: number; what: string; source: string }>;
	watches: WatchAlert[];
}

export async function memory_snapshot(): Promise<MemorySnapshot> {
	return withMemory((mem) => {
		const facts = Object.entries(mem.facts).map(([key, value]) => ({ key, value }));
		const observations = mem.recent_observations.map((text, index) => ({ index, text }));
		const transcripts = mem.recent_transcripts.map((text, index) => ({ index, text }));
		const vocabulary = Object.entries(mem.vocabulary_seen).map(([word, ts]) => ({
			word,
			timestamp: ts,
			permanent: ts === PERMANENT_KNOWN,
		}));
		const corrections = mem.corrections.map((c) => ({ ...c }));
		const watches = mem.active_watches.map((w) => ({ ...w }));
		return { facts, observations, transcripts, vocabulary, corrections, watches };
	});
}

// Delete one item in `category` matching `key`. The shape of `key` depends on
// the category (see below). Returns true when something was actually removed,
// false when the key didn't match any entry — the renderer treats that as a
// silent no-op rather than an error.
export async function memory_delete_item(args: {
	category:
		| "fact"
		| "observation"
		| "transcript"
		| "vocabulary"
		| "correction"
		| "watch";
	key: string | number;
}): Promise<boolean> {
	return withMemory((mem) => {
		switch (args.category) {
			case "fact": {
				const k = String(args.key);
				if (!(k in mem.facts)) return false;
				delete mem.facts[k];
				return true;
			}
			case "observation": {
				const idx = Number(args.key);
				if (!Number.isInteger(idx) || idx < 0 || idx >= mem.recent_observations.length) return false;
				mem.recent_observations.splice(idx, 1);
				return true;
			}
			case "transcript": {
				const idx = Number(args.key);
				if (!Number.isInteger(idx) || idx < 0 || idx >= mem.recent_transcripts.length) return false;
				mem.recent_transcripts.splice(idx, 1);
				return true;
			}
			case "vocabulary": {
				const word = String(args.key);
				if (!(word in mem.vocabulary_seen)) return false;
				delete mem.vocabulary_seen[word];
				return true;
			}
			case "correction": {
				// Corrections don't have a stable id, so we key by timestamp.
				// Multiple corrections in the same second collapse to "delete
				// the first matching one" — good enough; collisions are rare.
				const ts = Number(args.key);
				const before = mem.corrections.length;
				const idx = mem.corrections.findIndex((c) => c.timestamp === ts);
				if (idx === -1) return false;
				mem.corrections.splice(idx, 1);
				return mem.corrections.length < before;
			}
			case "watch": {
				const id = String(args.key);
				const before = mem.active_watches.length;
				mem.active_watches = mem.active_watches.filter((w) => w.id !== id);
				return mem.active_watches.length < before;
			}
			default:
				return false;
		}
	});
}

export async function memory_get_context(): Promise<string> {
	let ctx = get_context();
	const watchesCtx = get_watches_context();
	if (watchesCtx) {
		ctx += "\n\nActive watches (you are monitoring these):\n" + watchesCtx;
	}
	return ctx;
}

export async function memory_set_fact(args: { key: string; value: string }): Promise<void> {
	withMemory((mem) => {
		mem.facts[args.key] = args.value;
	});
	console.error(`[memory] fact: ${args.key} = ${args.value}`);
}

export async function memory_mark_known(args: { words: string[] }): Promise<void> {
	console.error(`[memory] marking as permanently known: ${args.words.join(", ")}`);
	markKnownInternal(args.words);
}

export async function memory_add_correction(args: { what: string; source: string }): Promise<void> {
	console.error(`[memory] correction from ${args.source}: ${args.what}`);
	addCorrectionInternal(args.what, args.source);
}

export async function extract_session_feedback(args: { transcript: string }): Promise<string[]> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key");

	const prompt = `Analyze this conversation between a user and their AI assistant "Samuel".
Extract any feedback, corrections, or behavioral preferences the user expressed.

Look for:
- Explicit corrections: "that's wrong", "no, it means...", "don't explain it that way"
- Behavioral feedback: "be more concise", "speak slower", "stop doing X"
- Implicit preferences: user seems frustrated by length, user cuts off Samuel, user repeats themselves

Return a JSON array of strings, each being one actionable correction.
If no feedback found, return an empty array [].
Return ONLY valid JSON, no markdown fences.

Transcript:
${args.transcript}`;

	const body = {
		model: "gpt-4o-mini",
		messages: [{ role: "user", content: prompt }],
		max_tokens: 1000,
	};

	const resp = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const data = await resp.json();
	const content: string = data?.choices?.[0]?.message?.content ?? "[]";

	const cleaned = content
		.trim()
		.replace(/^```json\s*/, "")
		.replace(/^```\s*/, "")
		.replace(/```$/, "")
		.trim();

	let corrections: string[];
	try {
		corrections = JSON.parse(cleaned);
	} catch {
		corrections = [];
	}

	for (const c of corrections) {
		addCorrectionInternal(c, "voice");
		console.error(`[memory] extracted correction: ${c}`);
	}

	return corrections;
}

// ── Watch command handlers ───────────────────────────────────────────────────

export async function watch_add(args: {
	description: string;
	condition_type: string;
	keywords: string[];
	source: string;
	message_template: string;
	cooldown_secs: number;
	mode?: WatchMode;
	digest_window_secs?: number;
	debounce_secs?: number;
	expires_in_secs?: number;
}): Promise<string> {
	const mode: WatchMode = args.mode === "once" || args.mode === "digest" ? args.mode : "every";
	// Digest needs a positive window; if caller forgot, default to 60s so it
	// still bunches a few matches instead of flushing on the next tick.
	const digestWindow = mode === "digest" ? Math.max(args.digest_window_secs ?? 60, 1) : 0;
	const debounce = Math.max(args.debounce_secs ?? 0, 0);
	const expiresAt = args.expires_in_secs && args.expires_in_secs > 0
		? nowSecs() + args.expires_in_secs
		: 0;
	const id = addWatchInternal(
		args.description,
		args.condition_type,
		args.keywords,
		args.source,
		args.message_template,
		args.cooldown_secs,
		mode,
		digestWindow,
		debounce,
		expiresAt,
	);
	const meta = [
		`type=${args.condition_type}`,
		`mode=${mode}`,
		mode === "digest" ? `window=${digestWindow}s` : null,
		`cooldown=${args.cooldown_secs}s`,
		debounce > 0 ? `debounce=${debounce}s` : null,
		expiresAt > 0 ? `expires=${expiresAt}` : null,
	].filter(Boolean).join(", ");
	console.error(`[watch] added trigger: ${id} — ${args.description} (${meta})`);
	return id;
}

// Mutate fields on an existing watch without re-creating it. Used by voice
// requests like "make that less frequent" or "stop the build watcher" — the
// model picks fields to override and the runtime applies them in-place.
export async function watch_update(args: {
	id: string;
	enabled?: boolean;
	cooldown_secs?: number;
	mode?: WatchMode;
	digest_window_secs?: number;
	debounce_secs?: number;
	expires_in_secs?: number;
	description?: string;
}): Promise<boolean> {
	return withMemory((mem) => {
		const w = mem.active_watches.find((w) => w.id === args.id);
		if (!w) return false;
		if (args.enabled !== undefined) w.enabled = args.enabled;
		if (args.cooldown_secs !== undefined) w.cooldown_secs = Math.max(args.cooldown_secs, 0);
		if (args.mode === "every" || args.mode === "once" || args.mode === "digest") {
			w.mode = args.mode;
			// Switching modes invalidates pending state from the old mode.
			w.pending_since = 0;
			w.digest_buffer = [];
			w.digest_started_at = 0;
		}
		if (args.digest_window_secs !== undefined && watchMode(w) === "digest") {
			w.digest_window_secs = Math.max(args.digest_window_secs, 1);
		}
		if (args.debounce_secs !== undefined) {
			w.debounce_secs = Math.max(args.debounce_secs, 0);
			w.pending_since = 0; // fresh debounce window
		}
		if (args.expires_in_secs !== undefined) {
			w.expires_at = args.expires_in_secs > 0 ? nowSecs() + args.expires_in_secs : 0;
		}
		if (args.description) w.description = args.description;
		console.error(`[watch] updated ${args.id}: ${JSON.stringify(args)}`);
		return true;
	});
}

// Append a "don't remind me about <term>" suppression to a watch. Future
// candidate fires whose detail contains this term (case-insensitive) are
// silently dropped. Survives across sessions because it's persisted in the
// watch object itself.
export async function watch_suppress_term(args: {
	id: string;
	term: string;
}): Promise<boolean> {
	const term = (args.term ?? "").trim();
	if (!term) return false;
	return withMemory((mem) => {
		const w = mem.active_watches.find((w) => w.id === args.id);
		if (!w) return false;
		if (!w.suppress_terms) w.suppress_terms = [];
		const existing = new Set(w.suppress_terms.map((t) => t.toLowerCase()));
		if (!existing.has(term.toLowerCase())) {
			w.suppress_terms.push(term);
		}
		console.error(`[watch] suppressed term on ${args.id}: "${term}" (now ${w.suppress_terms.length})`);
		return true;
	});
}

// Sweep stale + expired watches.
//   expired:  expires_at > 0 && now > expires_at  → always remove
//   stale:    older than max_age_secs AND last_match_at == 0  → remove
//             (registered but never saw the condition fire even once)
// Returns the ids that were removed so callers can summarize for the user.
export async function watch_cleanup_stale(args?: {
	max_age_secs?: number;
}): Promise<string[]> {
	const maxAge = args?.max_age_secs ?? 30 * 24 * 60 * 60; // 30 days
	const now = nowSecs();
	return withMemory((mem) => {
		const removed: string[] = [];
		mem.active_watches = mem.active_watches.filter((w) => {
			if (w.expires_at && w.expires_at > 0 && now > w.expires_at) {
				removed.push(w.id);
				return false;
			}
			const age = now - (w.created_at || now);
			const everMatched = (w.last_match_at ?? 0) > 0 || w.fire_count > 0;
			if (age > maxAge && !everMatched) {
				removed.push(w.id);
				return false;
			}
			return true;
		});
		if (removed.length > 0) {
			console.error(`[watch] cleanup removed ${removed.length} stale: ${removed.join(",")}`);
		}
		return removed;
	});
}

export async function watch_remove(args: { id: string }): Promise<boolean> {
	const removed = removeWatchInternal(args.id);
	console.error(`[watch] removed ${args.id}: ${removed}`);
	return removed;
}

export async function watch_list(): Promise<WatchAlert[]> {
	return listWatchesInternal();
}

export async function watch_clear(): Promise<void> {
	clearWatchesInternal();
	console.error("[watch] cleared all watches");
}

export async function watch_check(args: { text: string; source: string }): Promise<WatchCheckMatch[]> {
	const matches = checkWatchesKeyword(args.text, args.source);
	return matches.map(([id, description, message_template]) => ({
		id,
		description,
		message_template,
	}));
}

export async function watch_get_classifier(args: { source: string }): Promise<WatchAlert[]> {
	return getClassifierWatchesInternal(args.source);
}

export async function watch_mark_fired(args: { id: string }): Promise<void> {
	markWatchFiredInternal(args.id);
	console.error(`[watch] trigger fired: ${args.id}`);
}

export async function watch_evaluate_classifier(args: {
	content: string;
	source: string;
}): Promise<ClassifierMatch[]> {
	const watches = getClassifierWatchesInternal(args.source);
	if (watches.length === 0) return [];

	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key");

	const watchSpecs = watches
		.map((w, i) => `  ${i + 1}. [id=${w.id}] ${w.description}`)
		.join("\n");

	// Fewshot examples cover the common ambiguity classes the user runs into:
	// language-vocab triggers, quality/sentiment triggers, presence-of-thing
	// triggers, and the "NONE" baseline. Detail strings stay short (≤80 chars)
	// because they end up in user-facing alerts and the digest buffer.
	const systemPrompt =
		`You are a trigger evaluator. Given content from ${args.source}, decide which registered triggers fire on this content.\n` +
		`Active triggers:\n${watchSpecs}\n\n` +
		`For each trigger that matches, output ONE JSON object per line:\n` +
		`{"id": "<watch_id>", "detail": "<≤80 chars, the specific evidence in the content>"}\n` +
		`If NOTHING matches, output exactly: NONE\n\n` +
		`Rules:\n` +
		`- Be conservative — fire only on clear, specific evidence in the content. Don't infer from absence.\n` +
		`- "detail" must quote or name the actual thing that matched (a word, phrase, person, sentiment cue), not a paraphrase.\n` +
		`- Multiple triggers can fire on the same content; emit one JSON line per trigger.\n` +
		`- Do not explain. Do not add prose. Output JSON lines or NONE.\n\n` +
		`Examples:\n` +
		`Triggers: 1. [id=w_ex1] N2-level Japanese vocabulary  2. [id=w_ex2] mention of project deadlines\n` +
		`Content: "今日は会議で締め切りについて話しました" (Today we talked about the deadline in the meeting)\n` +
		`Output:\n` +
		`{"id":"w_ex1","detail":"締め切り (shimekiri, deadline) — N2"}\n` +
		`{"id":"w_ex2","detail":"deadline mentioned in meeting"}\n\n` +
		`Triggers: 1. [id=w_ex3] speaker sounds frustrated or angry\n` +
		`Content: "the build broke again, this is the third time today"\n` +
		`Output:\n` +
		`{"id":"w_ex3","detail":"third build break today, exasperated tone"}\n\n` +
		`Triggers: 1. [id=w_ex4] someone mentions Tokyo\n` +
		`Content: "I had ramen for lunch and read the news"\n` +
		`Output: NONE`;

	const body = {
		model: "gpt-4o-mini",
		max_tokens: 300,
		temperature: 0.0,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: args.content },
		],
	};

	const resp = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(8000),
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		console.error(`[watch-classifier] error: ${errText}`);
		return [];
	}

	const data = await resp.json();
	const text = (data?.choices?.[0]?.message?.content ?? "NONE").trim();
	console.error(`[watch-classifier] raw response: ${text}`);

	if (text === "NONE" || text === "") return [];

	const watchIds = new Set(watches.map((w) => w.id));
	const llmHits: Array<{ id: string; detail: string }> = [];

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "NONE") continue;
		try {
			const val = JSON.parse(trimmed);
			const id = val.id as string;
			const detail = val.detail as string;
			if (id && detail && watchIds.has(id)) {
				llmHits.push({ id, detail });
			}
		} catch {
			// skip unparseable lines
		}
	}

	// Funnel through the unified mode gate so "once"/"digest" semantics apply
	// to classifier hits the same way they do to keyword hits.
	const results: ClassifierMatch[] = [];
	withMemory((mem) => {
		for (const { id, detail } of llmHits) {
			const watch = mem.active_watches.find((w) => w.id === id);
			if (!watch || !watch.enabled) continue;
			const outcome = applyWatchOutcome(watch, detail);
			if (outcome.kind === "fire") {
				results.push({
					watch_id: id,
					description: watch.description,
					message_template: watch.message_template,
					detail: outcome.detail,
				});
			}
		}
	});

	console.error(
		`[watch-classifier] llm=${llmHits.length} fired=${results.length} buffered/suppressed=${llmHits.length - results.length}`,
	);
	return results;
}

// Drain digest buffers whose collection window has elapsed. Called by the
// renderer's watcher loops every tick after the keyword/classifier checks.
// One delivered digest per watch per call.
export async function watch_flush_digests(args: { source: string }): Promise<ClassifierMatch[]> {
	const now = nowSecs();
	return withMemory((mem) => {
		const out: ClassifierMatch[] = [];
		for (const watch of mem.active_watches) {
			if (!watch.enabled) continue;
			if (watchMode(watch) !== "digest") continue;
			if (watch.source !== "both" && watch.source !== args.source) continue;

			const buffer = watch.digest_buffer ?? [];
			if (buffer.length === 0) continue;

			const startedAt = watch.digest_started_at ?? 0;
			const window = watch.digest_window_secs ?? 0;
			// Window not yet elapsed → keep collecting.
			if (window > 0 && startedAt > 0 && now - startedAt < window) continue;

			// Drain — one summary line, capped at 8 details to keep the prompt small.
			const head = buffer.slice(0, 8);
			const detail =
				buffer.length === 1
					? head[0]
					: `${buffer.length} matches over ${Math.max(1, now - startedAt)}s: ${head.join("; ")}${buffer.length > 8 ? "; …" : ""}`;

			watch.digest_buffer = [];
			watch.digest_started_at = 0;
			watch.fire_count += 1;
			watch.last_fired_at = now;

			out.push({
				watch_id: watch.id,
				description: watch.description,
				message_template: watch.message_template,
				detail,
			});
		}
		return out;
	});
}
