import { spawn, type ChildProcess } from "node:child_process";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);

/**
 * Streams PCM16 audio to the speaker via sox `play`.
 * Call `write()` with base64-encoded PCM16 chunks.
 * Call `stop()` to interrupt playback immediately (e.g. on user interruption).
 * Call `drain()` to wait for the current buffer to finish playing, then stop.
 *
 * Tracks total bytes per "session" (one model response) so callers can
 * estimate how much audio was actually received — useful for detecting
 * the known OpenAI Realtime API audio-truncation bug.
 */
export class AudioPlayer {
  private proc: ChildProcess | null = null;
  private playing = false;
  private totalBytes = 0;

  private ensure(): ChildProcess {
    if (this.proc && this.playing) return this.proc;

    this.proc = spawn("play", [
      "-q",
      "-t", "raw",
      "-r", String(SAMPLE_RATE),
      "-e", "signed-integer",
      "-b", String(BIT_DEPTH),
      "-c", String(CHANNELS),
      "-",
    ], {
      stdio: ["pipe", "ignore", "ignore"],
    });

    this.playing = true;

    this.proc.stdin!.on("error", () => {
      this.playing = false;
      this.proc = null;
    });

    this.proc.on("close", () => {
      this.playing = false;
      this.proc = null;
    });

    this.proc.on("error", () => {
      this.playing = false;
      this.proc = null;
    });

    return this.proc;
  }

  /** Write a base64-encoded PCM16 chunk to the speaker. */
  write(base64Chunk: string): void {
    const proc = this.ensure();
    const buf = Buffer.from(base64Chunk, "base64");
    this.totalBytes += buf.length;
    try {
      proc.stdin!.write(buf);
    } catch {
      // Process may have died between ensure() and write()
    }
  }

  /** Immediately stop playback (kills the play process). */
  stop(): void {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      this.playing = false;
      try { p.stdin!.end(); } catch { /* already closed */ }
      try { p.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }

  /** Close stdin and wait for playback to finish naturally. */
  drain(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.proc || !this.playing) {
        resolve();
        return;
      }
      this.proc.on("close", () => resolve());
      try { this.proc.stdin!.end(); } catch { resolve(); }
    });
  }

  /** Estimated seconds of audio received since last `resetSession()`. */
  get audioDurationSecs(): number {
    return this.totalBytes / BYTES_PER_SEC;
  }

  /** Reset byte counter for a new response. */
  resetSession(): void {
    this.totalBytes = 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
