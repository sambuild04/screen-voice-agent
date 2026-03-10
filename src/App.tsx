import { useCallback, useRef, useState } from "react";
import { useRealtime } from "./hooks/useRealtime";
import { useWakeWord } from "./hooks/useWakeWord";
import { playChime, playSleep } from "./lib/sounds";
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
    setWakeWordMode,
  } = useRealtime();

  const [awaitingWake, setAwaitingWake] = useState(true);
  const connectingRef = useRef(false);

  // Wake word detected — connect (if needed) then unmute
  const handleWakeDetected = useCallback(async () => {
    if (connectingRef.current) return;
    playChime();
    setAwaitingWake(false);

    if (status === "connected") {
      mute(false);
    } else {
      connectingRef.current = true;
      try {
        await connect();
        setWakeWordMode(true);
      } finally {
        connectingRef.current = false;
      }
    }
  }, [status, connect, mute, setWakeWordMode]);

  // When agentState goes idle from inactivity timer, re-enable wake word
  const prevAgentState = useRef(agentState);
  if (
    agentState === "idle" &&
    prevAgentState.current !== "idle" &&
    status === "connected" &&
    !awaitingWake
  ) {
    playSleep();
    mute(true);
    setAwaitingWake(true);
  }
  prevAgentState.current = agentState;

  useWakeWord({
    enabled: awaitingWake,
    onDetected: handleWakeDetected,
  });

  const handleDisconnect = useCallback(() => {
    setAwaitingWake(true);
    setWakeWordMode(false);
    disconnect();
  }, [disconnect, setWakeWordMode]);

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
        <StatusBar
          agentState={agentState}
          status={status}
          awaitingWake={awaitingWake}
        />
      </div>

      {/* Transcript */}
      <Transcript entries={transcript} agentState={agentState} />

      {/* Controls */}
      <Controls
        status={status}
        isMuted={isMuted}
        awaitingWake={awaitingWake}
        onDisconnect={handleDisconnect}
        onMute={mute}
      />
    </div>
  );
}
