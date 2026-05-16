import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfigInternal } from "./config.js";
import { browser_command } from "./browser.js";
import { getWindowRef } from "../window-ref.js";

const MAX_TURNS = 30;
const VIEWPORT_W = 1280;
const VIEWPORT_H = 900;
const NATIVE_W = 1280;

// ── Types ───────────────────────────────────────────────────────────────

interface CuaResult {
	ok: boolean;
	turns_used: number;
	summary: string;
	final_screenshot_base64: string | null;
}

interface ComputerCall {
	call_id: string;
	actions: Record<string, unknown>[];
}

interface DisplayDimensions {
	width: number;
	height: number;
}

// ── Browser-mode CUA ────────────────────────────────────────────────────

export async function cua_run(task: string, url?: string): Promise<CuaResult> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	if (url) {
		await browser_command("open", { url });
	}

	const initSs = await takeBrowserScreenshot();

	const firstBody = {
		model: "gpt-5.5",
		tools: [
			{
				type: "computer",
				display_width: VIEWPORT_W,
				display_height: VIEWPORT_H,
				environment: "browser",
			},
		],
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: task },
					{
						type: "input_image",
						image_url: `data:image/png;base64,${initSs}`,
						detail: "original",
					},
				],
			},
		],
		reasoning: { effort: "medium" },
		max_output_tokens: 2048,
	};

	let resp = await callResponsesApi(apiKey, firstBody);
	let prevRespId = resp.id ?? "";
	let turns = 0;
	let lastScreenshotB64: string | null = initSs;

	for (;;) {
		turns++;
		if (turns > MAX_TURNS) {
			return {
				ok: true,
				turns_used: turns,
				summary: "Reached maximum turns. Task may be partially complete.",
				final_screenshot_base64: lastScreenshotB64,
			};
		}

		const cc = findComputerCall(resp);
		if (!cc) {
			return {
				ok: true,
				turns_used: turns,
				summary: extractTextOutput(resp),
				final_screenshot_base64: lastScreenshotB64,
			};
		}

		console.error(`[cua] turn ${turns}: executing ${cc.actions.length} actions`);

		for (const action of cc.actions) {
			await executeCuaAction(action);
		}

		const ss = await takeBrowserScreenshot();
		lastScreenshotB64 = ss;

		const followBody = {
			model: "gpt-5.5",
			tools: [
				{
					type: "computer",
					display_width: VIEWPORT_W,
					display_height: VIEWPORT_H,
					environment: "browser",
				},
			],
			previous_response_id: prevRespId,
			input: [
				{
					type: "computer_call_output",
					call_id: cc.call_id,
					output: {
						type: "input_image",
						image_url: `data:image/png;base64,${ss}`,
						detail: "original",
					},
				},
			],
			reasoning: { effort: "medium" },
			max_output_tokens: 2048,
		};

		resp = await callResponsesApi(apiKey, followBody);
		prevRespId = resp.id ?? "";
	}
}

// ── Native-mode CUA ────────────────────────────────────────────────────

export async function cua_run_native(task: string, app?: string): Promise<CuaResult> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	const { width: screenW, height: screenH } = getDisplayPointDimensions();
	const screenshotH = Math.round((NATIVE_W * screenH) / screenW);
	const scaleX = screenW / NATIVE_W;
	const scaleY = screenH / screenshotH;
	console.error(
		`[cua-native] screenshot: ${NATIVE_W}x${screenshotH}, screen: ${screenW}x${screenH}, scale: ${scaleX.toFixed(2)}x${scaleY.toFixed(2)}`,
	);

	// Hide the Samuel window so it doesn't appear in screenshots or block clicks
	const win = getWindowRef();
	if (win) {
		win.hide();
		await sleep(200);
	}

	if (app) {
		try {
			execFileSync("/usr/bin/osascript", ["-e", `tell application "${app}" to activate`]);
		} catch {
			// best effort
		}
		await sleep(500);
	}

	try {
		const initSs = native_screenshot();

		const firstBody = {
			model: "gpt-5.5",
			tools: [
				{
					type: "computer",
					display_width: NATIVE_W,
					display_height: screenshotH,
					environment: "mac",
				},
			],
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: task },
						{
							type: "input_image",
							image_url: `data:image/jpeg;base64,${initSs}`,
							detail: "original",
						},
					],
				},
			],
			reasoning: { effort: "medium" },
			max_output_tokens: 2048,
		};

		let resp = await callResponsesApi(apiKey, firstBody);
		let prevRespId = resp.id ?? "";
		let turns = 0;
		let lastScreenshotB64: string | null = initSs;

		for (;;) {
			turns++;
			if (turns > MAX_TURNS) {
				return {
					ok: true,
					turns_used: turns,
					summary: "Reached maximum turns. Task may be partially complete.",
					final_screenshot_base64: lastScreenshotB64,
				};
			}

			const cc = findComputerCall(resp);
			if (!cc) {
				return {
					ok: true,
					turns_used: turns,
					summary: extractTextOutput(resp),
					final_screenshot_base64: lastScreenshotB64,
				};
			}

			console.error(`[cua-native] turn ${turns}: executing ${cc.actions.length} actions`);

			for (const action of cc.actions) {
				native_computer_action(action, scaleX, scaleY);
			}

			await sleep(300);

			const ss = native_screenshot();
			lastScreenshotB64 = ss;

			const followBody = {
				model: "gpt-5.5",
				tools: [
					{
						type: "computer",
						display_width: NATIVE_W,
						display_height: screenshotH,
						environment: "mac",
					},
				],
				previous_response_id: prevRespId,
				input: [
					{
						type: "computer_call_output",
						call_id: cc.call_id,
						output: {
							type: "input_image",
							image_url: `data:image/jpeg;base64,${ss}`,
							detail: "original",
						},
					},
				],
				reasoning: { effort: "medium" },
				max_output_tokens: 2048,
			};

			resp = await callResponsesApi(apiKey, followBody);
			prevRespId = resp.id ?? "";
		}
	} finally {
		// Always restore the Samuel window after CUA completes
		if (win) {
			win.show();
		}
	}
}

