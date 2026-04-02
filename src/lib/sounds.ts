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

/** Bubble pop — vocab card appearing */
export function playBubblePop() {
  const ac = getCtx();
  const now = ac.currentTime;

  // Short rising "bloop" with quick pitch sweep
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(800, now + 0.06);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.12);
  gain.gain.setValueAtTime(0.8, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.start(now);
  osc.stop(now + 0.18);

  // Soft high overtone for the "pop" snap
  const osc2 = ac.createOscillator();
  const gain2 = ac.createGain();
  osc2.connect(gain2);
  gain2.connect(ac.destination);
  osc2.type = "triangle";
  osc2.frequency.setValueAtTime(1200, now + 0.03);
  osc2.frequency.exponentialRampToValueAtTime(900, now + 0.1);
  gain2.gain.setValueAtTime(0.4, now + 0.03);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
  osc2.start(now + 0.03);
  osc2.stop(now + 0.12);
}
