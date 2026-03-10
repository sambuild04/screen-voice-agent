let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function tone(freq: number, start: number, dur: number, vol = 0.25) {
  const ac = getCtx();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.start(start);
  osc.stop(start + dur);
}

/** Two ascending tones — "I heard you" chime */
export function playChime() {
  const now = getCtx().currentTime;
  tone(523, now, 0.15);
  tone(659, now + 0.1, 0.2);
}

/** Soft descending tone — "going back to sleep" */
export function playSleep() {
  const now = getCtx().currentTime;
  tone(440, now, 0.25, 0.15);
  tone(349, now + 0.15, 0.25, 0.12);
}
