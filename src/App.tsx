import { useRealtime } from "./hooks/useRealtime";
import { StatusBar } from "./components/StatusBar";
import { Transcript } from "./components/Transcript";
import { Controls } from "./components/Controls";

export default function App() {
  const {
    status,
    transcript,
    agentState,
    connect,
    disconnect,
    mute,
    isMuted,
  } = useRealtime();

  return (
    <div className="flex h-screen flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-700/50 px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold text-cyan-400 tracking-tight">
            Samuel
          </h1>
          <p className="text-[11px] text-slate-500">Book Reading Assistant</p>
        </div>
        <StatusBar agentState={agentState} status={status} />
      </div>

      {/* Transcript */}
      <Transcript entries={transcript} agentState={agentState} />

      {/* Controls */}
      <Controls
        status={status}
        isMuted={isMuted}
        onConnect={() => connect()}
        onDisconnect={disconnect}
        onMute={mute}
      />
    </div>
  );
}
