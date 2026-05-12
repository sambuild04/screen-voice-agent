import { execFileSync } from "node:child_process";
import {
	readFileSync,
	readdirSync,
	existsSync,
	unlinkSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Helpers ─────────────────────────────────────────────────────────────────

function findHelper(name: string): string {
	const fromCwd = join(process.cwd(), "helpers", name);
	if (existsSync(fromCwd)) return fromCwd;
	const fromDir = join(__dirname, "..", "..", "helpers", name);
	if (existsSync(fromDir)) return fromDir;
	return join("helpers", name);
}

// ── Exported commands ───────────────────────────────────────────────────────

export async function open_app(args: { name: string }): Promise<string> {
	try {
		execFileSync("/usr/bin/open", ["-a", args.name]);
	} catch (err) {
		throw new Error(
			`Failed to open ${args.name}: ${err instanceof Error ? err.message : err}`,
		);
	}
	console.error(`[open-app] launched: ${args.name}`);
	return `${args.name} opened.`;
}

export async function read_app_content(args: {
	app_name?: string;
	multi?: boolean;
}): Promise<string> {
	const helperPath = findHelper("read-ax-tree");

	if (args.app_name) {
		const cmdArgs = ["--app", args.app_name];
		try {
			const content = execFileSync(helperPath, cmdArgs, { encoding: "utf-8" });
			console.error(`[ax-tree] read ${args.app_name} (${content.length} chars)`);
			return content;
		} catch (err) {
			throw new Error(
				`AX tree read failed: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	// No specific app — read top visible apps (Codex reads all visible apps)
	const apps = getVisibleApps(args.multi ? 4 : 3);
	if (apps.length === 0) {
		return execFileSync(helperPath, [], { encoding: "utf-8" });
	}

	const parts: string[] = [];
	for (const app of apps) {
		try {
			const content = execFileSync(
				helperPath, ["--app", app], { encoding: "utf-8", timeout: 5000 },
			);
			if (content.trim().length > 20) {
				parts.push(content);
			}
		} catch {
			// Skip apps that fail to read
		}
	}

	const combined = parts.join("\n\n");
	console.error(`[ax-tree] read ${apps.length} apps: ${apps.join(", ")} (${combined.length} chars)`);
	return combined;
}

const EXCLUDED_APPS = ["samuel", "cursor", "electron"];

function getUserFacingApp(): string | null {
	const apps = getVisibleApps(1);
	return apps.length > 0 ? apps[0] : null;
}

function getVisibleApps(limit: number): string[] {
	try {
		const raw = execFileSync("/usr/bin/osascript", [
			"-e",
			`tell application "System Events"
  set appList to name of every application process whose visible is true
  set output to ""
  repeat with a in appList
    set output to output & a & linefeed
  end repeat
  return output
end tell`,
		], { encoding: "utf-8" });

		const results: string[] = [];
		const seen = new Set<string>();
		for (const name of raw.split("\n")) {
			const trimmed = name.trim();
			if (!trimmed) continue;
			const lower = trimmed.toLowerCase();
			if (EXCLUDED_APPS.some((ex) => lower.includes(ex))) continue;
			if (seen.has(lower)) continue;
			seen.add(lower);
			results.push(trimmed);
			if (results.length >= limit) break;
		}
		return results;
	} catch {
		return [];
	}
}

export async function list_app_windows(): Promise<string> {
	const helperPath = findHelper("read-ax-tree");

	let content: string;
	try {
		content = execFileSync(helperPath, ["--list-windows"], {
			encoding: "utf-8",
		});
	} catch (err) {
		throw new Error(
			`read-ax-tree: ${err instanceof Error ? err.message : err}`,
		);
	}

	console.error(
		`[ax-tree] listed windows: ${content.split("\n").length} lines`,
	);
	return content;
}

export async function list_browser_tabs(args: {
	browser?: string;
}): Promise<string> {
	const browser = args.browser || "Google Chrome";
	try {
		const script = browser.includes("Safari")
			? `tell application "Safari"
  set output to ""
  repeat with w in windows
    repeat with t in tabs of w
      set output to output & (name of t) & " | " & (URL of t) & linefeed
    end repeat
  end repeat
  return output
end tell`
			: `tell application "${browser}"
  set output to ""
  repeat with w in windows
    repeat with t in tabs of w
      set output to output & (title of t) & " | " & (URL of t) & linefeed
    end repeat
  end repeat
  return output
end tell`;

		const raw = execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf-8",
			timeout: 5000,
		});
		const trimmed = raw.trim();
		const lines = trimmed ? trimmed.split("\n") : [];
		console.error(`[browser-tabs] listed ${lines.length} tabs for ${browser}:`);
		// Print each tab so we can confirm Gmail (or whatever) is actually present
		for (const line of lines) {
			console.error(`  · ${line}`);
		}
		return trimmed || "No tabs open";
	} catch (err) {
		const msg = err instanceof Error ? err.message : err;
		console.error(`[browser-tabs] list failed: ${msg}`);
		return `Failed to list tabs: ${msg}`;
	}
}

export async function switch_browser_tab(args: {
	tab_title: string;
	browser?: string;
}): Promise<string> {
	const browser = args.browser || "Google Chrome";
	const target = args.tab_title.replace(/"/g, '\\"');
	try {
		// `ignoring case` makes `contains` case-insensitive across both title and URL.
		// Titles can change (live page edits), URL is more reliable.
		const script = browser.includes("Safari")
			? `tell application "Safari"
  ignoring case
    repeat with w in windows
      repeat with t in tabs of w
        set tabName to name of t
        set tabUrl to URL of t
        if tabName contains "${target}" or tabUrl contains "${target}" then
          set current tab of w to t
          set index of w to 1
          activate
          return "Switched to: " & tabName & " | " & tabUrl
        end if
      end repeat
    end repeat
  end ignoring
  return "Tab not found matching: ${target}"
end tell`
			: `tell application "${browser}"
  ignoring case
    repeat with w in windows
      set tabIdx to 0
      repeat with t in tabs of w
        set tabIdx to tabIdx + 1
        set tabTitle to title of t
        set tabUrl to URL of t
        if tabTitle contains "${target}" or tabUrl contains "${target}" then
          set active tab index of w to tabIdx
          set index of w to 1
          activate
          return "Switched to: " & tabTitle & " | " & tabUrl
        end if
      end repeat
    end repeat
  end ignoring
  return "Tab not found matching: ${target}"
end tell`;

		const result = execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf-8",
			timeout: 8000,
		});
		const trimmed = result.trim();
		console.error(`[browser-tabs] switch "${args.tab_title}" → ${trimmed}`);
		return trimmed;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[browser-tabs] switch failed: ${msg}`);
		return `Failed to switch tab: ${msg}`;
	}
}

// ── Desktop Actions (click, type, key, scroll, focus, press-element) ────────

function runDesktopAction(args: string[]): string {
	const helperPath = findHelper("desktop-action");
	try {
		const result = execFileSync(helperPath, args, {
			encoding: "utf-8",
			timeout: 10000,
		});
		return result.trim();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Desktop action failed: ${msg}`);
	}
}

// Returns the localized name of the currently frontmost app, or null if
// the helper failed. Cheap (~10ms shell-out). Used by the focus guard
// before every FALLBACK desktop_* call so we don't send keystrokes into
// the wrong window after the user switched apps.
function frontmostApp(): string | null {
	try {
		const out = execFileSync(findHelper("desktop-action"), ["frontmost-app"], {
			encoding: "utf-8",
			timeout: 2000,
		}).trim();
		return out && out !== "UNKNOWN" ? out : null;
	} catch {
		return null;
	}
}

// Throws an Error whose .message is a JSON blob that the tool wrapper in
// samuel.ts recognizes as a structured `focus_lost` error. The model is
// instructed (in the prompt) to verbalize this rather than silently retry.
function assertFocus(targetApp: string | undefined, action: string): void {
	if (!targetApp) return; // backward-compat: callers without target_app skip the check
	const focused = frontmostApp();
	if (!focused) return; // can't determine — fail open
	// Case-insensitive contains either way (target may be "Chrome" while the
	// frontmost is "Google Chrome"; both match).
	const fLower = focused.toLowerCase();
	const tLower = targetApp.toLowerCase();
	const match = fLower.includes(tLower) || tLower.includes(fLower);
	if (match) return;
	const payload = JSON.stringify({
		ok: false,
		kind: "focus_lost",
		action,
		focused_app: focused,
		target_app: targetApp,
		message: `User focus is on "${focused}", not "${targetApp}" — action skipped to avoid cross-app interference.`,
	});
	console.error(`[desktop] focus-guard blocked ${action}: focused=${focused} target=${targetApp}`);
	throw new Error(payload);
}

export async function desktop_click(args: {
	x: number;
	y: number;
	click_type?: string;
	target_app?: string;
}): Promise<string> {
	assertFocus(args.target_app, "desktop_click");
	const type = args.click_type || "click";
	console.error(`[desktop] ${type} at (${args.x}, ${args.y})${args.target_app ? ` target=${args.target_app}` : ""}`);
	return runDesktopAction([type, String(args.x), String(args.y)]);
}

export async function desktop_type(args: {
	text: string;
	target_app?: string;
}): Promise<string> {
	assertFocus(args.target_app, "desktop_type");
	console.error(`[desktop] type ${args.text.length} chars${args.target_app ? ` target=${args.target_app}` : ""}`);
	return runDesktopAction(["type", args.text]);
}

export async function desktop_key(args: {
	key: string;
	modifiers?: string;
	target_app?: string;
}): Promise<string> {
	assertFocus(args.target_app, "desktop_key");
	const cmdArgs = ["key", args.key];
	if (args.modifiers) {
		cmdArgs.push("--modifiers", args.modifiers);
	}
	console.error(`[desktop] key ${args.key}${args.modifiers ? ` +${args.modifiers}` : ""}${args.target_app ? ` target=${args.target_app}` : ""}`);
	return runDesktopAction(cmdArgs);
}

export async function desktop_scroll(args: {
	direction: string;
	amount?: number;
}): Promise<string> {
	const cmdArgs = ["scroll", args.direction];
	if (args.amount != null) cmdArgs.push(String(args.amount));
	console.error(`[desktop] scroll ${args.direction} ${args.amount ?? 3}`);
	return runDesktopAction(cmdArgs);
}

export async function focus_app(args: {
	app_name: string;
}): Promise<string> {
	console.error(`[desktop] focus ${args.app_name}`);
	return runDesktopAction(["focus", args.app_name]);
}

export async function press_element(args: {
	app_name: string;
	element_description: string;
}): Promise<string> {
	console.error(`[desktop] press-element in ${args.app_name}: "${args.element_description}"`);
	return runDesktopAction(["press-element", args.app_name, args.element_description]);
}

export async function ax_type(args: {
	app_name: string;
	element_description: string;
	text: string;
}): Promise<string> {
	console.error(`[ax-type] ${args.app_name}: "${args.element_description}" ← ${args.text.length} chars`);
	return runDesktopAction(["ax-type", args.app_name, args.element_description, args.text]);
}

export async function get_user_activity(): Promise<string> {
	try {
		const out = execFileSync(findHelper("desktop-action"), ["user-activity"], {
			encoding: "utf-8",
			timeout: 2000,
		}).trim();
		const seconds = Number(out);
		if (!Number.isFinite(seconds)) {
			throw new Error(`unexpected output: ${out}`);
		}
		console.error(`[user-activity] last input ${seconds.toFixed(1)}s ago`);
		return JSON.stringify({ seconds_since_last_input: seconds });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`user-activity helper failed: ${msg}`);
	}
}

export async function check_accessibility_permission(): Promise<boolean> {
	try {
		execFileSync("/usr/bin/osascript", [
			"-e",
			'tell application "System Events" to name of first application process whose frontmost is true',
		]);
		return true;
	} catch {
		return false;
	}
}

// ── Skills ──────────────────────────────────────────────────────────────────

function skillsDir(): string {
	const dir = join(homedir(), ".samuel", "skills");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function parseFrontmatter(content: string): Record<string, string> {
	const map: Record<string, string> = {};
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return map;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "---") break;
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		const key = line.slice(0, sep).trim();
		const value = line
			.slice(sep + 1)
			.trim()
			.replace(/^"|"$/g, "");
		map[key] = value;
	}
	return map;
}

export interface SkillSummary {
	id: string;
	title: string;
	trigger: string;
	summary: string;
}

export async function skill_list_summaries(): Promise<SkillSummary[]> {
	const dir = skillsDir();
	const results: SkillSummary[] = [];

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		const id = entry.name.replace(/\.md$/, "");
		try {
			const content = readFileSync(join(dir, entry.name), "utf-8");
			const fm = parseFrontmatter(content);
			results.push({
				id,
				title: fm.title ?? "",
				trigger: fm.trigger ?? "",
				summary: fm.summary ?? "",
			});
		} catch {
			continue;
		}
	}

	results.sort((a, b) => a.id.localeCompare(b.id));
	console.error(`[skills] listed ${results.length} skills`);
	return results;
}

export async function skill_delete(args: { id: string }): Promise<string> {
	const safe = args.id.replace(/[^a-zA-Z0-9_-]/g, "-");
	const dir = skillsDir();
	const path = join(dir, `${safe}.md`);
	if (!existsSync(path)) {
		throw new Error(`Skill not found: ${safe}`);
	}
	unlinkSync(path);
	console.error(`[skills] deleted ${safe}`);
	return `Deleted skill: ${safe}`;
}

// Note: watch_evaluate_classifier lives in memory.ts. The earlier copy here
// expected a `watches` array from the caller and silently returned [] when
// the renderer-side hooks (which only pass {content, source}) hit it. The
// memory.ts version fetches its own classifier watches via watch_get_classifier
// so the contract is self-contained — that's what is now wired in index.ts.
