import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, copyFileSync } from "node:fs";
import { join, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import { callOpenai, callOpenaiReasoning, stripFences } from "./llm.js";

const SAMUEL_DIR = ".samuel";
const PLUGINS_DIR = "plugins";

function pluginsDir(): string {
	const dir = join(homedir(), SAMUEL_DIR, PLUGINS_DIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function safeName(name: string): string {
	const clean = name
		.trim()
		.replace(/[/\\]/g, "")
		.replace(/\.\./g, "")
		.replace(/ /g, "_");
	if (!clean || clean.startsWith(".")) {
		throw new Error("Invalid plugin name");
	}
	return clean;
}

export async function get_plugin_dir(): Promise<string> {
	return pluginsDir();
}

export async function list_plugins(): Promise<string[]> {
	const dir = pluginsDir();
	const entries = readdirSync(dir);
	const names: string[] = [];
	for (const entry of entries) {
		const parsed = parsePath(entry);
		if (parsed.ext === ".js") {
			names.push(parsed.name);
		}
	}
	names.sort();
	return names;
}

export async function read_plugin(args: { name: string }): Promise<string> {
	const clean = safeName(args.name);
	const path = join(pluginsDir(), `${clean}.js`);
	try {
		return readFileSync(path, "utf-8");
	} catch (err) {
		throw new Error(`Read plugin '${clean}': ${err}`);
	}
}

export async function write_plugin(args: { name: string; code: string }): Promise<string> {
	const clean = safeName(args.name);
	const dir = pluginsDir();
	const path = join(dir, `${clean}.js`);

	if (existsSync(path)) {
		const backup = join(dir, `${clean}.js.backup`);
		try {
			copyFileSync(path, backup);
			console.error(`[plugins] backed up ${clean}.js → ${clean}.js.backup`);
		} catch {
			// ignore backup failures
		}
	}

	writeFileSync(path, args.code);
	console.error(`[plugins] wrote ${clean}.js (${args.code.length} bytes)`);
	return `Plugin '${clean}' saved.`;
}

export async function delete_plugin(args: { name: string }): Promise<string> {
	const clean = safeName(args.name);
	const path = join(pluginsDir(), `${clean}.js`);
	if (existsSync(path)) {
		unlinkSync(path);
		console.error(`[plugins] deleted ${clean}.js`);
		return `Plugin '${clean}' removed.`;
	}
	throw new Error(`Plugin '${clean}' not found.`);
}

// ── Code generation (GPT-5.5 with reasoning) ────────────────────────────────

const PLUGIN_SYSTEM_PROMPT = `You are a code generator for a desktop app plugin system.
Generate a JavaScript plugin file that will be executed via \`new Function("secrets", "invoke", "sleep", "ui", code)(...)\`.

The plugin MUST follow this exact shape — use \`return { ... }\` at the top level:

\`\`\`
return {
  name: "tool_name",
  description: "What this tool does",
  parameters: {
    type: "object",
    properties: {
      param1: { type: "string", description: "..." }
    },
    required: ["param1"]
  },
  // REQUIRED: validation function that checks if output looks correct
  validates: (result) => {
    // Return true if the result looks right, false otherwise
    // Example: result != null && typeof result === "string" && result.length > 0
    return result != null;
  },
  execute: async (args) => {
    // Implementation here
    // Available APIs:
    //
    // ── Data / network ──
    //   fetch() — make HTTP requests to any URL
    //   fetch("https://r.jina.ai/" + url) — read any URL as clean LLM-friendly text (free, no key)
    //   fetch("https://s.jina.ai/" + encodeURIComponent(query)) — search the web (free, no key)
    //   secrets.get("key_name") — get a stored API key (returns Promise<string|null>)
    //   invoke(command, args) — call backend commands (returns Promise<unknown>)
    //     invoke("web_search", { query: "...", page: 1 }) — search the web
    //     invoke("web_read", { url: "..." }) — fetch and read a web page
    //     invoke("browser_command", { action: "open", params: { url: "..." } }) — control browser
    //   sleep(ms) — wait for a duration (returns Promise<void>)
    //
    // ── UI modification ──
    //   ui.set(component, property, value) — change any UI property
    //   ui.injectCSS(id, cssString) — add or replace a custom <style> block
    //   ui.removeCSS(id) — remove an injected style block
    //   ui.showPanel(id, html, opts?) — create a floating HTML overlay panel
    //     opts: { position: "right"|"left"|"center"|"bottom", width: "300px" }
    //   ui.hidePanel(id) — remove a custom panel
    //
    //   JSON.parse/stringify, Date, Math, etc.
    // Return a string result (or JSON.stringify-able)
    return "result";
  }
};
\`\`\`

WRAPPING EXISTING TOOLS (optional — use when extending, not replacing):
\`\`\`
return {
  name: "enhanced_web_browse",
  wraps: "web_browse",   // declares this wraps the existing web_browse tool
  description: "Enhanced web browse with caching",
  parameters: { ... },   // same or extended parameters
  validates: (result) => result != null,
  execute: async (args, original) => {
    // \`original\` is the wrapped tool's execute function
    const result = await original(args);
    // modify or enhance the result
    return result;
  }
};
\`\`\`

Rules:
- ONLY output the raw JavaScript code, no markdown fences, no explanation
- The code runs inside new Function("secrets", "invoke", "sleep", "ui", code)
- ALWAYS include a \`validates\` function that checks the output is correct
- execute() must return a string (or something JSON.stringify-able)
- If an API key is needed and secrets.get() returns null, return a clear message asking for the key
- Use fetch() for any web API calls
- Prefer well-documented stable APIs with free tiers
- When creating visual panels (ui.showPanel), use clean semantic HTML with inline styles matching the dark glass theme
- Keep it simple and self-contained — no imports
- Handle errors gracefully — catch and return descriptive messages, don't let errors crash silently`;

export async function generate_plugin_code(args: { description: string }): Promise<string> {
	const raw = await callOpenaiReasoning(
		"gpt-5.5",
		PLUGIN_SYSTEM_PROMPT,
		args.description,
		"medium",
		4000,
	);
	const code = stripFences(raw);
	console.error(`[plugins] generated code (${code.length} bytes) via gpt-5.5`);
	return code;
}

export async function judge_plugin_code(args: { description: string; code: string }): Promise<string> {
	const systemPrompt = `You are a code reviewer for an AI assistant's plugin system.
Given a user's request and the generated JavaScript plugin code, determine if the code
correctly implements what was requested.

Check for:
- Does the code actually do what the user asked? (not a different feature)
- Are API endpoints plausible and correctly used?
- Does the execute() function return a meaningful result?
- Does it include a validates() function?
- Are there obvious logic errors?
- Does it handle errors gracefully?

Reply ONLY with valid JSON, no other text:
- If the code is correct: { "ok": true }
- If there's an issue: { "ok": false, "reason": "brief description of the problem" }`;

	const userMsg = `REQUEST: ${args.description}\n\nCODE:\n\`\`\`\n${args.code}\n\`\`\``;

	const raw = await callOpenai("gpt-4o-mini", systemPrompt, userMsg, 0.1, 500);
	const clean = stripFences(raw);

	try {
		const v = JSON.parse(clean);
		if (v.ok === true) {
			console.error("[plugins] judge: ok");
			return "ok";
		}
		const reason = typeof v.reason === "string" ? v.reason : "Unknown issue";
		console.error(`[plugins] judge flagged: ${reason}`);
		return reason;
	} catch {
		console.error("[plugins] judge: unparseable response, treating as ok");
		return "ok";
	}
}

export async function diagnose_plugin_failure(args: {
	plugin_name: string;
	plugin_source: string;
	input_args: string;
	error_message: string;
	actual_output: string;
	signal: string;
}): Promise<string> {
	const systemPrompt = `You are diagnosing an AI-generated plugin failure. Output ONLY valid JSON.

Categorize the failure as ONE of:
- "syntax_logic"       → wrong code, fixable by patching
- "wrong_assumption"   → code assumed something untrue about the API/data
- "external_change"    → API/page/service changed since plugin was written
- "wrong_input"        → code is correct, input is malformed or unexpected
- "structural"         → overall approach is wrong, needs full rewrite
- "environmental"      → sandbox/permission/network issue
- "unknown"            → can't determine from available info

Then specify next_step as ONE of:
- "patch"              → apply a targeted fix to the existing code
- "rewrite"            → regenerate from scratch with a new approach
- "ask_user"           → need user input/clarification to proceed
- "give_up"            → not fixable autonomously, explain why

Output this exact JSON shape:
{
  "category": "...",
  "evidence": "1-sentence explanation of why this category",
  "next_step": "...",
  "user_facing_summary": "1-sentence plain-language explanation for the user"
}`;

	const userMsg =
		`PLUGIN: ${args.plugin_name}\nSIGNAL: ${args.signal}\n` +
		`ERROR: ${args.error_message}\n` +
		`OUTPUT: ${args.actual_output}\n` +
		`INPUT: ${args.input_args}\n\n` +
		`SOURCE:\n\`\`\`\n${args.plugin_source}\n\`\`\``;

	const raw = await callOpenaiReasoning("gpt-5.5", systemPrompt, userMsg, "high", 1000);
	const clean = stripFences(raw);

	const fallback = (reason: string) =>
		JSON.stringify({
			category: "unknown",
			evidence: reason,
			next_step: "patch",
			user_facing_summary: `The plugin '${args.plugin_name}' had an issue. Let me try to fix it.`,
		});

	try {
		const v = JSON.parse(clean);
		if (v.category && v.next_step) {
			return clean;
		}
		return fallback("Diagnosis response missing required fields");
	} catch {
		return fallback("Could not parse diagnosis");
	}
}
