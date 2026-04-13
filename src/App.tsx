import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRealtime } from "./hooks/useRealtime";
import { useWakeWord } from "./hooks/useWakeWord";
import { useRecordMode } from "./hooks/useRecordMode";
import { useLearningMode } from "./hooks/useLearningMode";
import { useTeachMode } from "./hooks/useTeachMode";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useSongPlayback } from "./hooks/useSongTeaching";
import { useUIPreferences } from "./hooks/useUIPreferences";
import { playChime, playSleep } from "./lib/sounds";
import { StatusBar } from "./components/StatusBar";
import { Character } from "./components/Character";
import { ScreenPicker } from "./components/ScreenPicker";
import { FlashcardDeck } from "./components/FlashcardDeck";
import { WordCard } from "./components/WordCard";
import { TeachDrop } from "./components/TeachDrop";
import { TeachViewer } from "./components/TeachViewer";
import { PluginApproval } from "./components/PluginApproval";
import { sendTextAndRespond, registerTeachContent, registerUIUpdate, registerDismissCard, registerSongPlayback, registerShowWordCard, registerSetCardMode } from "./lib/session-bridge";
import type { WordCardData } from "./lib/session-bridge";

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
  const learning = useLearningMode(status, ui.prefs.vocab_card_interval, agentState, ui.prefs.vocab_card_mode);
  const teachMode = useTeachMode();

  // Latch song data so it survives teachMode.close() (which nulls content)
  const [songAudioPath, setSongAudioPath] = useState<string | null>(null);
  const [songLines, setSongLines] = useState<import("./hooks/useTeachMode").ContentLine[] | null>(null);
  const isSongContent = !!teachMode.content?.videoId;

  useEffect(() => {
    if (teachMode.content?.audio_file) {
      setSongAudioPath(teachMode.content.audio_file);
    }
    if (teachMode.content?.videoId && teachMode.content.lines.length > 0) {
      setSongLines(teachMode.content.lines);
    }
  }, [teachMode.content]);

  const audioPlayer = useAudioPlayer(songAudioPath);
  const songPlayback = useSongPlayback({
    lines: songLines,
    player: audioPlayer,
  });

  const [awaitingWake, setAwaitingWake] = useState(true);
  const [deckOpen, setDeckOpen] = useState(false);
  const [envelopeOpen, setEnvelopeOpen] = useState(false);
  const [wordCard, setWordCard] = useState<WordCardData | null>(null);

  // Register teach content bridge so Samuel's voice tool can trigger teach mode
  useEffect(() => {
    registerTeachContent((input, language) => {
      teachMode.submit(input, language ?? learning.learningLanguage ?? undefined);
    });
    return () => registerTeachContent(null);
  }, [teachMode.submit, learning.learningLanguage]);

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

  // Register card-mode bridge so Samuel can toggle manual ↔ auto by voice
  useEffect(() => {
    registerSetCardMode((mode, intervalSec) => {
      ui.applyUpdate({ component: "word_card", property: "mode", value: mode });
      if (intervalSec !== undefined) {
        ui.applyUpdate({ component: "word_card", property: "frequency", value: String(intervalSec) });
      }
    });
    return () => registerSetCardMode(null);
  }, [ui.applyUpdate]);

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

  // When YouTube song lyrics load, inject them into Samuel's context (no panel)
  const injectedSongRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      teachMode.state === "ready" &&
      isSongContent &&
      teachMode.content &&
      injectedSongRef.current !== teachMode.content.videoId
    ) {
      injectedSongRef.current = teachMode.content.videoId!;
      const hasSyncedTs = teachMode.content.synced;
      const lyricsText = teachMode.content.lines
        .map((l, i) => {
          const ts = l.timestamp !== null
            ? `[${Math.floor(l.timestamp / 60)}:${Math.floor(l.timestamp % 60).toString().padStart(2, "0")}]`
            : "";
          return `${i + 1} ${ts} ${l.text}`;
        })
        .join("\n");

      const hasAudio = !!teachMode.content.audio_file;
      const playbackNote = hasAudio
        ? `Audio is loaded. Use play_song_lines(from, to) to play any section. ` +
          (hasSyncedTs
            ? "Lines have precise timestamps."
            : "Lyrics are NOT time-synced — playback is approximate (~8s per line from start).") +
          " The mic mutes automatically during playback and unmutes when the segment ends."
        : "Audio is still downloading — play_song_lines will work once it finishes. " +
          "You can explain the lyrics in the meantime.";

      sendTextAndRespond(
        `[System: Song loaded — "${teachMode.content.title ?? "Unknown"}". ` +
        `${teachMode.content.lines.length} lines.\n${playbackNote}\n\n` +
        `Lyrics:\n${lyricsText}\n\n` +
        `Let the user know the song is ready and ask what they'd like to do.]`,
      );
      teachMode.close();
    }
  }, [teachMode.state, teachMode.content, isSongContent, teachMode.close]);

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

  return (
    <div className="flex h-screen flex-col" style={ui.cssVars as React.CSSProperties}>
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

          {/* Flashcard deck button */}
          {status === "connected" && (
            <button
              onClick={() => setDeckOpen(true)}
              className="rounded-full p-2 bg-white/10 text-indigo-300 hover:text-indigo-200 transition-colors"
              title="Scene Flashcards"
            >
              <DeckIcon />
            </button>
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
        teachState={teachMode.state}
        onMailboxToggle={() => setEnvelopeOpen((o) => !o)}
        envelopeSlot={
          <TeachDrop
            visible={envelopeOpen}
            onToggle={() => setEnvelopeOpen(false)}
            onDrop={(input) => {
              setEnvelopeOpen(false);
              sendTextAndRespond(
                `[System: The user dropped content into the envelope: "${input}". ` +
                `Identify what this is (YouTube link, article URL, API key/token, raw text, image, etc.) ` +
                `and respond appropriately. If it's content to study, ask if they want you to teach from it ` +
                `or use teach_from_content directly. If it looks like an API key or token, ask what it's for ` +
                `so you can store it with store_secret. If it's something else, ask for context.]`,
              );
            }}
          />
        }
      />

      {/* Tool-driven word card — only shown when Samuel decides to */}
      <WordCard card={wordCard} onDismiss={() => setWordCard(null)} />

      <FlashcardDeck visible={deckOpen} onClose={() => setDeckOpen(false)} />


      {/* TeachViewer only for non-song content (articles, text, images) */}
      {teachMode.state === "ready" && teachMode.content && !isSongContent && (
        <TeachViewer
          content={teachMode.content}
          selectedLine={teachMode.selectedLine}
          onSelectLine={teachMode.selectLine}
          onClose={teachMode.close}
        />
      )}

      <PluginApproval />
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

function DeckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
      <path d="M6 2v4" />
      <path d="M18 2v4" />
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
