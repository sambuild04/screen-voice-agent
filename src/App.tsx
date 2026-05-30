import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "./lib/invoke-bridge";
import { getCurrentWindow, LogicalSize } from "./lib/electron-window";
import { useRealtime } from "./hooks/useRealtime";
import { useWakeWord } from "./hooks/useWakeWord";
import { useRecordMode } from "./hooks/useRecordMode";
import { useLearningMode } from "./hooks/useLearningMode";
import { useAudioBuffer } from "./hooks/useAudioBuffer";
import { useWatcherLoop } from "./hooks/useWatcherLoop";
import { useUIPreferences } from "./hooks/useUIPreferences";
import { playChime, playSleep } from "./lib/sounds";
import { StatusBar } from "./components/StatusBar";
import { Character } from "./components/Character";
import { TeachDrop } from "./components/TeachDrop";
import { PluginApproval } from "./components/PluginApproval";
import { SettingsPanel } from "./components/SettingsPanel";
import { sendTextAndRespond, registerUIUpdate, setVolume } from "./lib/session-bridge";

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
    setSuppressIdle,
    prefetchKey,
    approveToolCall,
    denyToolCall,
    alwaysAllowApp,
    alwaysDenyApp,
    sendText,
  } = useRealtime();

  const record = useRecordMode();
  const ui = useUIPreferences();
  const learning = useLearningMode(
    status,
    agentState,
    ui.prefs["privacy.screen_watch"] as boolean,
    ui.prefs["privacy.audio_listen"] as boolean,
  );

  // Ambient audio buffer — the pull-model "I've been listening, ask me
  // anything" primitive. Continuously records system audio while connected
  // (local-only; transcription is consent-at-point-of-use via the model's
  // recall_audio tool). Gated by privacy.audio_listen — the model's
  // listen_in_background tool flips that pref and is marked needsApproval
  // so the user sees a clear allow/deny popup the first time.
  useAudioBuffer(status, ui.prefs["privacy.audio_listen"] as boolean);

  // Standalone watcher loop: evaluates triggers even when learning mode is off.
  // Defers to useLearningMode when it's active (avoids double-evaluation).
  // Gated by both screen_watch (for screen triggers) and audio_listen
  // (for audio/both triggers) so the Settings toggles fully control it.
  useWatcherLoop(
    status,
    agentState,
    learning.learningActive,
    ui.prefs["privacy.screen_watch"] as boolean,
    ui.prefs["privacy.audio_listen"] as boolean,
  );

  // Sync Samuel's voice volume with the preference
  const samuelVolume = ui.prefs["volume.samuel"] as number;
  useEffect(() => {
    setVolume(samuelVolume ?? 80);
  }, [samuelVolume]);

  const [awaitingWake, setAwaitingWake] = useState(true);
  const [envelopeOpen, setEnvelopeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handlePrivacyToggle = useCallback((key:
    | "privacy.screen_watch"
    | "privacy.audio_listen"
    | "privacy.audio_record"
    | "privacy.screen_read"
    | "privacy.voice_input"
    | "privacy.computer_use"
    | "privacy.local_time"
    | "privacy.location"
  ) => {
    const current = ui.prefs[key];
    const prop = key.split(".")[1];
    ui.applyUpdate({ component: "privacy", property: prop, value: current ? "false" : "true" });
  }, [ui.prefs, ui.applyUpdate]);

  // Master kill-switch enforcement for the realtime voice mic. When the user
  // turns off Voice Input in Settings, force-mute the session immediately so
  // no further audio reaches the model, and keep it muted until the toggle
  // flips back. The mic button (rendered below) is disabled in this state so
  // it can't fight the gate. Wake-word capture is also gated on this flag.
  const voiceInputAllowed = ui.prefs["privacy.voice_input"] !== false;
  useEffect(() => {
    if (!voiceInputAllowed && !isMuted) {
      mute(true);
    }
  }, [voiceInputAllowed, isMuted, mute]);

  // Register UI update bridge — used by plugins via plugin-loader's
  // uiHelper.set(). The voice-tool layer was removed (see samuel.ts) but
  // plugins can still mutate UI state through this bridge.
  useEffect(() => {
    registerUIUpdate((component, property, value) =>
      ui.applyUpdate({ component, property, value }),
    );
    return () => registerUIUpdate(null);
  }, [ui.applyUpdate]);

  // Keep the session alive during recording and while viewing results
  useEffect(() => {
    const active = record.recordingState !== "idle";
    setSuppressIdle(active);
  }, [record.recordingState, setSuppressIdle]);
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
      prefetchKey(); // start ephemeral key fetch immediately while connect() sets up
      connectingRef.current = true;
      try {
        await connect();
        setWakeWordMode(true);
      } finally {
        connectingRef.current = false;
      }
    }
  }, [status, connect, mute, setWakeWordMode, prefetchKey]);

  // Run post-session feedback extraction when going to sleep (non-blocking)
  const extractFeedback = useCallback(() => {
    const entries = transcript
      .filter((t) => t.role === "user" || t.role === "assistant")
      .slice(-20)
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");
    // Threshold dropped from 50 → 8 chars: even a single "no, not like that"
    // pushback is worth a Reflexion pass. Empty/silent sessions still skip.
    if (entries.length > 8) {
      invoke("extract_session_feedback", { transcript: entries }).catch(() => {});
    }
  }, [transcript]);

  // Auto-sleep when the agent has been idle for IDLE_SLEEP_DELAY_MS. We wait
  // a generous chunk of time before flipping back to wake-word mode so the
  // user can ask a quick follow-up after a response without having to say
  // "Hey Samuel" again. If anything happens during the wait — agent starts
  // speaking/listening, recording starts, status flips, awaitingWake is set
  // manually — the cleanup tears the timer down and we re-arm next time.
  // 15 s post-wake grace ensures the greeting + first exchange can't trip it.
  const IDLE_SLEEP_DELAY_MS = 30_000;
  const POST_WAKE_GRACE_MS = 15_000;
  useEffect(() => {
    const sessionAge = Date.now() - sessionActiveAtRef.current;
    if (
      agentState !== "idle" ||
      status !== "connected" ||
      awaitingWake ||
      sessionAge < POST_WAKE_GRACE_MS ||
      record.recordingState !== "idle"
    ) {
      return;
    }
    const timer = setTimeout(() => {
      playSleep();
      mute(true);
      setAwaitingWake(true);
      extractFeedback();
    }, IDLE_SLEEP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [agentState, status, awaitingWake, record.recordingState, mute, extractFeedback]);

  useWakeWord({
    // Gate wake-word capture on Voice Input privacy: when audio is privacy-
    // disabled, we must not run the local mic listener either, otherwise the
    // user's voice still reaches our process even though the realtime
    // session is muted.
    enabled: awaitingWake && voiceInputAllowed,
    onDetected: handleWakeDetected,
  });

  const handleDisconnect = useCallback(() => {
    extractFeedback();
    setAwaitingWake(true);
    setWakeWordMode(false);
    disconnect();
  }, [disconnect, setWakeWordMode, extractFeedback]);

  // Auto-resize window; respect user-set width/height prefs
  const containerRef = useRef<HTMLDivElement>(null);
  const userW = (ui.prefs["window.width"] as number) ?? 520;
  const userH = (ui.prefs["window.height"] as number) ?? 740;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const win = getCurrentWindow();
    const MIN_H = 400;
    const MAX_H = Math.max(userH, 900);
    let lastH = 0;
    const observer = new ResizeObserver(() => {
      const needed = Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight + 20));
      if (Math.abs(needed - lastH) > 10) {
        lastH = needed;
        win.setSize(new LogicalSize(userW, needed));
      }
    });
    observer.observe(el);
    win.setSize(new LogicalSize(userW, Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight + 20))));
    return () => observer.disconnect();
  }, [userW, userH]);

  return (
    <div ref={containerRef} className="flex h-screen flex-col" style={ui.cssVars as React.CSSProperties}>
      {/* Compact header — draggable region for borderless window */}
      <div className="drag-region flex items-center justify-between px-5 py-2">
        <StatusBar
          agentState={agentState}
          status={status}
          awaitingWake={awaitingWake}
        />
        <div className="flex items-center gap-2">
          {/* Stop/processing button always visible while recording, even in wake mode */}
          {record.recordingState === "recording" && (
            <button
              onClick={record.stopRecording}
              className="record-btn-active rounded-full p-2 text-red-300 transition-colors"
              title={`Recording... ${formatTime(record.elapsed)}`}
            >
              <StopIcon />
            </button>
          )}
          {record.recordingState === "processing" && (
            <div className="rounded-full p-2 bg-white/10 text-amber-300 animate-pulse" title="Processing...">
              <ProcessingIcon />
            </div>
          )}

          {/* Full controls only when connected and active */}
          {status === "connected" && !awaitingWake && (
            <>
              {(record.recordingState === "idle" || record.recordingState === "results") && (
                <button
                  onClick={record.startRecording}
                  className="rounded-full p-2 bg-white/10 text-slate-400 hover:text-red-400 transition-colors"
                  title="Record system audio"
                >
                  <RecordIcon />
                </button>
              )}
              <button
                onClick={() => {
                  // Privacy gate wins over manual unmute attempts.
                  if (!voiceInputAllowed) return;
                  mute(!isMuted);
                }}
                disabled={!voiceInputAllowed}
                title={
                  !voiceInputAllowed
                    ? "Voice Input is disabled in Settings → Privacy"
                    : isMuted ? "Unmute" : "Mute"
                }
                className={`rounded-full p-2 transition-colors ${
                  !voiceInputAllowed
                    ? "bg-white/5 text-slate-600 cursor-not-allowed"
                    : isMuted
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
            </>
          )}

          {/* Settings — always visible */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-full p-2 bg-white/10 text-slate-400 hover:text-slate-200 transition-colors"
            title="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </div>

      {/* Character stage — takes up the full area */}
      <Character
        agentState={agentState}
        transcript={transcript}
        awaitingWake={awaitingWake}
        screenTarget={screenTarget}
        recordingState={record.recordingState}
        recordingElapsed={record.elapsed}
        analysis={record.analysis}
        panelOpen={record.panelOpen}
        analysisStage={record.analysisStage}
        analysisElapsed={record.analysisElapsed}
        onDismissAnalysis={record.dismiss}
        onTogglePanel={record.togglePanel}
        onClearAnalysis={record.clearAnalysis}
        onMailboxToggle={() => setEnvelopeOpen((o) => !o)}
        onWakeUp={handleWakeDetected}
        envelopeSlot={
          <TeachDrop
            visible={envelopeOpen}
            onToggle={() => setEnvelopeOpen(false)}
            onDrop={(input) => {
              setEnvelopeOpen(false);
              if (input.startsWith("data:image/")) {
                sendTextAndRespond(
                  `[System: The user pasted an image via chat. Describe what you see and ask if they need help with it.]`,
                );
              } else {
                sendText(input);
              }
            }}
          />
        }
        onApproveToolCall={approveToolCall}
        onDenyToolCall={denyToolCall}
        onAlwaysAllowApp={alwaysAllowApp}
        onAlwaysDenyApp={alwaysDenyApp}
      />

      <PluginApproval />

      <SettingsPanel
        visible={settingsOpen}
        prefs={ui.prefs}
        onToggle={handlePrivacyToggle}
        onResetPrefs={ui.resetAll}
        onClose={() => setSettingsOpen(false)}
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

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function RecordIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function ProcessingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4" /><path d="M12 18v4" /><path d="m4.93 4.93 2.83 2.83" /><path d="m16.24 16.24 2.83 2.83" />
      <path d="M2 12h4" /><path d="M18 12h4" /><path d="m4.93 19.07 2.83-2.83" /><path d="m16.24 7.76 2.83-2.83" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
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
