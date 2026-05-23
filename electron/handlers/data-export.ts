import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { dialog } from "electron";

import { getWindowRef } from "../window-ref.js";

// What lives where:
//   ~/.samuel/memory.json     — facts, observations, transcripts, vocab,
//                               corrections, watches
//   ~/.samuel/secrets.json    — API keys (plaintext); only included on opt-in
//   ~/.samuel/skills/*        — user skills
//   ~/.samuel/plugins/*       — user plugins
//   ~/.samuel/chrome-cua-profile/  — browser session state (cookies, etc.);
//                               always excluded; user-data dump, not data
//                               we own, and would massively bloat the export
//   ~/.books-reader.json      — config (API key, model, provider)
//
// localStorage UI prefs live in the renderer, so the renderer is responsible
// for stuffing them into `args.localStoragePrefs` before invoking us.

const SAMUEL_DIR = ".samuel";
const CONFIG_FILE = ".books-reader.json";

// Note: the IPC layer (electron/handlers/index.ts) converts camelCase keys
// from the renderer into snake_case before calling the handler. So
// `{ includeSecrets, localStoragePrefs }` from React arrives here as
// `{ include_secrets, local_storage_prefs }`.
interface ExportArgs {
	include_secrets?: boolean;
	include_plugins?: boolean;
	local_storage_prefs?: Record<string, unknown>;
}

interface ExportPayload {
	exported_at: string;
	app: string;
	version: number;
	memory?: unknown;
	config?: unknown;
	secrets?: unknown;
	skills?: Record<string, string>;
	plugins?: Record<string, string>;
	ui_preferences?: Record<string, unknown>;
	notes: string[];
}

function readJsonIfPresent(path: string): unknown | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		console.error(`[data-export] failed to read ${path}:`, err);
		return null;
	}
}

// Read every file in `dir` into a {filename: contents} map. Skips dotfiles
// and entries larger than 1MB so a runaway plugin can't balloon the export.
function readDirAsMap(dir: string, maxBytes = 1024 * 1024): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		if (entry.startsWith(".")) continue;
		const full = join(dir, entry);
		try {
			const stat = statSync(full);
			if (!stat.isFile()) continue;
			if (stat.size > maxBytes) {
				out[entry] = `[skipped: ${stat.size} bytes exceeds ${maxBytes}-byte cap]`;
				continue;
			}
			out[entry] = readFileSync(full, "utf-8");
		} catch (err) {
			out[entry] = `[error reading: ${err instanceof Error ? err.message : String(err)}]`;
		}
	}
	return out;
}

export async function data_export(args: ExportArgs = {}): Promise<{
	ok: boolean;
	path?: string;
	bytes?: number;
	canceled?: boolean;
	error?: string;
}> {
	const includeSecrets = args.include_secrets === true;
	const includePlugins = args.include_plugins !== false;

	const home = homedir();
	const samuelDir = join(home, SAMUEL_DIR);

	const payload: ExportPayload = {
		exported_at: new Date().toISOString(),
		app: "samuel",
		version: 1,
		notes: [
			"This file contains every piece of data the Samuel app stored locally about you.",
			`Source directory: ${samuelDir}`,
			"Re-importing is not supported in v1 — this export is for inspection, backup, or moving to a different tool.",
		],
	};

	payload.memory = readJsonIfPresent(join(samuelDir, "memory.json"));

	const config = readJsonIfPresent(join(home, CONFIG_FILE)) as Record<string, unknown> | null;
	if (config && typeof config === "object") {
		// Always strip apiKey from the config dump even if includeSecrets is
		// true — secrets get their own clearly-flagged section. This avoids
		// users sharing an export thinking it was scrubbed when in fact the
		// key was sitting in `config.apiKey`.
		const { apiKey: _stripped, ...rest } = config as { apiKey?: unknown } & Record<string, unknown>;
		payload.config = rest;
	}

	if (includeSecrets) {
		payload.secrets = readJsonIfPresent(join(samuelDir, "secrets.json"));
		payload.notes.push(
			"WARNING: This file contains API keys and access tokens in plaintext. Store it like a password and delete it when you no longer need it.",
		);
	} else {
		payload.notes.push(
			"API keys and tokens were intentionally excluded. Re-run with `includeSecrets: true` to include them.",
		);
	}

	payload.skills = readDirAsMap(join(samuelDir, "skills"));

	if (includePlugins) {
		payload.plugins = readDirAsMap(join(samuelDir, "plugins"));
	}

	if (args.local_storage_prefs && typeof args.local_storage_prefs === "object") {
		payload.ui_preferences = args.local_storage_prefs;
	}

	const win = getWindowRef();
	const defaultName = `samuel-data-${new Date().toISOString().slice(0, 10)}.json`;
	const result = win
		? await dialog.showSaveDialog(win, {
				title: "Export Samuel data",
				defaultPath: defaultName,
				filters: [{ name: "JSON", extensions: ["json"] }],
			})
		: await dialog.showSaveDialog({
				title: "Export Samuel data",
				defaultPath: defaultName,
				filters: [{ name: "JSON", extensions: ["json"] }],
			});

	if (result.canceled || !result.filePath) {
		return { ok: false, canceled: true };
	}

	try {
		const json = JSON.stringify(payload, null, 2);
		writeFileSync(result.filePath, json, "utf-8");
		return { ok: true, path: result.filePath, bytes: Buffer.byteLength(json, "utf-8") };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[data-export] write failed:", msg);
		return { ok: false, error: msg };
	}
}
