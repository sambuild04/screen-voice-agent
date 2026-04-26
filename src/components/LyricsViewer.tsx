import { useEffect, useRef } from "react";
import type { ContentLine } from "../lib/session-bridge";

interface Props {
  visible: boolean;
  lines: ContentLine[];
  title?: string;
  currentLine?: number;
  onClose: () => void;
  onLineClick?: (lineNum: number) => void;
}

export function LyricsViewer({ visible, lines, title, currentLine, onClose, onLineClick }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentLine == null || !bodyRef.current) return;
    const el = bodyRef.current.children[currentLine - 1] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentLine]);

  if (!visible || lines.length === 0) return null;

  return (
    <div className="lyrics-hud">
      <div className="lyrics-hud-header">
        <span className="lyrics-hud-title">{title || "Lyrics"}</span>
        <button className="lyrics-hud-close" onClick={onClose}>&times;</button>
      </div>
      <div className="lyrics-hud-body" ref={bodyRef}>
        {lines.map((line, i) => {
          const lineNum = i + 1;
          const isCurrent = currentLine === lineNum;
          const ts = line.timestamp !== null
            ? `${Math.floor(line.timestamp / 60)}:${Math.floor(line.timestamp % 60).toString().padStart(2, "0")}`
            : null;
          return (
            <div
              key={i}
              className={`lyrics-hud-line ${isCurrent ? "lyrics-hud-line-active" : ""}`}
              onClick={() => onLineClick?.(lineNum)}
            >
              {ts && <span className="lyrics-hud-ts">{ts}</span>}
              <span className="lyrics-hud-text">{line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
