import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";

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

function resolveProjectRoot(): string {
	let dir = process.cwd();
	if (dir.endsWith("electron")) {
		dir = join(dir, "..");
	}
	return dir;
}

function ensureRunning(): void {
	if (child && child.exitCode === null) return;

	console.error("[browser] spawning browser-agent via npx tsx...");
	const projectRoot = resolveProjectRoot();
	console.error(`[browser] project root: ${projectRoot}`);

	const proc = spawn("npx", ["tsx", "src/lib/browser-agent.ts"], {
		cwd: projectRoot,
		stdio: ["pipe", "pipe", "pipe"],
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
		for (const [id, req] of pending) {
			clearTimeout(req.timer);
			req.reject(new Error("Browser agent process exited"));
			pending.delete(id);
		}
		child = null;
		rl = null;
	});

	console.error(`[browser] agent started (pid=${proc.pid})`);
}

// ── Public API ──────────────────────────────────────────────────────────

export async function browser_command(
	action: string,
	params: Record<string, unknown>,
): Promise<BrowserResult> {
	ensureRunning();

	if (!child?.stdin?.writable) {
		throw new Error("Browser agent not running");
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
