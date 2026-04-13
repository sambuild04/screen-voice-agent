import { useCallback, useRef } from "react";
import type { ContentLine } from "./useTeachMode";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";

export interface UseSongPlaybackReturn {
  playLines: (fromLine: number, toLine: number, onDone?: () => void) => void;
  pause: () => void;
}

interface SongPlaybackDeps {
  lines: ContentLine[] | null;
  player: UseAudioPlayerReturn;
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

      // Use synced timestamps when available; fall back to start=0 with ~8s per line
      const rawStart = lines[from].timestamp;
      const rawEnd =
        to + 1 < lines.length && lines[to + 1].timestamp !== null
          ? lines[to + 1].timestamp!
          : null;

      const startSec = rawStart ?? 0;
      const endSec = rawEnd !== null ? rawEnd : startSec + (to - from + 1) * 8;

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
