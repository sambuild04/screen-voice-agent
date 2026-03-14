import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DisplayInfo {
  index: number;
  name: string;
}

const STORAGE_KEY = "samuel-default-display";

export function ScreenPicker() {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [selected, setSelected] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? Number(stored) : 1;
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<DisplayInfo[]>("list_displays").then((list) => {
      setDisplays(list);
      // Sync the stored selection to the Rust side on startup
      const stored = localStorage.getItem(STORAGE_KEY);
      const idx = stored ? Number(stored) : 1;
      invoke("set_default_display", { index: idx });
    });
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pick = useCallback(
    (idx: number) => {
      setSelected(idx);
      setOpen(false);
      localStorage.setItem(STORAGE_KEY, String(idx));
      invoke("set_default_display", { index: idx });
    },
    [],
  );

  // Only show if there are multiple displays
  if (displays.length <= 1) return null;

  const currentName = displays.find((d) => d.index === selected)?.name ?? `Display ${selected}`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
        title={`Screen: ${currentName}`}
      >
        <MonitorIcon />
        <span className="max-w-[80px] truncate">{currentName}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur-md shadow-lg overflow-hidden">
          {displays.map((d) => (
            <button
              key={d.index}
              onClick={() => pick(d.index)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
                d.index === selected
                  ? "bg-cyan-500/20 text-cyan-300"
                  : "text-slate-300 hover:bg-white/10"
              }`}
            >
              <MonitorIcon />
              <span className="truncate">{d.name}</span>
              {d.index === selected && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
