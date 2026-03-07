import { spawn, type ChildProcess } from "node:child_process";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
// ~100ms of audio per chunk
const CHUNK_BYTES = (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)) / 10;

export interface MicStream {
  /** Emitted with base64-encoded PCM16 chunks (~100ms each). */
  onData: (handler: (base64Chunk: string) => void) => void;
  stop: () => void;
}

/**
 * Start recording from the default microphone via sox `rec`.
 * Streams raw PCM16 mono at 24kHz — the format the Realtime API expects.
 */
export function startMic(): MicStream {
  const proc: ChildProcess = spawn("rec", [
    "-q",               // quiet (no progress)
    "-r", String(SAMPLE_RATE),
    "-c", String(CHANNELS),
    "-e", "signed-integer",
    "-b", String(BIT_DEPTH),
    "-t", "raw",        // raw PCM output
    "-",                // write to stdout
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  let handler: ((b64: string) => void) | null = null;
  let buffer = Buffer.alloc(0);

  proc.stdout!.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= CHUNK_BYTES) {
      const chunk = buffer.subarray(0, CHUNK_BYTES);
      buffer = buffer.subarray(CHUNK_BYTES);
      if (handler) handler(chunk.toString("base64"));
    }
  });

  return {
    onData(h) { handler = h; },
    stop() {
      handler = null;
      proc.kill("SIGTERM");
    },
  };
}
