import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { app } from "electron";

// ── Types ───────────────────────────────────────────────────────────────

export interface BrowserResult {
	ok: boolean;
	data: Record<string, unknown>;
}

interface PendingRequest {
	resolve: (value: BrowserResult) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ── Module-level sidecar state ──────────────────────────────────────────

let child: ChildProcess | null = null;
let rl: Interface | null = null;
const pending = new Map<string, PendingRequest>();

const COMMAND_TIMEOUT_MS = 60_000;

// Resolve the path to the compiled browser-agent script.
//
// Layout, after `tsc -p electron/tsconfig.json`, is:
//   <appPath>/dist-electron/handlers/browser.js   (this file at runtime)
//   <appPath>/dist-electron/lib/browser-agent.js  (the sidecar entry)
//
// In dev `__dirname` is `<repo>/dist-electron/handlers`, in packaged it's
// inside `Samuel.app/Contents/Resources/app.asar/dist-electron/handlers`.
// `path.join(__dirname, "..", "lib", "browser-agent.js")` works for both
// because the `dist-electron/` shape is preserved into the asar.
function resolveAgentPath(): string {
	return join(__dirname, "..", "lib", "browser-agent.js");
}

function failAllPending(err: Error): void {
	for (const [id, req] of pending) {
		clearTimeout(req.timer);
		req.reject(err);
		pending.delete(id);
	}
}

// Spawn the sidecar via Electron's bundled Node runtime — `process.execPath`
// is the Electron binary, and `ELECTRON_RUN_AS_NODE=1` makes it run as plain
// Node and execute the JS file we hand it. This frees us from depending on
// `npx`/`tsx`/`node` being on the system PATH.
//
// The previous implementation did `spawn("npx", ["tsx", "src/lib/browser-agent.ts"])`
// which crashed the entire main process with `spawn npx ENOENT` on every
// packaged install: GUI-launched .app bundles on macOS get a minimal PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`) that does not include Homebrew's
// `/opt/homebrew/bin` where most users' Node lives. Even if `npx` were
// found, `src/lib/browser-agent.ts` is a TypeScript source file that ships
// only in the dev tree, not in the packaged `.app`. The new path bundles a
// compiled JS copy at `dist-electron/lib/browser-agent.js` and runs it with
// the Electron binary that's guaranteed to be there.
function ensureRunning(): void {
	if (child && child.exitCode === null) return;

	const agentPath = resolveAgentPath();
	console.error(`[browser] spawning agent: ${agentPath} (via ELECTRON_RUN_AS_NODE)`);

	let proc: ChildProcess;
	try {
		proc = spawn(process.execPath, [agentPath], {
			cwd: tmpdir(),
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				// Drop GUI-related env so the spawned Node can't accidentally
				// try to open a window or attach to the main app's renderer.
				ELECTRON_NO_ATTACH_CONSOLE: "1",
			},
		});
	} catch (err) {
		// Synchronous failure (rare — usually only when execPath itself is
		// missing). Convert to a normal rejected request rather than letting
		// the throw escape and crash the main process.
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[browser] sync spawn failure: ${msg}`);
		throw new Error(`Failed to start browser agent: ${msg}`);
	}

	// CRITICAL: a Node ChildProcess emits `error` *asynchronously* when the
	// binary can't be spawned (ENOENT, EACCES, …) — `spawn()` itself returns
	// a normal-looking ChildProcess object. If nothing listens for `error`,
	// Electron's default uncaught-exception handler kills the whole main
	// process. This is exactly how the original `spawn("npx", …)` crashed
	// the app for every packaged user. Always attach an `error` listener
	// before doing anything else with the child.
	proc.on("error", (err: Error) => {
		console.error(`[browser] spawn error: ${err.message}`);
		failAllPending(new Error(`Browser agent failed to start: ${err.message}`));
		child = null;
		rl = null;
	});

	child = proc;

	rl = createInterface({ input: proc.stdout! });
	rl.on("line", (line: string) => {
		if (!line.trim()) return;
		try {
			const resp = JSON.parse(line) as Record<string, unknown>;
			const id = (resp.id as string) ?? "";
			const ok = (resp.ok as boolean) ?? false;
			const data = (resp.data as Record<string, unknown>) ?? {};
			const req = pending.get(id);
			if (req) {
				clearTimeout(req.timer);
				pending.delete(id);
				req.resolve({ ok, data });
			}
		} catch {
			// non-JSON output, ignore
		}
	});

	const stderrRl = createInterface({ input: proc.stderr! });
	stderrRl.on("line", (line: string) => {
		console.error(`[browser-agent] ${line}`);
	});

	proc.on("exit", (code) => {
		console.error(`[browser] child process exited (code=${code})`);
		failAllPending(new Error("Browser agent process exited"));
		child = null;
		rl = null;
	});

	console.error(`[browser] agent started (pid=${proc.pid}, packaged=${app.isPackaged})`);
}

// ── Public API ──────────────────────────────────────────────────────────

export async function browser_command(
	action: string,
	params: Record<string, unknown>,
): Promise<BrowserResult> {
	try {
		ensureRunning();
	} catch (err) {
		// Don't let spawn failures crash the main process — surface them as
		// a normal failed result that the LLM/plugin can react to.
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, data: { error: msg } };
	}

	if (!child?.stdin?.writable) {
		return { ok: false, data: { error: "Browser agent not running (stdin not writable)" } };
	}

	const id = `req_${Date.now()}`;
	const cmd = { ...params, id, action };
	const cmdStr = JSON.stringify(cmd);

	return new Promise<BrowserResult>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("Browser command timed out after 60s"));
		}, COMMAND_TIMEOUT_MS);

		pending.set(id, { resolve, reject, timer });

		child!.stdin!.write(cmdStr + "\n", (err) => {
			if (err) {
				clearTimeout(timer);
				pending.delete(id);
				reject(new Error(`Send failed: ${err.message}`));
			}
		});
	});
}

export async function browser_close(): Promise<string> {
	if (!child || child.exitCode !== null) {
		return "Browser already closed";
	}

	try {
		await browser_command("close", {});
	} catch {
		// best effort
	}

	await new Promise<void>((resolve) => setTimeout(resolve, 500));

	if (child && child.exitCode === null) {
		child.kill();
	}
	child = null;
	rl = null;

	return "Browser closed";
}
