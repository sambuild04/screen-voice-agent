import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { useRealtime } from "./hooks/useRealtime";
import { useWakeWord } from "./hooks/useWakeWord";
import { useRecordMode } from "./hooks/useRecordMode";
import { useLearningMode } from "./hooks/useLearningMode";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useSongPlayback } from "./hooks/useSongTeaching";
import { useUIPreferences } from "./hooks/useUIPreferences";
import { playChime, playSleep } from "./lib/sounds";
import { StatusBar } from "./components/StatusBar";
import { Character } from "./components/Character";
import { ScreenPicker } from "./components/ScreenPicker";
import { WordCard } from "./components/WordCard";
import { TeachDrop } from "./components/TeachDrop";
import { PluginApproval } from "./components/PluginApproval";
import { SettingsPanel } from "./components/SettingsPanel";
import { LyricsViewer } from "./components/LyricsViewer";
import { sendTextAndRespond, registerUIUpdate, registerDismissCard, registerSongPlayback, registerShowWordCard, registerSetCardMode, registerToggleLyrics, registerSetLyricsContent, registerUpdateSongLines, registerGetSongMeta } from "./lib/session-bridge";
import type { ContentLine } from "./lib/session-bridge";
import type { WordCardData } from "./lib/session-bridge";
import { registerPrivacyPrefsGetter, registerUIStateGetter } from "./lib/samuel";

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
  } = useRealtime();

  const record = useRecordMode();
  const ui = useUIPreferences();
  const learning = useLearningMode(
    status,
    ui.prefs["word_card.interval"] as number,
    agentState,
    ui.prefs["word_card.mode"] as string,
    ui.prefs["privacy.screen_watch"] as boolean,
    ui.prefs["privacy.audio_listen"] as boolean,
  );
  const [songAudioPath, setSongAudioPath] = useState<string | null>(null);
  const [songLines, setSongLines] = useState<ContentLine[] | null>(null);
  const [songTitle, setSongTitle] = useState<string | null>(null);
  const [songSource, setSongSource] = useState<string | null>(null);
  const [songVideoId, setSongVideoId] = useState<string | null>(null);

  const audioPlayer = useAudioPlayer(songAudioPath);
  const songPlayback = useSongPlayback({
    lines: songLines,
    player: audioPlayer,
  });

  const [awaitingWake, setAwaitingWake] = useState(true);
  const [envelopeOpen, setEnvelopeOpen] = useState(false);
  const [wordCard, setWordCard] = useState<WordCardData | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lyricsViewOpen, setLyricsViewOpen] = useState(false);

  const handlePrivacyToggle = useCallback((key: "privacy.screen_watch" | "privacy.audio_listen" | "privacy.local_time" | "privacy.location") => {
    const current = ui.prefs[key];
    const prop = key.split(".")[1];
    ui.applyUpdate({ component: "privacy", property: prop, value: current ? "false" : "true" });
  }, [ui.prefs, ui.applyUpdate]);

  // Expose privacy prefs to Samuel's tools so they can check at call time
  useEffect(() => {
    registerPrivacyPrefsGetter(() => ({
      local_time_enabled: ui.prefs["privacy.local_time"] as boolean,
      location_enabled: ui.prefs["privacy.location"] as boolean,
    }));
    return () => registerPrivacyPrefsGetter(null);
  }, [ui.prefs["privacy.local_time"], ui.prefs["privacy.location"]]);

  // Expose full UI state so query_ui_state tool can read current values
  useEffect(() => {
    registerUIStateGetter(() => ui.prefs);
    return () => registerUIStateGetter(null);
  }, [ui.prefs]);

  // Register UI update bridge so Samuel can change the UI by voice
  useEffect(() => {
    registerUIUpdate((component, property, value) =>
      ui.applyUpdate({ component, property, value }),
    );
    return () => registerUIUpdate(null);
  }, [ui.applyUpdate]);

  // Register dismiss-card bridge so Samuel can close word cards by voice
  useEffect(() => {
    registerDismissCard(() => setWordCard(null));
    return () => registerDismissCard(null);
  }, []);

  // Register show-word-card bridge so Samuel can display word cards on demand
  useEffect(() => {
    registerShowWordCard((card) => setWordCard(card));
    return () => registerShowWordCard(null);
  }, []);

  // Register card-mode bridge so Samuel can toggle manual / auto by voice
  useEffect(() => {
    registerSetCardMode((mode, intervalSec) => {
      ui.applyUpdate({ component: "word_card", property: "mode", value: mode });
      if (intervalSec !== undefined) {
        ui.applyUpdate({ component: "word_card", property: "frequency", value: String(intervalSec) });
      }
    });
    return () => registerSetCardMode(null);
  }, [ui.applyUpdate]);

  // Register lyrics viewer bridges — toggle visibility + push content from web search
  useEffect(() => {
    registerToggleLyrics((visible) => setLyricsViewOpen(visible));
    registerSetLyricsContent((title, lines) => {
      setSongTitle(title);
      setSongLines(lines.map((text, i) => ({ text, timestamp: null, source_index: i })));
      setLyricsViewOpen(true);
    });
    return () => {
      registerToggleLyrics(null);
      registerSetLyricsContent(null);
    };
  }, []);

  // Register song lines hot-swap + metadata bridges for lyrics correction tools
  useEffect(() => {
    registerUpdateSongLines((lines) => {
      setSongLines(lines);
    });
    registerGetSongMeta(() => ({
      title: songTitle,
      source: songSource,
      videoId: songVideoId,
      lines: songLines ?? [],
    }));
    return () => {
      registerUpdateSongLines(null);
      registerGetSongMeta(null);
    };
  }, [songTitle, songSource, songVideoId]);

  // Register song playback bridge — mute mic during playback, unmute when done.
  // Returns a promise so Samuel's tool waits until the segment finishes before speaking.
  useEffect(() => {
    registerSongPlayback(
      (from, to) =>
        new Promise<void>((resolve) => {
          mute(true);
          songPlayback.playLines(from, to, () => {
            mute(false);
            resolve();
          });
        }),
      () => {
        songPlayback.pause();
        mute(false);
      },
    );
    return () => registerSongPlayback(null, null);
  }, [songPlayback.playLines, songPlayback.pause, mute]);

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
    if (entries.length > 50) {
      invoke("extract_session_feedback", { transcript: entries }).catch(() => {});
    }
  }, [transcript]);

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
    sessionAge > 15_000 &&
    record.recordingState === "idle"
  ) {
    playSleep();
    mute(true);
    setAwaitingWake(true);
    extractFeedback();
  }
  prevAgentState.current = agentState;

  useWakeWord({
    enabled: awaitingWake,
    onDetected: handleWakeDetected,
  });

  const handleDisconnect = useCallback(() => {
    extractFeedback();
    setAwaitingWake(true);
    setWakeWordMode(false);
    disconnect();
  }, [disconnect, setWakeWordMode, extractFeedback]);

  // Auto-resize window; respect user-set width/height prefs; widen for lyrics
  const lyricsActive = lyricsViewOpen && !!songLines;
  const containerRef = useRef<HTMLDivElement>(null);
  const userW = (ui.prefs["window.width"] as number) ?? 520;
  const userH = (ui.prefs["window.height"] as number) ?? 740;
  const lyricsWidth = (ui.prefs["lyrics.width"] as number) ?? 185;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const win = getCurrentWindow();
    const MIN_H = 400;
    const MAX_H = Math.max(userH, 900);
    let lastH = 0;
    // When lyrics are open, ensure window is wide enough for lyrics + avatar
    const minForLyrics = lyricsWidth + 350;
    const targetW = lyricsActive ? Math.max(userW, minForLyrics) : userW;
    const observer = new ResizeObserver(() => {
      const needed = Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight + 20));
      if (Math.abs(needed - lastH) > 10) {
        lastH = needed;
        win.setSize(new LogicalSize(targetW, needed));
      }
    });
    observer.observe(el);
    win.setSize(new LogicalSize(targetW, Math.min(MAX_H, Math.max(MIN_H, el.scrollHeight + 20))));
    return () => observer.disconnect();
  }, [lyricsActive, userW, userH, lyricsWidth]);

  return (
    <div ref={containerRef} className={`flex h-screen flex-col ${lyricsActive ? "lyrics-active" : ""}`} style={ui.cssVars as React.CSSProperties}>
      {/* Compact header — draggable region for borderless window */}
      <div data-tauri-drag-region className="flex items-center justify-between px-5 py-2">
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
              <ScreenPicker />
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
        envelopeSlot={
          <TeachDrop
            visible={envelopeOpen}
            onToggle={() => setEnvelopeOpen(false)}
            onDrop={(input) => {
              setEnvelopeOpen(false);
              sendTextAndRespond(
                `[System: The user sent this via the chat input: "${input}". ` +
                `This could be anything — a question, pasted content with instructions, a YouTube link, ` +
                `an article URL, an API key, raw text, an image, or a mix of content and a request. ` +
                `Read the full message to understand what the user wants. ` +
                `If they included a question or instruction (e.g. "what is this?", "explain this", ` +
                `"teach me"), follow their request. ` +
                `If it's just a YouTube link with no instruction, load the song for teaching. ` +
                `If it looks like an API key or token, ask what it's for so you can store it with store_secret. ` +
                `If they want to see content displayed, use show_content to render it in a panel. ` +
                `If ambiguous, just respond naturally to what they wrote.]`,
              );
            }}
          />
        }
      />

      {/* Tool-driven word card — only shown when Samuel decides to */}
      <WordCard card={wordCard} onDismiss={() => setWordCard(null)} />

      {/* Lyrics viewer — shown by Samuel's toggle_lyrics tool */}
      <LyricsViewer
        visible={lyricsViewOpen && !!songLines}
        lines={songLines ?? []}
        title={songTitle ?? undefined}
        onClose={() => setLyricsViewOpen(false)}
        onLineClick={(lineNum) => {
          mute(true);
          songPlayback.playLines(lineNum, lineNum, () => mute(false));
        }}
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
