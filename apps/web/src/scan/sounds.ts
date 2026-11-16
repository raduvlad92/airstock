/**
 * Short tones for a good scan and an error (plan 5.12). iOS has no vibration API, so sound and a
 * colour flash are the feedback; Android also vibrates. Web Audio needs a user gesture before it
 * plays on iOS, so the context is created on the first tap or key press. While sounds are on, the
 * page's audio session is "playback", so the tones play with the ringer switched to silent.
 */
type Tone = { frequency: number; ms: number; gapMs?: number };

const TONES: Record<'ok' | 'error' | 'notice', Tone[]> = {
  ok: [{ frequency: 1760, ms: 70 }],
  notice: [
    { frequency: 1320, ms: 60, gapMs: 40 },
    { frequency: 1760, ms: 60 },
  ],
  error: [
    { frequency: 330, ms: 140, gapMs: 70 },
    { frequency: 247, ms: 220 },
  ],
};

const STORAGE_KEY = 'airstock.scan.sound';
let context: AudioContext | null = null;
let enabled = readEnabled();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  setAudioSession();
}

function setAudioSession(): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = enabled ? 'playback' : 'auto';
}

/** Call from a user gesture (pointerdown, keydown): iOS starts audio only then. */
export function unlockAudio(): void {
  if (!enabled) return;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  if (!context) {
    setAudioSession();
    context = new Ctor();
  }
  if (context.state === 'suspended') void context.resume();
}

export function feedback(kind: 'ok' | 'error' | 'notice'): void {
  // Android vibrates; iOS has no vibration API.
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(kind === 'error' ? [80, 60, 120] : [40]);
  }
  if (!enabled || !context) return;
  let at = context.currentTime + 0.01;
  for (const tone of TONES[kind]) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = kind === 'error' ? 'square' : 'sine';
    osc.frequency.value = tone.frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.ms / 1000);
    osc.connect(gain).connect(context.destination);
    osc.start(at);
    osc.stop(at + tone.ms / 1000 + 0.02);
    at += (tone.ms + (tone.gapMs ?? 0)) / 1000;
  }
}
