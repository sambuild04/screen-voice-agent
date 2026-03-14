import { useCallback, useRef, useState } from "react";
import { useRealtime } from "./hooks/useRealtime";
import { useWakeWord } from "./hooks/useWakeWord";
import { playChime, playSleep } from "./lib/sounds";
import { StatusBar } from "./components/StatusBar";
import { Character } from "./components/Character";
import { ScreenPicker } from "./components/ScreenPicker";

export default function App() {
  const {
    status,
    transcript,
    agentState,
    screenTarget,
    connect,
    disconnect,
    mute,
    isMuted,
    setWakeWordMode,
  } = useRealtime();

  const [awaitingWake, setAwaitingWake] = useState(true);
  const connectingRef = useRef(false);
  // Tracks when the session became active — idle detection won't fire for the
  // first 15 s so the greeting can finish and the user has time to speak.
  const sessionActiveAtRef = useRef(0);

  // Wake word detected — connect (if needed) then unmute
  const handleWakeDetected = useCallback(async () => {
    if (connectingRef.current) return;
    playChime();
    setAwaitingWake(false);
    sessionActiveAtRef.current = Date.now();

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

  // When agentState goes idle after extended silence, re-enable wake word.
  // 15 s grace period after activation so the greeting + first exchange
  // don't prematurely flip back to wake-word mode.
  const prevAgentState = useRef(agentState);
  const sessionAge = Date.now() - sessionActiveAtRef.current;
  if (
    agentState === "idle" &&
    prevAgentState.current !== "idle" &&
    status === "connected" &&
    !awaitingWake &&
    sessionAge > 15_000
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
    <div className="flex h-screen flex-col">
      {/* Compact header — draggable region for borderless window */}
      <div data-tauri-drag-region className="flex items-center justify-between px-5 py-2">
        <StatusBar
          agentState={agentState}
          status={status}
          awaitingWake={awaitingWake}
        />
        {status === "connected" && !awaitingWake && (
          <div className="flex items-center gap-2">
            <ScreenPicker />
            <button
              onClick={() => mute(!isMuted)}
              className={`rounded-full p-2 transition-colors ${
                isMuted
                  ? "bg-red-900/50 text-red-300"
                  : "bg-white/10 text-slate-400 hover:text-slate-200"
              }`}
            >
              {isMuted ? <MicOffIcon /> : <MicIcon />}
            </button>
            <button
              onClick={handleDisconnect}
              className="rounded-full bg-red-600/70 p-2 text-white hover:bg-red-600/90 transition-colors"
            >
              <PhoneOffIcon />
            </button>
          </div>
        )}
      </div>

      {/* Character stage — takes up the full area */}
      <Character
        agentState={agentState}
        transcript={transcript}
        awaitingWake={awaitingWake}
        screenTarget={screenTarget}
      />
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" x2="22" y1="2" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 5.18" />
      <path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function PhoneOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67" />
      <path d="M2.68 2.68A19.79 19.79 0 0 0 2.11 4.18 2 2 0 0 0 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}
