import { useCallback, useRef } from "react";
import type { ContentLine } from "../lib/session-bridge";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";

export interface UseSongPlaybackReturn {
  playLines: (fromLine: number, toLine: number, onDone?: () => void) => void;
  pause: () => void;
}

interface SongPlaybackDeps {
  lines: ContentLine[] | null;
  player: UseAudioPlayerReturn;
}

function estimateAvgLineDuration(lines: ContentLine[]): number {
  const durations: number[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const cur = lines[i].timestamp;
    const next = lines[i + 1].timestamp;
    if (cur !== null && next !== null && next > cur) {
      durations.push(next - cur);
    }
  }
  if (durations.length === 0) return 8;
  durations.sort((a, b) => a - b);
  // Use median to avoid outliers (long pauses between sections)
  return durations[Math.floor(durations.length / 2)];
}

export function useSongPlayback({
  lines,
  player,
}: SongPlaybackDeps): UseSongPlaybackReturn {
  const playingRef = useRef(false);

  const playLines = useCallback(
    (fromLine: number, toLine: number, onDone?: () => void) => {
      if (!lines || lines.length === 0) {
        console.warn("[song] no lines available");
        onDone?.();
        return;
      }

      const from = Math.max(0, fromLine - 1);
      const to = Math.min(lines.length - 1, toLine - 1);
      if (from > to) { onDone?.(); return; }

      // Estimate average line duration from the middle of the song (skip first/last
      // which may include intro/outro gaps). Used for intro skip and fallback timing.
      const avgLineDur = estimateAvgLineDuration(lines);

      const rawStart = lines[from].timestamp;
      const nextLineTs =
        to + 1 < lines.length && lines[to + 1].timestamp !== null
          ? lines[to + 1].timestamp!
          : null;

      let startSec = rawStart ?? 0;

      // Intro skip heuristic: if we're playing from line 1, its timestamp is near 0,
      // and the gap to line 2 is much larger than a typical line (~3x avg), then
      // the song has an instrumental intro. Jump forward so playback starts shortly
      // before the vocals instead of from the very beginning.
      if (from === 0 && startSec < 3 && nextLineTs !== null && nextLineTs > avgLineDur * 3) {
        startSec = Math.max(0, nextLineTs - avgLineDur - 2);
        console.log(`[song] intro skip: jumping to ${startSec.toFixed(1)}s (line 2 at ${nextLineTs}s)`);
      }

      // Add a small buffer (1.5s) past the next line's start so the current line's
      // audio finishes naturally instead of cutting off at the exact boundary.
      const endSec = nextLineTs !== null ? nextLineTs + 1.5 : startSec + (to - from + 1) * Math.max(avgLineDur, 6);

      console.log(`[song] playing lines ${fromLine}-${toLine} (${startSec}s → ${endSec}s)`);
      playingRef.current = true;
      player.seekAndPlay(startSec, endSec).then(() => {
        playingRef.current = false;
        onDone?.();
      });
    },
    [lines, player],
  );

  const pause = useCallback(() => {
    playingRef.current = false;
    player.pause();
  }, [player]);

  return { playLines, pause };
}
