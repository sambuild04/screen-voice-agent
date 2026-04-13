import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "samuel-ui-prefs";

export type VocabCardMode = "manual" | "auto";

export interface UIPreferences {
  samuel_size: number;        // px, default 320
  samuel_opacity: number;     // 0-1, default 1
  bubble_font_size: number;   // px, default 15
  vocab_card_visible: boolean;
  vocab_card_position: "left" | "right";
  vocab_card_interval: number; // seconds between cards, default 45
  vocab_card_mode: VocabCardMode; // manual = only on request, auto = ambient cards
  romaji_visible: boolean;
  reading_visible: boolean;   // furigana/pinyin
  teach_font_size: number;    // px, default 14
}

const DEFAULTS: UIPreferences = {
  samuel_size: 320,
  samuel_opacity: 1,
  bubble_font_size: 15,
  vocab_card_visible: true,
  vocab_card_position: "right",
  vocab_card_interval: 45,
  vocab_card_mode: "manual",
  romaji_visible: true,
  reading_visible: true,
  teach_font_size: 14,
};

function loadPrefs(): UIPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

function savePrefs(prefs: UIPreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// Maps natural language relative values to numeric deltas
function resolveValue(
  current: number,
  value: string,
  step: number,
): number {
  const lower = value.toLowerCase().trim();

  // Increase
  if (lower.includes("larger") || lower.includes("bigger") || lower.includes("increase") || lower.includes("expand") || lower === "more" || lower === "up") {
    const magnitude = (lower.includes("much") || lower.includes("a lot")) ? 3
      : (lower.includes("little") || lower.includes("bit") || lower.includes("slight")) ? 0.5
      : 1;
    return current + Math.ceil(step * magnitude);
  }

  // Decrease
  if (lower.includes("smaller") || lower.includes("less") || lower.includes("reduce") || lower.includes("shrink") || lower.includes("decrease") || lower.includes("tiny") || lower === "down") {
    const magnitude = (lower.includes("much") || lower.includes("a lot") || lower.includes("tiny") || lower.includes("smallest") || lower.includes("minimum")) ? 3
      : (lower.includes("little") || lower.includes("bit") || lower.includes("slight")) ? 0.5
      : 1;
    return current - Math.ceil(step * magnitude);
  }

  // Reset
  if (lower === "default" || lower === "reset" || lower === "original")
    return NaN; // caller handles reset

  // Absolute number
  const num = parseFloat(lower);
  if (!isNaN(num)) return num;

  return current;
}

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

  // Persist on change
  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const applyUpdate = useCallback(
    (payload: UIUpdatePayload): string => {
      const { component, property, value } = payload;
      const key = `${component}.${property}`;
      console.log(`[ui-prefs] applyUpdate: ${key} = ${value}`);

      setPrefs((prev) => {
        const next = { ...prev };

        // Samuel avatar
        if (component === "samuel" || component === "avatar" || component === "character" || component === "self" || component === "me" || component === "agent") {
          if (property === "size" || property === "font_size") {
            const v = resolveValue(prev.samuel_size, value, 40);
            next.samuel_size = isNaN(v) ? DEFAULTS.samuel_size : clamp(v, 80, 800);
          } else if (property === "opacity") {
            const v = resolveValue(prev.samuel_opacity, value, 0.2);
            next.samuel_opacity = isNaN(v) ? DEFAULTS.samuel_opacity : clamp(v, 0.1, 1);
          }
        }

        // Speech bubble
        if (component === "bubble" || component === "speech_bubble" || component === "text") {
          if (property === "font_size" || property === "size") {
            const v = resolveValue(prev.bubble_font_size, value, 2);
            next.bubble_font_size = isNaN(v) ? DEFAULTS.bubble_font_size : clamp(v, 10, 32);
          }
        }

        // Vocab/word card
        if (component === "word_card" || component === "vocab_card" || component === "card") {
          if (property === "visible") {
            next.vocab_card_visible = value.toLowerCase() !== "hide" && value.toLowerCase() !== "false";
          } else if (property === "position") {
            const lower = value.toLowerCase();
            if (lower.includes("left")) next.vocab_card_position = "left";
            else if (lower.includes("right")) next.vocab_card_position = "right";
          } else if (property === "mode") {
            const lower = value.toLowerCase();
            if (lower === "auto" || lower === "automatic" || lower === "proactive" || lower === "ambient") {
              next.vocab_card_mode = "auto";
            } else if (lower === "manual" || lower === "on_demand" || lower === "off" || lower === "stop") {
              next.vocab_card_mode = "manual";
            }
          } else if (property === "frequency" || property === "interval") {
            const lower = value.toLowerCase();
            if (lower.includes("less") || lower.includes("fewer") || lower.includes("rarely") || lower.includes("slow")) {
              next.vocab_card_interval = Math.min(prev.vocab_card_interval + 60, 600);
            } else if (lower.includes("more") || lower.includes("often") || lower.includes("fast") || lower.includes("frequent")) {
              next.vocab_card_interval = Math.max(prev.vocab_card_interval - 30, 20);
            } else if (lower === "off" || lower === "never" || lower === "stop" || lower === "disable") {
              next.vocab_card_mode = "manual";
            } else if (lower === "default" || lower === "reset" || lower === "normal") {
              next.vocab_card_interval = DEFAULTS.vocab_card_interval;
            } else {
              const num = parseInt(lower, 10);
              if (!isNaN(num)) {
                next.vocab_card_interval = clamp(num, 10, 600);
                next.vocab_card_mode = "auto";
              }
            }
          }
        }

        // Romaji / reading
        if (component === "romaji") {
          if (property === "visible") {
            next.romaji_visible = value.toLowerCase() !== "hide" && value.toLowerCase() !== "false";
          }
        }
        if (component === "reading" || component === "furigana" || component === "pinyin") {
          if (property === "visible") {
            next.reading_visible = value.toLowerCase() !== "hide" && value.toLowerCase() !== "false";
          }
        }

        // Teach viewer
        if (component === "teach" || component === "teach_viewer" || component === "lyrics_panel" || component === "subtitle_bar") {
          if (property === "font_size" || property === "size") {
            const v = resolveValue(prev.teach_font_size, value, 2);
            next.teach_font_size = isNaN(v) ? DEFAULTS.teach_font_size : clamp(v, 10, 28);
          }
        }

        // Global "all" — reset everything
        if (component === "all" && (property === "reset" || value.toLowerCase() === "reset")) {
          return { ...DEFAULTS };
        }

        console.log(`[ui-prefs] state change: samuel_size=${prev.samuel_size}->${next.samuel_size}, opacity=${prev.samuel_opacity}->${next.samuel_opacity}`);
        return next;
      });

      return `Updated ${key} to ${value}.`;
    },
    [],
  );

  const resetAll = useCallback(() => {
    setPrefs({ ...DEFAULTS });
  }, []);

  // CSS custom properties derived from prefs
  const cssVars = useMemo(
    () => ({
      "--samuel-size": `${prefs.samuel_size}px`,
      "--samuel-opacity": `${prefs.samuel_opacity}`,
      "--bubble-font-size": `${prefs.bubble_font_size}px`,
      "--teach-font-size": `${prefs.teach_font_size}px`,
      "--vocab-card-side": prefs.vocab_card_position === "left" ? "auto" : "20px",
      "--vocab-card-side-left": prefs.vocab_card_position === "left" ? "20px" : "auto",
    }),
    [prefs],
  );

  return { prefs, applyUpdate, resetAll, cssVars };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
