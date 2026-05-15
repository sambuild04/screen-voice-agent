import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "samuel-ui-prefs";

// ── Schema-driven UI preferences ──────────────────────────────────────────
// Every adjustable property is declared once here. The schema drives state
// shape and CSS vars. SettingsPanel mutates this via applyUpdate; plugins
// can also call applyUIUpdate (session-bridge) to mutate the same state.

type PropType = "number" | "boolean" | "enum";

interface PropSchema {
  type: PropType;
  default: number | boolean | string;
  aliases: string[];  // alternate component.property names that map here
  // number-specific
  min?: number;
  max?: number;
  step?: number;      // relative adjustment step
  unit?: string;      // for CSS var output (e.g. "px", "")
  cssVar?: string;    // CSS custom property name, omit if no CSS var needed
  // enum-specific
  options?: string[];
}

const SCHEMA: Record<string, PropSchema> = {
  // ── Avatar ──
  "avatar.size": {
    type: "number", default: 320, min: 80, max: 800, step: 40, unit: "px",
    cssVar: "--samuel-size",
    aliases: ["samuel.size", "character.size", "agent.size", "self.size", "me.size",
              "avatar.font_size", "samuel.font_size"],
  },
  "avatar.opacity": {
    type: "number", default: 1, min: 0.1, max: 1, step: 0.15, unit: "",
    cssVar: "--samuel-opacity",
    aliases: ["samuel.opacity", "character.opacity", "agent.opacity"],
  },

  // ── Speech bubble ──
  "bubble.font_size": {
    type: "number", default: 15, min: 10, max: 32, step: 2, unit: "px",
    cssVar: "--bubble-font-size",
    aliases: ["speech_bubble.font_size", "speech_bubble.size", "bubble.size",
              "text.font_size", "text.size"],
  },
  "bubble.opacity": {
    type: "number", default: 1, min: 0.1, max: 1, step: 0.15, unit: "",
    cssVar: "--bubble-opacity",
    aliases: ["speech_bubble.opacity", "text.opacity"],
  },
  "bubble.max_width": {
    type: "number", default: 280, min: 150, max: 500, step: 40, unit: "px",
    cssVar: "--bubble-max-width",
    aliases: ["speech_bubble.max_width", "speech_bubble.width", "bubble.width"],
  },

  // ── Annotations ──
  "romaji.visible": {
    type: "boolean", default: true,
    aliases: [],
  },
  "reading.visible": {
    type: "boolean", default: true,
    aliases: ["furigana.visible", "pinyin.visible"],
  },

  // ── Teach viewer (annotated content panel) ──
  "teach.font_size": {
    type: "number", default: 14, min: 10, max: 28, step: 2, unit: "px",
    cssVar: "--teach-font-size",
    aliases: ["teach_viewer.font_size", "teach_viewer.size", "teach.size",
              "subtitle_bar.font_size", "subtitle_bar.size"],
  },
  "teach.opacity": {
    type: "number", default: 0.95, min: 0.3, max: 1, step: 0.1, unit: "",
    cssVar: "--teach-opacity",
    aliases: ["teach_viewer.opacity"],
  },

  // ── Transcript / chat area ──
  "transcript.font_size": {
    type: "number", default: 14, min: 10, max: 24, step: 2, unit: "px",
    cssVar: "--transcript-font-size",
    aliases: ["chat.font_size", "chat.size", "transcript.size"],
  },

  // ── Global app ──
  "app.background_opacity": {
    type: "number", default: 0.85, min: 0.2, max: 1, step: 0.1, unit: "",
    cssVar: "--app-bg-opacity",
    aliases: ["background.opacity", "window.opacity"],
  },
  "app.accent_color": {
    type: "enum", default: "indigo",
    options: ["indigo", "cyan", "violet", "emerald", "rose", "amber", "slate"],
    cssVar: "--accent-hue",
    aliases: ["theme.accent", "theme.color", "app.theme", "app.color"],
  },
  "app.border_radius": {
    type: "number", default: 14, min: 0, max: 30, step: 4, unit: "px",
    cssVar: "--app-radius",
    aliases: ["theme.roundness", "app.roundness"],
  },

  // ── Window size ──
  "window.width": {
    type: "number", default: 520, min: 400, max: 1200, step: 50, unit: "px",
    aliases: ["app.width", "window.size"],
  },
  "window.height": {
    type: "number", default: 740, min: 400, max: 1200, step: 50, unit: "px",
    aliases: ["app.height"],
  },

  // ── Volume ──
  "volume.samuel": {
    type: "number", default: 80, min: 0, max: 100, step: 10, unit: "%",
    aliases: ["volume.voice", "volume.output", "samuel.volume", "voice.volume"],
  },

  // ── Privacy (non-visual but voice-toggleable) ──
  "privacy.screen_watch": {
    type: "boolean", default: false,
    aliases: ["privacy.screen_watch_enabled", "privacy.screen"],
  },
  "privacy.audio_listen": {
    type: "boolean", default: false,
    aliases: ["privacy.audio_listen_enabled", "privacy.audio", "privacy.microphone"],
  },
  "privacy.local_time": {
    type: "boolean", default: false,
    aliases: ["privacy.local_time_enabled", "privacy.time"],
  },
  "privacy.location": {
    type: "boolean", default: false,
    aliases: ["privacy.location_enabled"],
  },
};

