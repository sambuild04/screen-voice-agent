import { execFileSync } from "node:child_process";
import {
	readFileSync,
	writeFileSync,
	unlinkSync,
	existsSync,
	statSync,
	copyFileSync,
} from "node:fs";

// ── State ────────────────────────────────────────────────────────────────────

let defaultDisplay = 1;
let autoScreenHash = 0;

// Adaptive JPEG encoding cache: remember the last config that fit under
// SIZE_CAP so subsequent captures start at a known-good (q, width) instead
// of always starting at 1440px@q=55. On a high-DPI / multi-display setup
// the initial config never fits and we burn 6-7 sips re-encodings (~700ms
// cumulative) per capture before settling at 1024@q=30. With this cache,
// the second capture onwards converges in 1 sips invocation.
let lastFullDisplayQuality = 55;
let lastFullDisplayWidthIdx = 0;
let lastFocusedQuality = 65;
let lastFocusedWidthIdx = 0;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CaptureResult {
	base64: string;
	app_name: string;
	display_context?: string;
}

export interface DisplayInfo {
	index: number;
	name: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findPeekaboo(): string {
	const paths = ["/opt/homebrew/bin/peekaboo", "/usr/local/bin/peekaboo"];
	for (const p of paths) {
		if (existsSync(p)) return p;
	}
	return "peekaboo";
}

function runPeekaboo(args: string[]): string {
	const bin = findPeekaboo();
	try {
		return execFileSync(bin, args, { encoding: "utf-8" });
	} catch (err) {
		throw new Error(
			`Failed to run peekaboo (${bin}): ${err instanceof Error ? err.message : err}`,
		);
	}
}

function hashBytes(data: Buffer | Uint8Array): number {
	let hash = 0;
	for (let i = 0; i < data.length; i += 64) {
		hash = (hash * 31 + data[i]) | 0;
	}
	return hash >>> 0;
}

function tryRemove(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// ignore
	}
}

function truncateStr(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max);
}

// ── AppleScript helpers ─────────────────────────────────────────────────────

const EXCLUDED_APPS = ["samuel", "cursor", "electron"];

function getUserFacingApp(): string | null {
	const script = `tell application "System Events"
  set appList to name of every application process whose visible is true
  return appList
end tell`;
	try {
		const raw = execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf-8",
		});
		for (const name of raw.split(",")) {
			const trimmed = name.trim();
			if (!trimmed) continue;
			const lower = trimmed.toLowerCase();
			if (EXCLUDED_APPS.some((ex) => lower.includes(ex))) continue;
			return trimmed;
		}
	} catch {
		// ignore
	}
	return null;
}