// ── Native helpers (exported for direct use) ────────────────────────────

export function native_screenshot(): string {
	const tmpPng = "/tmp/samuel-cua-native-ss.png";
	const tmpJpg = "/tmp/samuel-cua-native-ss.jpg";
	try {
		unlinkSync(tmpPng);
	} catch {
		// ignore
	}

	const displayIdx = getDefaultDisplay();
	execFileSync("/usr/sbin/screencapture", ["-x", `-D${displayIdx}`, tmpPng]);

	try {
		execFileSync("/usr/bin/sips", [
			"--resampleWidth",
			String(NATIVE_W),
			"--setProperty",
			"format",
			"jpeg",
			"--setProperty",
			"formatOptions",
			"50",
			tmpPng,
			"--out",
			tmpJpg,
		]);
	} catch {
		throw new Error("Failed to resize native screenshot");
	} finally {
		try {
			unlinkSync(tmpPng);
		} catch {
			// ignore
		}
	}

	const data = readFileSync(tmpJpg);
	try {
		unlinkSync(tmpJpg);
	} catch {
		// ignore
	}
	console.error(`[cua-native] screenshot: ${data.length} bytes`);
	return data.toString("base64");
}

export function native_computer_action(
	action: Record<string, unknown>,
	scaleX: number,
	scaleY: number,
): void {
	const actionType = (action.type as string) ?? "unknown";
	const helper = findNativeInputHelper();

	switch (actionType) {
		case "click": {
			const x = ((action.x as number) ?? 0) * scaleX;
			const y = ((action.y as number) ?? 0) * scaleY;
			const button = (action.button as string) ?? "left";
			console.error(`[cua-native] click (${x.toFixed(0)}, ${y.toFixed(0)}) [${button}]`);
			runNativeInput(helper, ["click", String(x), String(y), button]);
			break;
		}
		case "double_click": {
			const x = ((action.x as number) ?? 0) * scaleX;
			const y = ((action.y as number) ?? 0) * scaleY;
			console.error(`[cua-native] double_click (${x.toFixed(0)}, ${y.toFixed(0)})`);
			runNativeInput(helper, ["double_click", String(x), String(y)]);
			break;
		}
		case "type": {
			const text = (action.text as string) ?? "";
			runNativeInput(helper, ["type", text]);
			break;
		}
		case "keypress": {
			const keys = (action.keys as string[]) ?? [];
			runNativeInput(helper, ["keypress", ...keys]);
			break;
		}
		case "scroll": {
			const x = ((action.x as number) ?? 640) * scaleX;
			const y = ((action.y as number) ?? 450) * scaleY;
			const sx = (action.scroll_x as number) ?? 0;
			const sy = (action.scroll_y as number) ?? 0;
			runNativeInput(helper, ["scroll", String(x), String(y), String(sx), String(sy)]);
			break;
		}
		case "drag": {
			const path = action.path as number[][] | undefined;
			if (path) {
				const args = ["drag"];
				for (const pt of path) {
					if (pt.length >= 2) {
						args.push(String((pt[0] ?? 0) * scaleX));
						args.push(String((pt[1] ?? 0) * scaleY));
					}
				}
				runNativeInput(helper, args);
			}
			break;
		}
		case "move": {
			const x = ((action.x as number) ?? 0) * scaleX;
			const y = ((action.y as number) ?? 0) * scaleY;
			runNativeInput(helper, ["move", String(x), String(y)]);
			break;
		}
		case "wait": {
			const ms = (action.ms as number) ?? 2000;
			execFileSync("/bin/sleep", [String(ms / 1000)]);
			break;
		}
		case "screenshot":
			break;
		default:
			console.error(`[cua-native] unknown action: ${actionType}`);
	}
}

// ── Internal helpers ────────────────────────────────────────────────────

let defaultDisplay = 1;

function getDefaultDisplay(): number {
	return defaultDisplay;
}

export function setDefaultDisplay(idx: number): void {
	defaultDisplay = idx;
}