// Build reverse lookup: alias → canonical key
const ALIAS_MAP = new Map<string, string>();
for (const [canonical, schema] of Object.entries(SCHEMA)) {
  ALIAS_MAP.set(canonical, canonical);
  for (const alias of schema.aliases) {
    ALIAS_MAP.set(alias, canonical);
  }
}

// ── State type derived from schema ──
export type UIPreferences = Record<string, number | boolean | string>;

function buildDefaults(): UIPreferences {
  const d: UIPreferences = {};
  for (const [key, s] of Object.entries(SCHEMA)) {
    d[key] = s.default;
  }
  return d;
}

const DEFAULTS = buildDefaults();

function loadPrefs(): UIPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Migrate legacy keys
      const migrated = migratePrefs(saved);
      return { ...DEFAULTS, ...migrated };
    }
  } catch {}
  return { ...DEFAULTS };
}

function migratePrefs(saved: Record<string, unknown>): UIPreferences {
  const result: UIPreferences = {};
  const LEGACY_MAP: Record<string, string> = {
    samuel_size: "avatar.size",
    samuel_opacity: "avatar.opacity",
    bubble_font_size: "bubble.font_size",
    romaji_visible: "romaji.visible",
    reading_visible: "reading.visible",
    teach_font_size: "teach.font_size",
    screen_watch_enabled: "privacy.screen_watch",
    audio_listen_enabled: "privacy.audio_listen",
    local_time_enabled: "privacy.local_time",
    location_enabled: "privacy.location",
  };
  for (const [k, v] of Object.entries(saved)) {
    const newKey = LEGACY_MAP[k] ?? k;
    if (newKey in SCHEMA) {
      result[newKey] = v as number | boolean | string;
    }
  }
  return result;
}

