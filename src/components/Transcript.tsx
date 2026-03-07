import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../hooks/useRealtime";

type AgentState = "idle" | "listening" | "thinking" | "speaking";

interface TranscriptProps {
  entries: TranscriptEntry[];
  agentState?: AgentState;
}

export function Transcript({ entries, agentState }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, agentState]);

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

  const showThinking = agentState === "thinking";
  const showListening = agentState === "listening";

  return (
    <div className="transcript-scroll flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {entries.map((entry) => (
        <TranscriptBubble key={entry.id} entry={entry} />
      ))}

      {showThinking && <ThinkingIndicator />}
      {showListening && <ListeningIndicator />}

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
  const isPlaceholder = entry.role === "user" && entry.text === "...";

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
        {isPlaceholder ? <WaveformDots small /> : entry.text}
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-surface-elevated rounded-2xl px-4 py-3">
        <span className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider block mb-1.5">
          Samuel
        </span>
        <div className="flex items-center gap-1">
          <div className="thinking-dot" style={{ animationDelay: "0ms" }} />
          <div className="thinking-dot" style={{ animationDelay: "150ms" }} />
          <div className="thinking-dot" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    </div>
  );
}

function ListeningIndicator() {
  return (
    <div className="flex justify-center">
      <div className="flex items-end gap-[3px] h-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="waveform-bar"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function WaveformDots({ small }: { small?: boolean }) {
  const size = small ? "h-1.5 w-1.5" : "h-2 w-2";
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={`${size} rounded-full bg-cyan-400 thinking-dot`}
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}