function getDisplayPointDimensions(): DisplayDimensions {
	const displayIdx = getDefaultDisplay();
	const script = `use framework "AppKit"
set screens to current application's NSScreen's screens()
set idx to ${displayIdx}
if idx > (count of screens) then set idx to 1
set s to item idx of screens
set f to s's frame()
set w to item 1 of item 2 of f
set h to item 2 of item 2 of f
return (w as text) & "x" & (h as text)`;

	try {
		const out = execFileSync("/usr/bin/osascript", ["-e", script], { encoding: "utf-8" }).trim();
		const [wStr, hStr] = out.split("x");
		const w = parseFloat(wStr);
		const h = parseFloat(hStr);
		if (!Number.isNaN(w) && !Number.isNaN(h)) {
			console.error(`[cua-native] display ${displayIdx} point dims: ${w}x${h}`);
			return { width: w, height: h };
		}
	} catch {
		// fall through to default
	}

	console.error("[cua-native] could not query display dims, using 1440x900 fallback");
	return { width: 1440, height: 900 };
}

async function callResponsesApi(
	apiKey: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const resp = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`CUA API error: ${errText}`);
	}

	const data = (await resp.json()) as Record<string, unknown>;

	if (data.error) {
		throw new Error(`CUA API error: ${JSON.stringify(data.error)}`);
	}

	return data;
}

function findComputerCall(resp: Record<string, unknown>): ComputerCall | null {
	const output = resp.output as Record<string, unknown>[] | undefined;
	if (!Array.isArray(output)) return null;

	for (const item of output) {
		if (item.type === "computer_call") {
			return {
				call_id: (item.call_id as string) ?? "",
				actions: (item.actions as Record<string, unknown>[]) ?? [],
			};
		}
	}
	return null;
}

function extractTextOutput(resp: Record<string, unknown>): string {
	const output = resp.output as Record<string, unknown>[] | undefined;
	if (!Array.isArray(output)) return "Task completed.";

	const texts: string[] = [];
	for (const item of output) {
		if (item.type === "message") {
			const content = item.content as Record<string, unknown>[] | undefined;
			if (Array.isArray(content)) {
				for (const c of content) {
					if (c.type === "output_text" && typeof c.text === "string") {
						texts.push(c.text);
					}
				}
			}
		}
	}

	return texts.length > 0 ? texts.join("\n") : "Task completed.";
}

async function takeBrowserScreenshot(): Promise<string> {
	const result = await browser_command("cua_screenshot", {});
	if (!result.ok) throw new Error("Screenshot failed");

	const b64 = (result.data as Record<string, unknown>)?.base64;
	if (typeof b64 !== "string") throw new Error("No base64 in screenshot response");
	return b64;
}

async function executeCuaAction(action: Record<string, unknown>): Promise<void> {
	const actionType = (action.type as string) ?? "unknown";

	switch (actionType) {
		case "click": {
			const x = Math.round((action.x as number) ?? 0);
			const y = Math.round((action.y as number) ?? 0);
			const button = (action.button as string) ?? "left";
			const keys = (action.keys as string[]) ?? [];
			await browser_command("cua_click", { x, y, button, keys });
			break;
		}
		case "double_click": {
			const x = Math.round((action.x as number) ?? 0);
			const y = Math.round((action.y as number) ?? 0);
			await browser_command("cua_double_click", { x, y });
			break;
		}
		case "type": {
			const text = (action.text as string) ?? "";
			await browser_command("cua_type", { text });
			break;
		}
		case "keypress": {
			const keys = (action.keys as string[]) ?? [];
			await browser_command("cua_keypress", { keys });
			break;
		}
		case "scroll": {
			const x = Math.round((action.x as number) ?? 640);
			const y = Math.round((action.y as number) ?? 450);
			const scroll_x = Math.round((action.scroll_x as number) ?? 0);
			const scroll_y = Math.round((action.scroll_y as number) ?? 0);
			await browser_command("cua_scroll", { x, y, scroll_x, scroll_y });
			break;
		}
		case "drag": {
			const path = action.path ?? [];
			await browser_command("cua_drag", { path });
			break;
		}
		case "move": {
			const x = Math.round((action.x as number) ?? 0);
			const y = Math.round((action.y as number) ?? 0);
			await browser_command("cua_move", { x, y });
			break;
		}
		case "wait": {
			const ms = (action.ms as number) ?? 2000;
			await browser_command("cua_wait", { ms });
			break;
		}
		case "screenshot":
			break;
		default:
			console.error(`[cua] unknown action type: ${actionType}`);
	}
}

function findNativeInputHelper(): string {
	const fromCwd = join(process.cwd(), "helpers", "native-input.swift");
	if (existsSync(fromCwd)) return fromCwd;

	const fromDirname = resolve(__dirname, "..", "..", "helpers", "native-input.swift");
	if (existsSync(fromDirname)) return fromDirname;

	return "helpers/native-input.swift";
}

function runNativeInput(helper: string, args: string[]): void {
	try {
		execFileSync("/usr/bin/swift", [helper, ...args]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`native-input failed: ${msg}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
