/**
 * Dynamic plugin loader for Samuel's self-modifying tool system.
 * Loads JS plugins from ~/.samuel/plugins/ via Tauri commands,
 * executes them with new Function(), and wraps them as FunctionTool objects
 * compatible with the @openai/agents SDK.
 *
 * Injected helpers available to all plugins:
 *   secrets.get("key_name") → Promise<string | null>
 *   invoke(command, args)   → Promise<unknown>  (Tauri backend commands)
 *   sleep(ms)               → Promise<void>
 */

import { invoke } from "@tauri-apps/api/core";
import type { FunctionTool } from "@openai/agents/realtime";

export interface PluginDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** Helper object injected into plugin scope for accessing stored secrets. */
const secretsHelper = {
  async get(name: string): Promise<string | null> {
    return invoke<string | null>("get_secret", { name });
  },
};

/** Invoke helper — gives plugins access to Tauri backend commands. */
const invokeHelper = async (
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> => {
  return invoke(command, args ?? {});
};

/** Sleep helper for timing delays. */
const sleepHelper = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Execute a plugin code string via new Function() and validate the result.
 * Plugin code uses `return { ... }` and can reference secrets, invoke, sleep.
 */
export function loadPlugin(code: string): PluginDefinition {
  // eslint-disable-next-line no-new-func
  const factory = new Function("secrets", "invoke", "sleep", code);
  const def = factory(secretsHelper, invokeHelper, sleepHelper);

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

/**
 * Wrap a validated PluginDefinition into a FunctionTool compatible
 * with @openai/agents SDK. The SDK's invoke() receives a JSON string
 * which we parse and pass to the plugin's execute().
 */
export function pluginToTool(def: PluginDefinition): FunctionTool {
  const params = {
    type: "object" as const,
    properties: def.parameters.properties,
    required: def.parameters.required ?? [],
    additionalProperties: true as const,
  };

  return {
    type: "function",
    name: def.name,
    description: def.description,
    parameters: params,
    strict: false,
    invoke: async (_ctx: unknown, input: string) => {
      const args = input ? JSON.parse(input) : {};
      try {
        const result = await def.execute(args);
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Plugin error: ${msg}`;
      }
    },
    needsApproval: async () => false,
    isEnabled: async () => true,
  } as FunctionTool;
}

// Plugins can override any core tool by using the same name —
// the mergeTools() helper in useRealtime handles deduplication.

/**
 * Load all plugins from ~/.samuel/plugins/ and return them as FunctionTool[].
 * Skips plugins that fail to load/validate.
 */
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
        console.log(`[plugins] loaded: ${def.name}`);
      } catch (err) {
        console.error(`[plugins] failed to load '${name}':`, err);
      }
    }
  } catch (err) {
    console.error("[plugins] failed to list plugins:", err);
  }

  return tools;
}
