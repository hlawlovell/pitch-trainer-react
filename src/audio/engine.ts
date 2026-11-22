import { getS } from '../lib/settings';
import { ftom, mtof } from '../lib/notes';
import { PIANO_SAMPLES } from './pianoSamples';
import { smoothStep } from '../lib/trace';

/* ---------------- Audio context & mic ---------------- */
let AC: AudioContext | null = null;
let master: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let tbuf: Float32Array<ArrayBuffer> | null = null;
let yinBuf: Float32Array | null = null;
export let micStream: MediaStream | null = null;
const waves: Record<string, PeriodicWave> = {};

export const getCtx = () => AC;
export const hasMic = () => !!analyser;

export async function ensureAudio(needMic: boolean) {
  if (!AC) {
    AC = new (window.AudioContext || (window as any).webkitAudioContext)();
    master = AC.createGain();
    master.gain.value = getS().volume;
    master.connect(AC.destination);
    const mk = (h: number[]) => {
      const re = new Float32Array(h.length + 1), im = new Float32Array(h.length + 1);
      h.forEach((a, i) => (im[i + 1] = a));
      return AC!.createPeriodicWave(re, im);
    };
    waves.soft = mk([1, 0.45, 0.25, 0.12, 0.06, 0.03]);
    waves.bright = mk([1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08, 0.05, 0.03]);
    loadPiano();
  }
  if (AC.state === 'suspended') await AC.resume();
  await loadPiano();
  if (needMic && !analyser) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('This browser blocks the microphone for this page. Open it from http://localhost or use Chrome / Firefox.');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = AC.createMediaStreamSource(micStream);
    analyser = AC.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    tbuf = new Float32Array(analyser.fftSize);
    yinBuf = new Float32Array(analyser.fftSize / 2);
  }
}

export function setMasterVolume(v: number) {
  if (master) master.gain.value = v;
}

/* ---------------- Piano samples ---------------- */
const pianoBufs: Record<number, AudioBuffer> = {};
let pianoLoading: Promise<void> | null = null;
function loadPiano() {
  if (pianoLoading || !AC) return pianoLoading;
  const ctx = AC;
  pianoLoading = Promise.all(
    Object.entries(PIANO_SAMPLES).map(async ([k, url]) => {
      const ab = await (await fetch(url)).arrayBuffer();
      pianoBufs[+k] = await new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(ab, res, rej));
    }),
  ).then(() => undefined).catch(e => console.warn('piano samples failed to load', e));
  return pianoLoading;
}

/* ---------------- Voices ---------------- */
interface Voice { srcs: AudioScheduledSourceNode[]; g: GainNode }
const voices = new Set<Voice>();

export interface PlayedNote { midi: number; until: number }
const noteListeners = new Set<(n: PlayedNote) => void>();
export function onNotePlayed(cb: (n: PlayedNote) => void) {
  noteListeners.add(cb);
  return () => { noteListeners.delete(cb); };
}
export let lastPlayed: PlayedNote | null = null;

/** Play a reference note now. dur in seconds. */
export function playNote(m: number, dur: number, vol = 1) {
  if (!AC || !master) return;
  const t = AC.currentTime;
  const S = getS();
  let v: Voice | null = null;
  const keys = Object.keys(pianoBufs).map(Number);
  if (S.tone === 'piano' && keys.length) {
    const k = keys.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
    const src = AC.createBufferSource(), g = AC.createGain(), gv = 0.55 * vol;
    src.buffer = pianoBufs[k];
    src.playbackRate.value = Math.pow(2, (m - k) / 12);
    g.gain.setValueAtTime(gv, t);
    g.gain.setValueAtTime(gv, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.09);
    src.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.7);
    v = { srcs: [src], g };
  } else {
    const o = AC.createOscillator(), g = AC.createGain();
    if (S.tone === 'sine') o.type = 'sine';
    else o.setPeriodicWave(waves[S.tone] || waves.soft);
    o.frequency.value = mtof(m);
    const gv = 0.22 * vol, bright = S.tone === 'bright';
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gv, t + 0.012);
    g.gain.setTargetAtTime(gv * (bright ? 0.25 : 0.6), t + 0.02, bright ? 0.35 : 0.25);
    g.gain.setTargetAtTime(0, t + dur, 0.05);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.4);
    v = { srcs: [o], g };
  }
  voices.add(v);
  v.srcs[0].onended = () => voices.delete(v!);
  lastPlayed = { midi: m, until: performance.now() / 1000 + dur };
  noteListeners.forEach(l => l(lastPlayed!));
}

