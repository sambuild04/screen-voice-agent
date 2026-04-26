import { useEffect, type ReactNode } from "react";
import { useRive, useStateMachineInput } from "@rive-app/react-canvas";
import type { TranscriptEntry } from "../hooks/useRealtime";
import type { AnalysisStage, RecordingAnalysis, RecordingState } from "../hooks/useRecordMode";

type AgentState = "idle" | "listening" | "thinking" | "speaking";

interface CharacterProps {
  agentState: AgentState;
  transcript: TranscriptEntry[];
  awaitingWake: boolean;
  screenTarget: string | null;
  recordingState: RecordingState;
  recordingElapsed: number;
  analysis: RecordingAnalysis | null;
  panelOpen: boolean;
  analysisStage: AnalysisStage | null;
  analysisElapsed: number;
  onDismissAnalysis: () => void;
  onTogglePanel: () => void;
  onClearAnalysis: () => void;
  onMailboxToggle: () => void;
  envelopeSlot?: ReactNode;
}

const STATE_MACHINE = "State Machine 1";

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Character({
  agentState,
  transcript,
  awaitingWake,
  screenTarget,
  recordingState,
  recordingElapsed,
  analysis,
  panelOpen,
  analysisStage,
  analysisElapsed,
  onDismissAnalysis,
  onTogglePanel,
  onClearAnalysis,
  onMailboxToggle,
  envelopeSlot,
}: CharacterProps) {
  const { rive, RiveComponent } = useRive({
    src: "/character.riv",
    stateMachines: STATE_MACHINE,
    autoplay: true,
  });

  const touchDown = useStateMachineInput(rive, STATE_MACHINE, "touchDown");
  const touchUp = useStateMachineInput(rive, STATE_MACHINE, "touchUp");

  useEffect(() => {
    if (!rive) return;
    if (agentState === "speaking" || agentState === "thinking") {
      touchDown?.fire();
    } else {
      touchUp?.fire();
    }
  }, [agentState, rive, touchDown, touchUp]);

  // Show the latest assistant message as a speech bubble
  const latestAssistant = [...transcript]
    .reverse()
    .find((e) => e.role === "assistant");

  // Show the latest user message as a speech bubble
  const latestUser = [...transcript]
    .reverse()
    .find((e) => e.role === "user" && e.text !== "...");

  const showThinking = agentState === "thinking";
  const showListening = agentState === "listening" && !awaitingWake;

  return (
    <div className="character-stage" data-tauri-drag-region>
      {/* Recording indicator */}
      {recordingState === "recording" && (
        <div className="recording-badge">
          <div className="recording-dot" />
          REC {formatTime(recordingElapsed)}
        </div>
      )}
      {recordingState === "processing" && analysisStage && (
        <div className="analysis-progress-bar">
          <div className="analysis-progress-stages">
            <AnalysisStageIndicator
              label="Transcribing"
              active={analysisStage === "transcribing"}
              done={analysisStage === "analyzing" || analysisStage === "done"}
            />
            <div className="analysis-progress-divider" />
            <AnalysisStageIndicator
              label="Analyzing"
              active={analysisStage === "analyzing"}
              done={analysisStage === "done"}
            />
          </div>
          <div className="analysis-progress-track">
            <div
              className="analysis-progress-fill"
              style={{
                width: analysisStage === "done"
                  ? "100%"
                  : analysisStage === "analyzing"
                    ? `${Math.min(50 + analysisElapsed * 1.5, 95)}%`
                    : `${Math.min(analysisElapsed * 3, 48)}%`,
              }}
            />
          </div>
          <div className="analysis-progress-time">{formatTime(analysisElapsed)}</div>
        </div>
      )}

      {/* Samuel's speech bubble — top right of character */}
      {(latestAssistant || showThinking) && (
        <div className="speech-bubble speech-bubble-samuel">
          {showThinking ? (
            <div className="flex items-center gap-1">
              <div className="thinking-dot" style={{ animationDelay: "0ms" }} />
              <div className="thinking-dot" style={{ animationDelay: "150ms" }} />
              <div className="thinking-dot" style={{ animationDelay: "300ms" }} />
            </div>
          ) : (
            <p>{latestAssistant!.text}</p>
          )}
          <div className="speech-tail speech-tail-left" />
        </div>
      )}

      {/* Rive character */}
      <div className={`character-avatar ${agentState === "speaking" ? "character-glow" : ""}`}>
        <RiveComponent />
      </div>

      {/* Chat input — centered below avatar */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <button
          className="mailbox-icon"
          onClick={onMailboxToggle}
        >
          <ChatSvg />
        </button>
        {envelopeSlot}
      </div>

      {/* Screen target indicator */}
      {screenTarget && (
        <div className="screen-target-badge">
          <EyeIcon /> Looking at: {screenTarget}
        </div>
      )}

      {/* User's speech bubble — bottom left of character */}
      {latestUser && (
        <div className="speech-bubble speech-bubble-user">
          <p>{latestUser.text}</p>
          <div className="speech-tail speech-tail-right" />
        </div>
      )}

      {/* State indicator */}
      {awaitingWake && (
        <div className="character-hint">
          Say &quot;Hey Samuel&quot;
        </div>
      )}
      {showListening && (
        <div className="character-listening">
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
      )}

      {/* Minimized analysis badge — tap to re-open */}
      {analysis && !panelOpen && (
        <button onClick={onTogglePanel} className="analysis-reopen-badge">
          <BookIcon /> View Breakdown
        </button>
      )}

      {/* Analysis overlay panel — coexists with chat */}
      {analysis && panelOpen && (
        <div className="analysis-overlay">
          <div className="analysis-bubble">
            <div className="analysis-header">
              <span className="analysis-title">Language Breakdown</span>
              <div className="flex items-center gap-2">
                <button onClick={onDismissAnalysis} className="analysis-minimize" title="Minimize">
                  &minus;
                </button>
                <button onClick={onClearAnalysis} className="analysis-close" title="Close">
                  &times;
                </button>
              </div>
            </div>

            <div className="analysis-section">
              <h3 className="analysis-section-title">Summary</h3>
              <p className="analysis-summary">{analysis.summary}</p>
            </div>

            {analysis.translated_transcript.length > 0 ? (
              <div className="analysis-section">
                <h3 className="analysis-section-title">Script &amp; Translation</h3>
                <div className="script-lines">
                  {analysis.translated_transcript.map((line, i) => (
                    <div key={i} className="script-line-bilingual">
                      <div className="script-original">{line.timestamp}</div>
                      <div className="script-translation">{line.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : analysis.transcript.length > 0 ? (
              <div className="analysis-section">
                <h3 className="analysis-section-title">Script</h3>
                <div className="script-lines">
                  {analysis.transcript.map((line, i) => (
                    <div key={i} className="script-line">
                      <span className="script-timestamp">{line.timestamp}</span>
                      <span className="script-text">{line.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {analysis.vocabulary.length > 0 && (
              <div className="analysis-section">
                <h3 className="analysis-section-title">Vocabulary</h3>
                <div className="vocab-table">
                  <div className="vocab-header">
                    <span>Word</span><span>Reading</span><span>Meaning</span><span>Level</span>
                  </div>
                  {analysis.vocabulary.map((v, i) => (
                    <div key={i} className="vocab-row">
                      <span className="vocab-word">{v.word}</span>
                      <span className="vocab-reading">{v.reading}</span>
                      <span className="vocab-meaning">{v.meaning}</span>
                      <span className="vocab-level">{v.level}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {analysis.grammar.length > 0 && (
              <div className="analysis-section">
                <h3 className="analysis-section-title">Grammar Points</h3>
                {analysis.grammar.map((g, i) => (
                  <div key={i} className="grammar-card">
                    <div className="grammar-pattern">{g.pattern}</div>
                    <div className="grammar-explanation">{g.explanation}</div>
                    {g.examples.length > 0 && (
                      <ul className="grammar-examples">
                        {g.examples.map((ex, j) => (
                          <li key={j}>{ex}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BookIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ChatSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 10h.01" /><path d="M12 10h.01" /><path d="M16 10h.01" />
    </svg>
  );
}


function AnalysisStageIndicator({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div className={`analysis-stage ${active ? "analysis-stage-active" : ""} ${done ? "analysis-stage-done" : ""}`}>
      <div className="analysis-stage-dot">
        {done ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : active ? (
          <div className="analysis-stage-pulse" />
        ) : null}
      </div>
      <span className="analysis-stage-label">{label}</span>
    </div>
  );
}
