import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface AXEvent {
	event: string;
	app?: string;
	element?: string;
	role?: string;
	value?: string;
	title?: string;
	pid?: string;
}

type AXEventListener = (event: AXEvent) => void;

let observerProc: ChildProcess | null = null;
const listeners: Set<AXEventListener> = new Set();

// Same packaged-app helper resolution as misc.ts / cua.ts:
// `process.resourcesPath/helpers/<name>` is where extraResources stages our
// helpers in Samuel.app/Contents/Resources/. We must find it there (not
// inside app.asar via __dirname) because spawn against an asar path fails
// — the OS exec syscall doesn't understand asar virtualization.
function findHelper(name: string): string {
	const fromResources = join(process.resourcesPath, "helpers", name);
	if (existsSync(fromResources)) return fromResources;
	const fromCwd = join(process.cwd(), "helpers", name);
	if (existsSync(fromCwd)) return fromCwd;
	const fromDir = join(__dirname, "..", "..", "helpers", name);
	if (existsSync(fromDir)) return fromDir;
	return join("helpers", name);
}

export function onAXEvent(listener: AXEventListener): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export async function start_ax_observer(): Promise<string> {
	if (observerProc && !observerProc.killed) {
		return "AX Observer already running";
	}

	const helperPath = findHelper("ax-observer");
	if (!existsSync(helperPath)) {
		// Try compiling the Swift source
		const srcPath = helperPath + ".swift";
		if (!existsSync(srcPath)) {
			return "AX Observer helper not found";
		}
		// Use the Swift source directly
		observerProc = spawn("/usr/bin/swift", [srcPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	} else {
		observerProc = spawn(helperPath, [], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	if (observerProc.stdout) {
		const rl = createInterface({ input: observerProc.stdout });
		rl.on("line", (line) => {
			try {
				const event = JSON.parse(line) as AXEvent;
				for (const listener of listeners) {
					try { listener(event); } catch {}
				}
			} catch {
				// not JSON — ignore
			}
		});
	}

	if (observerProc.stderr) {
		observerProc.stderr.on("data", (data: Buffer) => {
			console.error(`[ax-observer] ${data.toString().trim()}`);
		});
	}

	observerProc.on("exit", (code) => {
		console.error(`[ax-observer] exited with code ${code}`);
		observerProc = null;
	});

	return "AX Observer started";
}

export async function stop_ax_observer(): Promise<string> {
	if (observerProc && !observerProc.killed) {
		observerProc.kill("SIGTERM");
		observerProc = null;
		return "AX Observer stopped";
	}
	return "AX Observer not running";
}

export async function ax_observer_status(): Promise<{ running: boolean; listeners: number }> {
	return {
		running: observerProc !== null && !observerProc.killed,
		listeners: listeners.size,
	};
}
