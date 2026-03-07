import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../hooks/useRealtime";

interface TranscriptProps {
  entries: TranscriptEntry[];
}

export function Transcript({ entries }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-center text-slate-500 text-sm">
          Press <span className="font-semibold text-slate-400">Connect</span> to
          start a conversation with Samuel.
        </p>
      </div>
    );
  }

  return (
    <div className="transcript-scroll flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {entries.map((entry) => (
        <TranscriptBubble key={entry.id} entry={entry} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function TranscriptBubble({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === "status") {
    return (
      <div className="flex justify-center">
        <span className="text-xs text-slate-500 bg-slate-800/50 rounded-full px-3 py-1">
          {entry.text}
        </span>
      </div>
    );
  }

  const isAssistant = entry.role === "assistant";

  return (
    <div className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isAssistant
            ? "bg-surface-elevated text-slate-100"
            : "bg-cyan-900/40 text-cyan-100"
        }`}
      >
        {isAssistant && (
          <span className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider block mb-1">
            Samuel
          </span>
        )}
        {entry.text}
      </div>
    </div>
  );
}
