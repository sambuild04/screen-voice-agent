/**
 * Dynamic plugin loader for Samuel's self-modifying tool system.
 *
 * Features:
 * - Load/execute JS plugins from ~/.samuel/plugins/ via new Function()
 * - Validates field: plugins declare what correct output looks like
 * - Wraps pattern: plugins can extend existing tools via middleware
 * - Repair pipeline: detect → diagnose → repair → verify (max 2 attempts)
 * - Execution tracking: last plugin run is recorded for feedback-triggered repair
 *
 * Injected helpers available to all plugins:
 *   secrets.get("key_name")      → Promise<string | null>
 *   invoke(command, args)         → Promise<unknown>  (backend IPC commands)
 *   sleep(ms)                     → Promise<void>
 *   ui.set(component, prop, val)  → string  (change any UI property)
 *   ui.injectCSS(id, css)         → void    (add/replace a <style> block)
 *   ui.removeCSS(id)              → void    (remove an injected <style>)
 *   ui.showPanel(id, html, opts)  → void    (render a custom HTML overlay)
 *   ui.hidePanel(id)              → void    (remove a custom overlay)
 */

import { invoke } from "./invoke-bridge";
import type { FunctionTool } from "@openai/agents/realtime";
import { applyUIUpdate } from "./session-bridge";

// ── Plugin definition with validates + wraps ─────────────────────────────

export interface PluginDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>, original?: (args: Record<string, unknown>) => Promise<unknown>) => unknown | Promise<unknown>;
  /** Optional validation — returns true if the output looks correct */
  validates?: (result: unknown) => boolean;
  /** If set, this plugin wraps an existing tool instead of replacing it */
  wraps?: string;
}

// ── Repair tracking ──────────────────────────────────────────────────────

export interface PluginExecution {
  pluginName: string;
  args: Record<string, unknown>;
  result: unknown;
  error: string | null;
  validationPassed: boolean | null;
  timestamp: number;
}

let lastExecution: PluginExecution | null = null;
export function getLastExecution(): PluginExecution | null { return lastExecution; }

export interface RepairResult {
  success: boolean;
  action: string;
  message: string;
  attempts: number;
}

// ── Injected helpers ─────────────────────────────────────────────────────

const secretsHelper = {
  async get(name: string): Promise<string | null> {
    return invoke<string | null>("get_secret", { name });
  },
};

const invokeHelper = async (
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> => {
  return invoke(command, args ?? {});
};

const sleepHelper = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const uiHelper = {
  set(component: string, property: string, value: string): string {
    return applyUIUpdate(component, property, value);
  },

  injectCSS(id: string, css: string): void {
    const existing = document.getElementById(`plugin-css-${id}`);
    if (existing) {
      existing.textContent = css;
      return;
    }
    const style = document.createElement("style");
    style.id = `plugin-css-${id}`;
    style.textContent = css;
    document.head.appendChild(style);
  },

  removeCSS(id: string): void {
    document.getElementById(`plugin-css-${id}`)?.remove();
  },

  showPanel(id: string, html: string, opts?: { position?: string; width?: string; className?: string }): void {
    let panel = document.getElementById(`plugin-panel-${id}`);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = `plugin-panel-${id}`;
      panel.style.cssText = `
        position: fixed; z-index: 200; pointer-events: auto;
        background: rgba(10, 14, 30, 0.85); backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border: 1px solid rgba(99, 102, 241, 0.2); border-radius: 14px;
        padding: 12px; color: #e2e8f0; font-size: 13px;
        box-shadow: 0 0 20px rgba(99, 102, 241, 0.1);
        animation: panel-fade-in 0.3s ease both;
        overflow-y: auto; max-height: 80vh;
      `;
      const pos = opts?.position ?? "right";
      if (pos === "right") {
        panel.style.right = "12px";
        panel.style.top = "60px";
      } else if (pos === "left") {
        panel.style.left = "12px";
        panel.style.top = "60px";
      } else if (pos === "center") {
        panel.style.left = "50%";
        panel.style.top = "50%";
        panel.style.transform = "translate(-50%, -50%)";
      } else if (pos === "bottom") {
        panel.style.bottom = "60px";
        panel.style.left = "12px";
        panel.style.right = "12px";
      }
      if (opts?.width) panel.style.width = opts.width;
      if (opts?.className) panel.classList.add(opts.className);
      document.body.appendChild(panel);
    }
    panel.innerHTML = html;
  },

  hidePanel(id: string): void {
    document.getElementById(`plugin-panel-${id}`)?.remove();
  },
};

// ── Core plugin loading ──────────────────────────────────────────────────

