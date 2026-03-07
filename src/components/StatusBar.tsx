interface StatusBarProps {
  agentState: "idle" | "listening" | "thinking" | "speaking";
  status: "disconnected" | "connecting" | "connected";
}

const stateLabels: Record<string, string> = {
  idle: "Offline",
  listening: "Listening...",
  thinking: "Thinking...",
  speaking: "Speaking...",
};

const stateColors: Record<string, string> = {
  idle: "bg-slate-600",
  listening: "bg-emerald-500",
  thinking: "bg-amber-500",
  speaking: "bg-cyan-500",
};

export function StatusBar({ agentState, status }: StatusBarProps) {
  const label =
    status === "connecting"
      ? "Connecting..."
      : status === "disconnected"
        ? "Offline"
        : stateLabels[agentState];

  const dotColor =
    status !== "connected" ? "bg-slate-600" : stateColors[agentState];

  const isPulsing =
    status === "connected" &&
    (agentState === "listening" || agentState === "speaking");

  return (
    <div className="flex items-center justify-center gap-3 py-5">
      <div className="relative flex items-center justify-center">
        {isPulsing && (
          <div
            className={`absolute h-5 w-5 rounded-full ${dotColor} pulse-ring opacity-40`}
          />
        )}
        <div className={`h-3 w-3 rounded-full ${dotColor}`} />
      </div>
      <span className="text-sm font-medium text-slate-300">{label}</span>
    </div>
  );
}
