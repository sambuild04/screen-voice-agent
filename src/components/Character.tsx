import { useEffect } from "react";
import { useRive, useStateMachineInput } from "@rive-app/react-canvas";
import type { TranscriptEntry } from "../hooks/useRealtime";

type AgentState = "idle" | "listening" | "thinking" | "speaking";

interface CharacterProps {
  agentState: AgentState;
  transcript: TranscriptEntry[];
  awaitingWake: boolean;
  screenTarget: string | null;
}

const STATE_MACHINE = "State Machine 1";

export function Character({ agentState, transcript, awaitingWake, screenTarget }: CharacterProps) {
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
    </div>
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