export function loadPlugin(code: string): PluginDefinition {
  const factory = new Function("secrets", "invoke", "sleep", "ui", code);
  const def = factory(secretsHelper, invokeHelper, sleepHelper, uiHelper);

  if (!def || typeof def !== "object") {
    throw new Error("Plugin did not return an object");
  }
  if (typeof def.name !== "string" || !def.name) {
    throw new Error("Plugin missing 'name' (string)");
  }
  if (typeof def.description !== "string") {
    throw new Error("Plugin missing 'description' (string)");
  }
  if (
    !def.parameters ||
    def.parameters.type !== "object" ||
    typeof def.parameters.properties !== "object"
  ) {
    throw new Error("Plugin missing valid 'parameters' (JSON Schema object)");
  }
  if (typeof def.execute !== "function") {
    throw new Error("Plugin missing 'execute' (function)");
  }

  return def as PluginDefinition;
}

// ── Tool registry for wraps pattern ──────────────────────────────────────

const coreToolExecutors = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

export function registerCoreToolExecutor(name: string, fn: (args: Record<string, unknown>) => Promise<unknown>) {
  coreToolExecutors.set(name, fn);
}

// ── Plugin → FunctionTool conversion with validates + tracking ───────────

export function pluginToTool(def: PluginDefinition): FunctionTool {
  const params = {
    type: "object" as const,
    properties: def.parameters.properties,
    required: def.parameters.required ?? [],
    additionalProperties: true as const,
  };

  // Resolve the original executor if this is a wrapping plugin
  const originalFn = def.wraps ? coreToolExecutors.get(def.wraps) : undefined;

  return {
    type: "function",
    name: def.wraps ?? def.name,
    description: def.description,
    parameters: params,
    strict: false,
    invoke: async (_ctx: unknown, input: string) => {
      const args = input ? JSON.parse(input) : {};
      let result: unknown;
      let error: string | null = null;
      let validationPassed: boolean | null = null;

      try {
        result = await def.execute(args, originalFn);

        // Run validates check if present
        if (def.validates) {
          validationPassed = def.validates(result);
          if (!validationPassed) {
            error = `Output validation failed — plugin returned: ${JSON.stringify(result).slice(0, 200)}`;
            console.warn(`[plugin:${def.name}] validation failed`, result);
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        result = null;
      }

      // Track this execution for feedback-triggered repair
      lastExecution = {
        pluginName: def.name,
        args,
        result,
        error,
        validationPassed,
        timestamp: Date.now(),
      };

      if (error && !validationPassed) {
        // Auto-trigger repair for runtime errors and validation failures
        console.log(`[plugin:${def.name}] failure detected, triggering repair...`);
        const repairResult = await triggerRepair(def.name, args, result, error, "auto");
        if (repairResult.success) {
          return JSON.stringify({
            ok: true,
            message: repairResult.message,
            repaired: true,
            original_error: error,
          });
        }
        return JSON.stringify({
          ok: false,
          error,
          repair_attempted: true,
          repair_message: repairResult.message,
        });
      }

      return typeof result === "string" ? result : JSON.stringify(result);
    },
    needsApproval: async () => false,
    isEnabled: async () => true,
  } as FunctionTool;
}

// ── Repair pipeline: detect → diagnose → repair → verify ─────────────────

const MAX_REPAIR_ATTEMPTS = 2;
const repairHistory = new Map<string, number>(); // pluginName → consecutive failures

interface DiagnosisResult {
  category: string;
  evidence: string;
  next_step: string;
  user_facing_summary: string;
}

async function diagnoseFailure(
  pluginName: string,
  source: string,
  args: Record<string, unknown>,
  error: string | null,
  result: unknown,
  signal: string,
): Promise<DiagnosisResult> {
  try {
    const diagResult = await invoke<string>("diagnose_plugin_failure", {
      pluginName,
      pluginSource: source,
      inputArgs: JSON.stringify(args),
      errorMessage: error ?? "",
      actualOutput: JSON.stringify(result).slice(0, 2000),
      signal,
    });
    return JSON.parse(diagResult);
  } catch {
    return {
      category: "unknown",
      evidence: "Diagnosis call failed",
      next_step: "give_up",
      user_facing_summary: `The plugin "${pluginName}" encountered an issue I couldn't diagnose.`,
    };
  }
}

export async function triggerRepair(
  pluginName: string,
  args: Record<string, unknown>,
  result: unknown,
  error: string | null,
  signal: string,
  userFeedback?: string,
): Promise<RepairResult> {
  const attempts = repairHistory.get(pluginName) ?? 0;
  if (attempts >= MAX_REPAIR_ATTEMPTS) {
    repairHistory.delete(pluginName);
    return {
      success: false,
      action: "escalated",
      message: `I tried to fix "${pluginName}" ${MAX_REPAIR_ATTEMPTS} times without success. ${error ?? "The output wasn't right."}`,
      attempts,
    };
  }

  repairHistory.set(pluginName, attempts + 1);

  // Step 1: Read the plugin source
  let source: string;
  try {
    source = await invoke<string>("read_plugin", { name: pluginName });
  } catch {
    return {
      success: false,
      action: "no_source",
      message: `Couldn't read the source of plugin "${pluginName}" for repair.`,
      attempts: attempts + 1,
    };
  }

  // Step 2: Diagnose
  const diagnosis = await diagnoseFailure(pluginName, source, args, error, result, signal);
  console.log(`[repair:${pluginName}] diagnosis:`, diagnosis);

  // Step 3: Route based on diagnosis
  if (diagnosis.next_step === "give_up") {
    repairHistory.delete(pluginName);
    return {
      success: false,
      action: "give_up",
      message: diagnosis.user_facing_summary,
      attempts: attempts + 1,
    };
  }

  if (diagnosis.next_step === "ask_user") {
    return {
      success: false,
      action: "ask_user",
      message: diagnosis.user_facing_summary,
      attempts: attempts + 1,
    };
  }

  // Step 4: Generate repair (patch or full rewrite)
  const repairContext = userFeedback
    ? `\nUser feedback: ${userFeedback}`
    : "";

  const repairDescription =
    diagnosis.next_step === "patch"
      ? `FIX THIS PLUGIN (targeted patch):\n` +
        `Plugin: ${pluginName}\nError: ${error ?? "validation failed"}\n` +
        `Diagnosis: ${diagnosis.category} — ${diagnosis.evidence}\n` +
        `Current code:\n\`\`\`\n${source}\n\`\`\`\n` +
        `Input that failed: ${JSON.stringify(args)}\n` +
        `Output: ${JSON.stringify(result).slice(0, 500)}${repairContext}\n` +
        `Apply a minimal fix. Keep working logic intact.`
      : `REWRITE THIS PLUGIN from scratch:\n` +
        `Plugin: ${pluginName}\nOriginal intent from description in source.\n` +
        `Previous version failed with: ${error ?? "wrong output"}\n` +
        `Diagnosis: ${diagnosis.category} — ${diagnosis.evidence}${repairContext}\n` +
        `Old code for reference:\n\`\`\`\n${source}\n\`\`\`\n` +
        `Write a new version that handles this case correctly.`;

  try {
    const newCode = await invoke<string>("generate_plugin_code", { description: repairDescription });

    // Step 5: Verify — does it load?
    try {
      loadPlugin(newCode);
    } catch (loadErr) {
      const msg = loadErr instanceof Error ? loadErr.message : String(loadErr);
      console.warn(`[repair:${pluginName}] new code failed to load: ${msg}`);
      return {
        success: false,
        action: "verify_failed",
        message: `I generated a fix but it had a syntax error: ${msg}`,
        attempts: attempts + 1,
      };
    }

    // Step 6: Install the repaired version
    await invoke<string>("write_plugin", { name: pluginName, code: newCode });
    repairHistory.delete(pluginName);

    return {
      success: true,
      action: diagnosis.next_step,
      message: diagnosis.user_facing_summary + " I've applied the fix.",
      attempts: attempts + 1,
    };
  } catch (genErr) {
    const msg = genErr instanceof Error ? genErr.message : String(genErr);
    return {
      success: false,
      action: "generation_failed",
      message: `I tried to repair "${pluginName}" but code generation failed: ${msg}`,
      attempts: attempts + 1,
    };
  }
}

// ── Load all plugins ─────────────────────────────────────────────────────

export async function loadAllPlugins(): Promise<FunctionTool[]> {
  const tools: FunctionTool[] = [];

  try {
    const names = await invoke<string[]>("list_plugins");
    console.log(`[plugins] found ${names.length} plugin(s):`, names);

    for (const name of names) {
      try {
        const code = await invoke<string>("read_plugin", { name });
        const def = loadPlugin(code);
        tools.push(pluginToTool(def));
        console.log(`[plugins] loaded: ${def.name}${def.wraps ? ` (wraps ${def.wraps})` : ""}${def.validates ? " [validates]" : ""}`);
      } catch (err) {
        console.error(`[plugins] failed to load '${name}':`, err);
      }
    }
  } catch (err) {
    console.error("[plugins] failed to list plugins:", err);
  }

  return tools;
}