function getFrontmostAppName(): string {
	try {
		return execFileSync("/usr/bin/osascript", [
			"-e",
			'tell application "System Events" to get name of first application process whose frontmost is true',
		], { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

function findDisplayForApp(app: string): number | null {
	const posScript = `tell application "System Events"
  try
    set appProc to application process "${app}"
    set winPos to position of window 1 of appProc
    return ((item 1 of winPos) as text) & "," & ((item 2 of winPos) as text)
  on error
    return "none"
  end try
end tell`;
	let raw: string;
	try {
		raw = execFileSync("/usr/bin/osascript", ["-e", posScript], {
			encoding: "utf-8",
		}).trim();
	} catch {
		return null;
	}
	if (raw === "none" || !raw) return null;
	const [wxStr, wyStr] = raw.split(",");
	const wx = parseFloat(wxStr);
	const seWy = parseFloat(wyStr);
	if (Number.isNaN(wx) || Number.isNaN(seWy)) return null;

	// System Events uses top-left origin; NSScreen uses bottom-left (Cocoa).
	// Get all screen rects via NSStringFromRect to avoid the broken dot-access.
	const screenScript = `use framework "Foundation"
use framework "AppKit"
set screens to current application's NSScreen's screens()
set output to ""
repeat with i from 1 to count of screens
  set scr to item i of screens
  set rectStr to (current application's NSStringFromRect(scr's frame())) as text
  set output to output & i & "|" & rectStr & linefeed
end repeat
return output`;

	const rectRe = /\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{(-?[\d.]+),\s*(-?[\d.]+)\}\}/;
	try {
		const sRaw = execFileSync(
			"/usr/bin/osascript",
			["-l", "AppleScript", "-e", screenScript],
			{ encoding: "utf-8" },
		);
		const screens: { idx: number; ox: number; oy: number; sw: number; sh: number }[] = [];
		let mainH = 0;
		for (const line of sRaw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const pipeIdx = trimmed.indexOf("|");
			if (pipeIdx < 0) continue;
			const idx = parseInt(trimmed.slice(0, pipeIdx), 10);
			const m = rectRe.exec(trimmed.slice(pipeIdx + 1));
			if (!m) continue;
			const s = {
				idx,
				ox: parseFloat(m[1]),
				oy: parseFloat(m[2]),
				sw: parseFloat(m[3]),
				sh: parseFloat(m[4]),
			};
			screens.push(s);
			// Main screen (index 1) defines the coordinate reference height
			if (idx === 1) mainH = s.sh;
		}
		if (!mainH && screens.length) mainH = screens[0].sh;

		// Convert System Events y (top-left) to Cocoa y (bottom-left)
		const wy = mainH - seWy;

		for (const s of screens) {
			if (wx >= s.ox && wx < s.ox + s.sw && wy >= s.oy && wy < s.oy + s.sh) {
				return s.idx;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

function getDisplayLayoutSummary(): string | null {
	const script = `tell application "System Events"
  set appList to name of every application process whose visible is true
  set output to ""
  repeat with a in appList
    set output to output & a & linefeed
  end repeat
  return output
end tell`;

	let raw: string;
	try {
		raw = execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf-8",
		});
	} catch {
		return null;
	}

	const skip = [
		"samuel",
		"cursor",
		"electron",
		"windowserver",
		"dock",
		"systemiuserver",
		"finder",
	];
	const apps = raw
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(l) => l && !skip.some((s) => l.toLowerCase().includes(s)),
		);

	if (!apps.length) return null;

	const byDisplay = new Map<number, string[]>();
	const unplaced: string[] = [];
	for (const app of apps) {
		const d = findDisplayForApp(app);
		if (d != null) {
			const list = byDisplay.get(d) ?? [];
			list.push(app);
			byDisplay.set(d, list);
		} else {
			unplaced.push(app);
		}
	}

	const parts: string[] = [];
	const keys = [...byDisplay.keys()].sort((a, b) => a - b);
	for (const k of keys) {
		parts.push(`Display ${k}: ${byDisplay.get(k)!.join(", ")}`);
	}
	if (unplaced.length) {
		parts.push(`(also open: ${unplaced.join(", ")})`);
	}
	return parts.length ? parts.join(" | ") : null;
}

// ── Core capture functions ──────────────────────────────────────────────────

function captureFullDisplay(): CaptureResult {
	const tmpPng = "/tmp/samuel-autoscreen.png";
	const tmpJpg = "/tmp/samuel-autoscreen.jpg";

	tryRemove(tmpPng);

	const dFlag = `-D${defaultDisplay}`;
	try {
		execFileSync("/usr/sbin/screencapture", ["-x", dFlag, tmpPng]);
	} catch {
		throw new Error("screencapture failed");
	}

	const data = readFileSync(tmpPng);
	if (data.length < 1000) {
		tryRemove(tmpPng);
		throw new Error("Captured image too small");
	}

	// HARD CAP at 140KB: this image gets packed into a conversation.item.create
	// event together with up to 6KB of AX text + JSON wrapper. After base64
	// expansion the whole event lands around ~190KB, which fits the WebRTC
	// SCTP message limit. Old 200KB cap was sized assuming image-only events
	// — a 200KB JPEG + 6KB AX produced ~280KB events that triggered
	// INVALID_RANGE and tore down the session (see 458→370→...→206KB chain
	// in the YouTube/Classroom of the Elite log). Step both quality AND
	// width down so we never bottom out at unreadable q=15.
	const widths = [1440, 1200, 1024];
	const SIZE_CAP = 140_000;
	// Start from last successful config — first capture explores, subsequent
	// ones converge in 1 sips call. Even on first run, biasing toward the
	// known multi-display ceiling (1024@q=30) avoids 6 wasted re-encodes.
	let quality = lastFullDisplayQuality;
	let widthIdx = lastFullDisplayWidthIdx;
	while (true) {
		try {
			execFileSync("/usr/bin/sips", [
				"--resampleWidth", String(widths[widthIdx]),
				"--setProperty", "format", "jpeg",
				"--setProperty", "formatOptions", String(quality),
				tmpPng,
				"--out", tmpJpg,
			]);
		} catch {
			tryRemove(tmpPng);
			throw new Error("Failed to resize screenshot");
		}

		const size = statSync(tmpJpg).size;
		if (size <= SIZE_CAP) break;
		quality -= 10;
		// Once quality drops below 35, shrink width before going lower.
		if (quality < 35 && widthIdx < widths.length - 1) {
			widthIdx++;
			quality = 50;
		}
		if (quality <= 20 && widthIdx === widths.length - 1) break;
		console.error(
			`[capture] JPEG too large (${size}B), retrying q=${quality} w=${widths[widthIdx]}`,
		);
	}

	// Persist this config so the next capture skips the search entirely.
	lastFullDisplayQuality = quality;
	lastFullDisplayWidthIdx = widthIdx;

	tryRemove(tmpPng);

	const jpgData = readFileSync(tmpJpg);
	console.error(
		`[capture] full-display JPEG: ${jpgData.length} bytes (q=${quality}, w=${widths[widthIdx]})`,
	);
	tryRemove(tmpJpg);

	const layout = getDisplayLayoutSummary();
	const b64 = jpgData.toString("base64");

	return {
		base64: b64,
		app_name: `Display ${defaultDisplay}`,
		display_context: layout ?? undefined,
	};
}

function captureFocusedWindow(
	requestedApp?: string | null,
): CaptureResult {
	const tmpPng = "/tmp/samuel-screen.png";
	const tmpJpg = "/tmp/samuel-screen.jpg";
	const debugJpg = "/tmp/samuel-screen-debug.jpg";

	let targetApp: string | null = null;

	if (requestedApp !== undefined && requestedApp !== null) {
		if (!requestedApp) {
			targetApp = getUserFacingApp();
		} else {
			// Find a visible app matching the requested name
			const script = `tell application "System Events"
  set appList to name of every application process whose visible is true
  set output to ""
  repeat with a in appList
    set output to output & a & linefeed
  end repeat
  return output
end tell`;
			try {
				const raw = execFileSync("/usr/bin/osascript", ["-e", script], {
					encoding: "utf-8",
				});
				const needle = requestedApp.toLowerCase();
				targetApp =
					raw
						.split("\n")
						.map((l) => l.trim())
						.filter((l) => l.length > 0)
						.find((l) => l.toLowerCase().includes(needle)) ?? null;
			} catch {
				// ignore
			}
		}
	} else {
		targetApp = getUserFacingApp();
	}

	const appLabel = targetApp ?? requestedApp ?? "Desktop";
	console.error(
		`[capture] target: ${appLabel} (requested: ${requestedApp ?? "none"})`,
	);

	let usedFullScreen = false;
	let usedWindowTitle = false;

	// For browsers, ask peekaboo to capture the SPECIFIC window matching the
	// active tab title. This avoids the multi-window/multi-display ambiguity
	// that bit us before (Gmail tab on display 2, YouTube on display 3 — old
	// path captured the wrong display).
	let activeBrowserTitle: string | null = null;
	if (targetApp) {
		const lower = targetApp.toLowerCase();
		const titleScript = lower.includes("chrome")
			? `tell application "Google Chrome" to return title of active tab of window 1`
			: lower.includes("safari")
				? `tell application "Safari" to return name of current tab of window 1`
				: lower.includes("arc")
					? `tell application "Arc" to return title of active tab of window 1`
					: null;
		if (titleScript) {
			try {
				const title = execFileSync(
					"/usr/bin/osascript",
					["-e", titleScript],
					{ encoding: "utf-8" },
				).trim();
				if (title) activeBrowserTitle = title;
			} catch {
				// ignore
			}
		}
	}

	const probePeekabooFile = (label: string, stdout: string) => {
		const exists = existsSync(tmpPng);
		const sz = exists ? statSync(tmpPng).size : 0;
		console.error(
			`[capture] peekaboo ${label}: exists=${exists} size=${sz}B stdout=${truncateStr(stdout, 200)}`,
		);
		return exists && sz > 10_000;
	};

	if (targetApp && activeBrowserTitle) {
		try {
			console.error(
				`[capture] peekaboo by title: "${truncateStr(activeBrowserTitle, 60)}"`,
			);
			tryRemove(tmpPng);
			const out = runPeekaboo([
				"image",
				"--app", targetApp,
				"--mode", "window",
				"--window-title", activeBrowserTitle,
				"--format", "png",
				"--path", tmpPng,
				"--json",
			]);
			usedWindowTitle = probePeekabooFile("window-title", out);
		} catch (e) {
			console.error(
				`[capture] peekaboo --window-title threw: ${e instanceof Error ? e.message : e}`,
			);
			tryRemove(tmpPng);
		}
	}

	// Generic peekaboo (frontmost window of app) fallback.
	if (!usedWindowTitle && targetApp) {
		try {
			tryRemove(tmpPng);
			const out = runPeekaboo([
				"image",
				"--app", targetApp,
				"--mode", "window",
				"--format", "png",
				"--path", tmpPng,
				"--json",
			]);
			probePeekabooFile("generic", out);
		} catch (e) {
			console.error(
				`[capture] peekaboo (generic) threw: ${e instanceof Error ? e.message : e}`,
			);
		}
	}

	const peekabooOk =
		existsSync(tmpPng) && statSync(tmpPng).size > 10_000;

	if (!peekabooOk && !usedWindowTitle) {
		tryRemove(tmpPng);

		const displayIdx = targetApp
			? findDisplayForApp(targetApp) ?? defaultDisplay
			: defaultDisplay;

		console.error(`[capture] falling back to display ${displayIdx}`);
		const dFlag = `-D${displayIdx}`;
		try {
			execFileSync("/usr/sbin/screencapture", ["-x", dFlag, tmpPng]);
		} catch {
			throw new Error("screencapture failed");
		}
		usedFullScreen = true;
	}

	const data = readFileSync(tmpPng);
	console.error(`[capture] raw PNG: ${data.length} bytes`);

	if (data.length < 1000) {
		tryRemove(tmpPng);
		throw new Error(
			"Captured image too small — check Screen Recording permissions.",
		);
	}

	// HARD CAP at ~190KB. The OpenAI Realtime SDK sends images as a single
	// JSON event over the WebRTC SCTP data channel; with base64 encoding
	// (~33% overhead) anything above ~190KB JPEG can blow past the
	// negotiated SCTP message size and trigger INVALID_RANGE, which tears
	// down the session (we hit this with a 409KB JPEG at q=85/1920w).
	// The proven auto-context capture lands at ~177KB and transmits
	// reliably; we mirror its sizing for observe_screen.
	const widths = [1440, 1280, 1024];
	const SIZE_CAP = 190_000;
	let quality = lastFocusedQuality;
	let widthIdx = lastFocusedWidthIdx;
	while (true) {
		try {
			execFileSync("/usr/bin/sips", [
				"--resampleWidth", String(widths[widthIdx]),
				"--setProperty", "format", "jpeg",
				"--setProperty", "formatOptions", String(quality),
				tmpPng,
				"--out", tmpJpg,
			]);
		} catch {
			tryRemove(tmpPng);
			throw new Error("Failed to resize screenshot");
		}
		const sz = statSync(tmpJpg).size;
		if (sz <= SIZE_CAP || quality <= 35) break;
		quality -= 8;
		if (quality < 50 && widthIdx < widths.length - 1) {
			widthIdx++;
			quality = 65;
		}
		console.error(
			`[capture] focus JPEG too large (${sz}B), retry q=${quality} w=${widths[widthIdx]}`,
		);
	}

	lastFocusedQuality = quality;
	lastFocusedWidthIdx = widthIdx;

	tryRemove(tmpPng);

	const jpgData = readFileSync(tmpJpg);
	const captureMode = usedFullScreen
		? "display"
		: usedWindowTitle
			? "window-title"
			: "peekaboo";
	console.error(
		`[capture] final JPEG: ${jpgData.length} bytes (mode=${captureMode}, q=${quality}, w=${widths[widthIdx]})`,
	);

	try {
		copyFileSync(tmpJpg, debugJpg);
	} catch {
		// ignore
	}
	tryRemove(tmpJpg);

	let label: string;
	if (usedFullScreen) {
		const d = targetApp
			? findDisplayForApp(targetApp)
				? `Display ${findDisplayForApp(targetApp)}`
				: `Display ${defaultDisplay}`
			: `Display ${defaultDisplay}`;
		label = `${d} (${appLabel})`;
	} else {
		label = appLabel;
	}

	const b64 = jpgData.toString("base64");
	return { base64: b64, app_name: label };
}

/**
 * Auto-detect which display the frontmost app is on and capture that display.
 * Falls back to defaultDisplay if detection fails.
 */
function captureSmartDisplay(): CaptureResult {
	const frontApp = getFrontmostAppName();
	const lower = frontApp.toLowerCase();
	// If Samuel/Cursor/Electron is frontmost, find the next user-facing app
	const actualApp = EXCLUDED_APPS.some((ex) => lower.includes(ex))
		? getUserFacingApp()
		: frontApp;

	let targetDisplay = defaultDisplay;
	if (actualApp) {
		const detected = findDisplayForApp(actualApp);
		if (detected != null) {
			targetDisplay = detected;
			console.error(
				`[capture] smart display: ${actualApp} on Display ${detected}`,
			);
		}
	}

	const prev = defaultDisplay;
	defaultDisplay = targetDisplay;
	try {
		return captureFullDisplay();
	} finally {
		defaultDisplay = prev;
	}
}

// ── Exported commands ───────────────────────────────────────────────────────

export async function capture_active_window(args: {
	app_name?: string;
	display?: number;
}): Promise<CaptureResult> {
	if (args.display != null) {
		const prev = defaultDisplay;
		defaultDisplay = args.display;
		try {
			return captureFullDisplay();
		} finally {
			defaultDisplay = prev;
		}
	}
	if (args.app_name !== undefined) {
		return captureFocusedWindow(args.app_name);
	}
	return captureFullDisplay();
}

export async function capture_if_changed(): Promise<CaptureResult | null> {
	const capture = captureSmartDisplay();
	const currentHash = hashBytes(Buffer.from(capture.base64));
	if (autoScreenHash === currentHash) return null;
	autoScreenHash = currentHash;
	return capture;
}

export async function capture_screen_now(): Promise<CaptureResult> {
	return captureSmartDisplay();
}

/**
 * Capture every connected display. Returns one CaptureResult per display in
 * index order. Used when the user asks about content spanning multiple
 * monitors ("what's on all my screens?", "check my other monitor"). Each
 * frame is captured independently — there's no native multi-display rect API
 * before macOS 15.2, and even there iterating per display gives the model
 * cleaner per-monitor context strings.
 */
export async function capture_all_displays(): Promise<CaptureResult[]> {
	const displays = await list_displays();
	const results: CaptureResult[] = [];
	const prev = defaultDisplay;
	try {
		for (const d of displays) {
			defaultDisplay = d.index;
			try {
				const cap = captureFullDisplay();
				results.push({
					...cap,
					display_context: `Display ${d.index}: ${d.name}`,
				});
			} catch (err) {
				console.error(
					`[capture] all_displays: skipped display ${d.index} (${d.name}): ${err}`,
				);
			}
		}
	} finally {
		defaultDisplay = prev;
	}
	return results;
}

export async function native_screenshot(): Promise<string> {
	const tmpPng = "/tmp/samuel-cua-native.png";
	const tmpJpg = "/tmp/samuel-cua-native.jpg";

	tryRemove(tmpPng);

	// Smart display detection for CUA screenshots
	let targetDisplay = defaultDisplay;
	const frontApp = getFrontmostAppName();
	if (frontApp) {
		const detected = findDisplayForApp(frontApp);
		if (detected != null) targetDisplay = detected;
	}
	const dFlag = `-D${targetDisplay}`;
	try {
		execFileSync("/usr/sbin/screencapture", ["-x", dFlag, tmpPng]);
	} catch {
		throw new Error("screencapture failed");
	}

	const data = readFileSync(tmpPng);
	if (data.length < 1000) {
		tryRemove(tmpPng);
		throw new Error("Captured image too small");
	}

	const width = 1280;
	const quality = 50;
	try {
		execFileSync("/usr/bin/sips", [
			"--resampleWidth", String(width),
			"--setProperty", "format", "jpeg",
			"--setProperty", "formatOptions", String(quality),
			tmpPng,
			"--out", tmpJpg,
		]);
	} catch {
		tryRemove(tmpPng);
		throw new Error("Failed to resize screenshot");
	}

	tryRemove(tmpPng);

	const jpgData = readFileSync(tmpJpg);
	tryRemove(tmpJpg);

	console.error(
		`[native-screenshot] ${jpgData.length} bytes (${width}x, q=${quality})`,
	);
	return jpgData.toString("base64");
}

export async function list_displays(): Promise<DisplayInfo[]> {
	const script = `use framework "AppKit"
set screens to current application's NSScreen's screens()
set output to ""
repeat with i from 1 to count of screens
  set scr to item i of screens
  set nm to (scr's localizedName()) as text
  set output to output & i & "|" & nm & linefeed
end repeat
return output`;

	let raw: string;
	try {
		raw = execFileSync(
			"/usr/bin/osascript",
			["-l", "AppleScript", "-e", script],
			{ encoding: "utf-8" },
		);
	} catch (err) {
		throw new Error(`list_displays: ${err}`);
	}

	const displays: DisplayInfo[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const sep = trimmed.indexOf("|");
		if (sep === -1) continue;
		const idx = parseInt(trimmed.slice(0, sep), 10);
		const name = trimmed.slice(sep + 1).trim();
		if (!Number.isNaN(idx)) {
			displays.push({ index: idx, name });
		}
	}

	if (!displays.length) {
		displays.push({ index: 1, name: "Main Display" });
	}

	console.error(`[displays] found: ${JSON.stringify(displays)}`);
	return displays;
}

export async function set_default_display(args: {
	index: number;
}): Promise<void> {
	defaultDisplay = args.index;
	console.error(`[displays] default set to ${args.index}`);
}

export function get_default_display(): number {
	return defaultDisplay;
}

export async function get_selected_text(): Promise<string> {
	// 1. Save current clipboard
	let prev: string;
	try {
		prev = execFileSync("pbpaste", { encoding: "utf-8" });
	} catch {
		prev = "";
	}

	// 2. Clear clipboard
	try {
		execFileSync("pbcopy", { input: "", encoding: "utf-8" });
	} catch {
		// ignore
	}

	// 3. Simulate Cmd+C on user-facing app
	const target = getUserFacingApp() ?? "";
	console.error(`[selected-text] copying from: ${target || "(global)"}`);

	const copyScript = target
		? `tell application "${target}" to activate
delay 0.1
tell application "System Events" to keystroke "c" using command down`
		: 'tell application "System Events" to keystroke "c" using command down';

	try {
		execFileSync("/usr/bin/osascript", ["-e", copyScript]);
	} catch {
		// ignore
	}

	// 4. Brief pause for clipboard to update
	execFileSync("sleep", ["0.2"]);

	// 5. Read new clipboard
	let selected: string;
	try {
		selected = execFileSync("pbpaste", { encoding: "utf-8" }).trim();
	} catch {
		selected = "";
	}

	// 6. Restore original clipboard
	try {
		execFileSync("pbcopy", { input: prev, encoding: "utf-8" });
	} catch {
		// ignore
	}

	console.error(`[selected-text] got: "${truncateStr(selected, 80)}"`);
	return selected;
}

export async function set_system_volume(args: {
	volume: number;
}): Promise<void> {
	const vol = Math.min(Math.max(args.volume, 0), 100);
	const script = `set volume output volume ${vol}`;
	try {
		execFileSync("/usr/bin/osascript", ["-e", script]);
	} catch (err) {
		throw new Error(`osascript: ${err}`);
	}
	console.error(`[volume] system volume set to ${vol}%`);
}
