interface StatusBarProps {
  agentState: "idle" | "listening" | "thinking" | "speaking";
  status: "disconnected" | "connecting" | "connected";
  awaitingWake?: boolean;
}

export function StatusBar({ agentState, status, awaitingWake }: StatusBarProps) {
  if (status === "connecting") {
    return <Pill color="bg-cyan-500" pulse label="Connecting..." />;
  }
  if (awaitingWake) {
    return <Pill color="bg-violet-500" pulse label='Say "Hey Samuel"' />;
  }
  if (status === "disconnected") {
    return <Pill color="bg-slate-600" label="Offline" />;
  }

  const labels: Record<string, string> = {
    idle: "Ready",
    listening: "Listening...",
    thinking: "Thinking...",
    speaking: "Speaking...",
  };
  const colors: Record<string, string> = {
    idle: "bg-slate-600",
    listening: "bg-emerald-500",
    thinking: "bg-amber-500",
    speaking: "bg-cyan-500",
  };

  const isPulsing = agentState === "listening" || agentState === "speaking";
  return (
    <Pill
      color={colors[agentState]}
      pulse={isPulsing}
      label={labels[agentState]}
    />
  );
}

function Pill({
  color,
  pulse,
  label,
}: {
  color: string;
  pulse?: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center justify-center gap-3 py-5">
      <div className="relative flex items-center justify-center">
        {pulse && (
          <div
            className={`absolute h-5 w-5 rounded-full ${color} pulse-ring opacity-40`}
          />
        )}
        <div className={`h-3 w-3 rounded-full ${color}`} />
      </div>
      <span className="text-sm font-medium text-slate-300">{label}</span>
    </div>
  );
}