export function click(accent: boolean) {
  if (!AC || !master) return;
  const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
  o.type = 'square';
  o.frequency.value = accent ? 1600 : 1100;
  g.gain.setValueAtTime(0.08, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + 0.06);
}

export function stopAll() {
  if (!AC) return;
  const t = AC.currentTime;
  voices.forEach(v => {
    try {
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setTargetAtTime(0, t, 0.02);
      v.srcs.forEach(s => { try { s.stop(t + 0.15); } catch { /* already stopped */ } });
    } catch { /* ignore */ }
  });
  voices.clear();
  if (lastPlayed) lastPlayed = { ...lastPlayed, until: 0 };
}

/* ---------------- Pitch detection (YIN) ---------------- */
function yin(x: Float32Array, sr: number): number | null {
  const W = x.length >> 1, d = yinBuf!;
  const tMin = Math.max(2, Math.floor(sr / 1400)), tMax = Math.min(W - 2, Math.floor(sr / 60));
  for (let tau = 1; tau <= tMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) { const v = x[j] - x[j + tau]; s += v * v; }
    d[tau] = s;
  }
  d[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tMax; tau++) { run += d[tau]; d[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
  let tau = -1;
  for (let t = tMin; t <= tMax; t++) {
    if (d[t] < 0.12) { while (t + 1 <= tMax && d[t + 1] < d[t]) t++; tau = t; break; }
  }
  if (tau < 0) {
    let mn = 1, mi = -1;
    for (let t = tMin; t <= tMax; t++) if (d[t] < mn) { mn = d[t]; mi = t; }
    if (mn < 0.22) tau = mi; else return null;
  }
  let bt = tau;
  if (tau > 1 && tau < tMax) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a + c - 2 * b;
    if (den !== 0) bt = tau + (a - c) / (2 * den);
  }
  return sr / bt;
}

/**
 * Live sung pitch (fractional MIDI) or null, updated every animation frame.
 * `pitch` is the raw reading (used for scoring); `shown` is smoothed for display (the pitch dot,
 * the tuner needle) according to Settings → Pitch line smoothing.
 */
export const live = { pitch: null as number | null, shown: null as number | null, stable: [] as number[] };
const pHist: number[] = [];
let nullRun = 0;
let shownAt = 0;
function detect() {
  detectRaw();
  const now = performance.now() / 1000, dt = now - shownAt;
  shownAt = now;
  live.shown = smoothStep(live.shown, live.pitch, dt, getS().traceSmoothMs / 1000);
}
function detectRaw() {
  // test hook: window.__ptSim = () => midi|null replaces the microphone
  const sim = (window as any).__ptSim;
  if (sim) { live.pitch = sim(); return; }
  if (!analyser || !tbuf || !AC) { live.pitch = null; return; }
  analyser.getFloatTimeDomainData(tbuf);
  let rms = 0;
  for (let i = 0; i < tbuf.length; i++) rms += tbuf[i] * tbuf[i];
  rms = Math.sqrt(rms / tbuf.length);
  let m: number | null = null;
  if (rms >= getS().gate) {
    const f = yin(tbuf, AC.sampleRate);
    if (f) { m = ftom(f); if (m < 28 || m > 100) m = null; }
  }
  if (m == null) {
    if (++nullRun > 2) { live.pitch = null; pHist.length = 0; }
    return;
  }
  nullRun = 0;
  pHist.push(m);
  if (pHist.length > 3) pHist.shift();
  const s = [...pHist].sort((a, b) => a - b);
  live.pitch = s[s.length >> 1];
  live.stable.push(live.pitch);
  if (live.stable.length > 40) live.stable.shift();
}

/** Median of the last ~0.4s of sung pitch, rounded (for "set range by singing"). */
export function stableNote(): number | null {
  if (live.stable.length < 10) return null;
  const s = live.stable.slice(-25).sort((a, b) => a - b);
  return Math.round(s[s.length >> 1]);
}

/* ---------------- Frame loop ---------------- */
type FrameCb = (dt: number) => void;
const frameCbs = new Set<FrameCb>();
let last = performance.now() / 1000;
let running = false;
function loop() {
  requestAnimationFrame(loop);
  detect();
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, Math.max(0, now - last));
  last = now;
  frameCbs.forEach(cb => cb(dt));
}
/** Run cb every animation frame (after pitch detection). Returns unsubscribe. */
export function onFrame(cb: FrameCb) {
  frameCbs.add(cb);
  if (!running) { running = true; requestAnimationFrame(loop); }
  return () => { frameCbs.delete(cb); };
}
