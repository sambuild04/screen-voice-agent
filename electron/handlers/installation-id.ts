import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const SAMUEL_DIR = ".samuel";
const ID_FILE = "installation-id";

// A stable per-install UUID, generated once on first launch and never
// rotated. The Cloudflare Worker uses this as the rate-limit bucket key
// — one trial allotment per installation, not per IP, so behind-NAT
// users (cafes, work networks) don't share quota.
//
// File is plaintext (just the UUID, no envelope) so it's trivially
// inspectable and resettable: `rm ~/.samuel/installation-id` gives the
// user a fresh trial. That's a feature, not a bug — abusers willing to
// `rm` a file every day already had cheaper options (multiple Macs,
// VMs). The proxy applies a per-IP secondary cap to keep that path from
// being a one-line bypass.

let cached: string | null = null;

function idPath(): string {
	const dir = join(homedir(), SAMUEL_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, ID_FILE);
}

function isValidUuid(s: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function getInstallationId(): string {
	if (cached) return cached;
	const path = idPath();
	try {
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf-8").trim();
			if (isValidUuid(raw)) {
				cached = raw;
				return raw;
			}
			// Corrupted file — overwrite with a fresh one.
		}
	} catch {
		// Read failure (permissions etc.) — fall through to creation.
	}
	const fresh = randomUUID();
	try {
		writeFileSync(path, fresh, "utf-8");
	} catch (err) {
		// If we can't persist, returning the in-memory value is still
		// correct for this session, but next launch will mint a new one.
		// Better than throwing and breaking the app.
		console.error(`[installation-id] failed to persist: ${String(err)}`);
	}
	cached = fresh;
	return fresh;
}

export async function get_installation_id(): Promise<string> {
	return getInstallationId();
}