function savePrefs(prefs: UIPreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Maps natural language relative values to numeric deltas
function resolveNumeric(current: number, value: string, step: number): number {
  const lower = value.toLowerCase().trim();
  const mag = (lower.includes("much") || lower.includes("a lot")) ? 3
    : (lower.includes("little") || lower.includes("bit") || lower.includes("slight")) ? 0.5
    : 1;

  // Increase: larger, bigger, wider, right, down (positional), further, more
  if (
    lower.includes("larger") || lower.includes("bigger") || lower.includes("increase") ||
    lower.includes("expand") || lower.includes("wider") || lower.includes("taller") ||
    lower.includes("brighter") || lower.includes("more visible") ||
    lower.includes("right") || lower.includes("further") ||
    lower === "more" || lower === "up"
  ) {
    return current + Math.ceil(step * mag);
  }

  // Decrease: smaller, narrower, left (positional), closer, less
  if (
    lower.includes("smaller") || lower.includes("less") || lower.includes("reduce") ||
    lower.includes("shrink") || lower.includes("decrease") || lower.includes("narrower") ||
    lower.includes("shorter") || lower.includes("dimmer") || lower.includes("less visible") ||
    lower.includes("left") || lower.includes("closer") ||
    lower.includes("tiny") || lower === "down"
  ) {
    return current - Math.ceil(step * mag);
  }

  if (lower === "default" || lower === "reset" || lower === "original") return NaN;

  const num = parseFloat(lower);
  if (!isNaN(num)) return num;
  return current;
}

function resolveBool(value: string): boolean {
  const lower = value.toLowerCase().trim();
  return !(
    lower === "false" || lower === "off" || lower === "hide" ||
    lower === "no" || lower === "disable" || lower === "disabled"
  );
}

function resolveEnum(value: string, options: string[]): string | null {
  const lower = value.toLowerCase().trim();
  // Direct match
  const exact = options.find(o => o === lower);
  if (exact) return exact;
  // Partial match
  const partial = options.find(o => lower.includes(o));
  if (partial) return partial;
  // Semantic mapping for common patterns
  const semanticMap: Record<string, string[]> = {
    auto: ["automatic", "proactive", "ambient", "on"],
    manual: ["on_demand", "off", "stop", "disable"],
  };
  for (const [opt, synonyms] of Object.entries(semanticMap)) {
    if (options.includes(opt) && synonyms.some(s => lower.includes(s))) return opt;
  }
  return null;
}

// ── Accent color hue map (for CSS var) ──
const ACCENT_HUES: Record<string, string> = {
  indigo: "239",
  cyan: "188",
  violet: "270",
  emerald: "160",
  rose: "350",
  amber: "38",
  slate: "215",
};

// ── Exported types ──
export type UIUpdatePayload = {
  component: string;
  property: string;
  value: string;
};

export interface UseUIPreferencesReturn {
  prefs: UIPreferences;
  applyUpdate: (payload: UIUpdatePayload) => string;
  resetAll: () => void;
  cssVars: Record<string, string>;
}

export function useUIPreferences(): UseUIPreferencesReturn {
  const [prefs, setPrefs] = useState<UIPreferences>(loadPrefs);

  useEffect(() => { savePrefs(prefs); }, [prefs]);

  const applyUpdate = useCallback(
    (payload: UIUpdatePayload): string => {
      const { component, property, value } = payload;
      const rawKey = `${component}.${property}`;
      console.log(`[ui-prefs] applyUpdate: ${rawKey} = ${value}`);

      // Global reset
      if (
        (component === "all" || component === "everything") &&
        (property === "reset" || value.toLowerCase() === "reset")
      ) {
        setPrefs({ ...DEFAULTS });
        return "Reset all UI settings to defaults.";
      }

      // Resolve the canonical key
      const canonical = ALIAS_MAP.get(rawKey);
      if (!canonical) {
        // Try fuzzy: component matches a prefix in SCHEMA keys
        const fuzzy = Object.keys(SCHEMA).find(k =>
          k.startsWith(`${component}.`) && k.endsWith(`.${property}`)
        );
        if (!fuzzy) {
          console.warn(`[ui-prefs] unknown setting: ${rawKey}`);
          return `Unknown setting: ${rawKey}.`;
        }
        return applyOne(fuzzy, value);
      }

      return applyOne(canonical, value);
    },
    [],
  );

  function applyOne(canonical: string, value: string): string {
    const schema = SCHEMA[canonical];
    if (!schema) return `Unknown setting: ${canonical}`;

    setPrefs((prev) => {
      const next = { ...prev };

      if (schema.type === "number") {
        const current = (prev[canonical] as number) ?? (schema.default as number);
        const resolved = resolveNumeric(current, value, schema.step ?? 1);
        const clamped = isNaN(resolved)
          ? (schema.default as number)
          : clamp(resolved, schema.min ?? 0, schema.max ?? 9999);
        next[canonical] = clamped;
      } else if (schema.type === "boolean") {
        next[canonical] = resolveBool(value);
      } else if (schema.type === "enum" && schema.options) {
        const resolved = resolveEnum(value, schema.options);
        if (resolved !== null) next[canonical] = resolved;
      }

      return next;
    });

    return `Updated ${canonical} to ${value}.`;
  }

  const resetAll = useCallback(() => { setPrefs({ ...DEFAULTS }); }, []);

  // Build CSS variables from schema
  const cssVars = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const [key, schema] of Object.entries(SCHEMA)) {
      if (!schema.cssVar) continue;
      const val = prefs[key] ?? schema.default;

      // Special: accent color → hue number
      if (key === "app.accent_color") {
        vars[schema.cssVar] = ACCENT_HUES[val as string] ?? ACCENT_HUES.indigo;
        continue;
      }

      const suffix = schema.unit === "px" ? "px"
        : schema.unit === "s" ? "s"
        : "";
      vars[schema.cssVar] = `${val}${suffix}`;
    }

    return vars;
  }, [prefs]);

  return { prefs, applyUpdate, resetAll, cssVars };
}

// ── Exported for tool descriptions ──
export function getUISchemaDescription(): string {
  const lines: string[] = [];
  for (const [key, s] of Object.entries(SCHEMA)) {
    let desc = `- ${key}: ${s.type}`;
    if (s.type === "number") desc += ` (${s.min}–${s.max}, step ${s.step})`;
    if (s.type === "enum" && s.options) desc += ` (${s.options.join(" | ")})`;
    if (s.type === "boolean") desc += ` (true/false, show/hide, on/off)`;
    desc += ` [default: ${s.default}]`;
    lines.push(desc);
  }
  return lines.join("\n");
}
