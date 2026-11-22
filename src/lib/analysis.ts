/** Per-note measurement collected while singing. */
export interface NoteMeasure extends Scored {
  frames: number;
  /** [seconds since note start, cents from target] */
  samples: [number, number][];
}

export interface NoteResult {
  m: number;               // target MIDI note
  iv: number | null;       // semitones from previous target (null = first)
  score: number;           // % time in tune
  voiced: number;          // % frames with detected voice
  sung: boolean;
  oct?: number; start?: number; settle?: number | null; onset?: number;
  cents?: number; wobble?: number; drift?: number; vib?: number; held?: number;
}

export const med = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sdev = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

export type ScoringVersion = 'v1' | 'v2';

/** Scoring state kept on each note while it's being sung. */
export interface Scored {
  hit: number; total: number;
  // v2 only
  span?: number;               // scorable time (outside the slide zones), voiced or not
  voiced?: number;             // part of `span` where a pitch was detected
  recent?: [number, number][]; // [t, cents] over the last SMOOTH seconds, for smoothing
}

/** v2: average pitch over ~one vibrato cycle, so even vibrato around the note counts as in tune. */
const SMOOTH = 0.2;
/** v2: a frame-to-frame change bigger than this (cents) restarts the smoothing (new pitch, not vibrato). */
const JUMP_CENTS = 150;
/** v2: cents off where graded credit reaches zero. */
const ZERO_AT = 100;
/** v2: share of a note you need to be heard on for full marks (consonants, breaths, mic dropouts). */
const COVER = 0.6;

/** v2 partial credit: full inside the tolerance, fading linearly to nothing at ZERO_AT cents. */
export const grade = (absCents: number, tol: number) =>
  absCents <= tol ? 1 : tol >= ZERO_AT ? 0 : Math.max(0, 1 - (absCents - tol) / (ZERO_AT - tol));

export interface StepIn {
  t: number;              // seconds since the note started
  dur: number;            // note length
  d: number;              // seconds since the last frame
  cents: number | null;   // raw pitch error (octave-folded if allowed), null = no voice
  tol: number; slide: number; v: ScoringVersion;
  anyPitch?: boolean;     // rap notes: any voiced sound counts
}

/**
 * Add one frame of singing to a note's score; returns the pitch error that was judged (smoothed in v2),
 * which callers use to colour the trace.
 *
 * Both versions: near the start and end of the note (within `slide` s, at most a third of the note each)
 * the singer may be sliding between notes, so being in tune there counts but being off doesn't.
 *
 * v1: every frame is in or out (|cents| ≤ tol); frames with no detected voice count as misses.
 * v2: frames with no voice are left out (see COVER for the minimum), pitch is smoothed over ~200 ms
 *     so vibrato and detector jitter don't count against you, and credit is graded rather than all-or-nothing.
 */
export function step(n: Scored, o: StepIn): number | null {
  const w = Math.min(o.slide, o.dur / 3);
  const inSlide = o.t < w || o.t > o.dur - w;

  if (o.v === 'v1') {
    const good = o.cents != null && (o.anyPitch || Math.abs(o.cents) <= o.tol);
    if (inSlide) { if (good) { n.hit += o.d; n.total += o.d; } }
    else { n.total += o.d; if (good) n.hit += o.d; }
    return o.cents;
  }

  if (!inSlide) n.span = (n.span ?? 0) + o.d;
  if (o.cents == null) return null;
  const r = (n.recent ??= []);
  const c = Math.max(-300, Math.min(300, o.cents)); // clamp so a detector glitch can't swamp the average
  // a jump of more than 1.5 semitones is a new pitch (a correction or a slide landing), not vibrato:
  // restart the average so the correction counts straight away
  if (r.length && Math.abs(c - r[r.length - 1][1]) > JUMP_CENTS) r.length = 0;
  r.push([o.t, c]);
  while (r.length && o.t - r[0][0] > SMOOTH) r.shift();
  const sm = r.reduce((a, x) => a + x[1], 0) / r.length;
  const g = o.anyPitch ? 1 : grade(Math.abs(sm), o.tol);
  if (inSlide) { n.hit += o.d * g; n.total += o.d * g; }
  else { n.voiced = (n.voiced ?? 0) + o.d; n.total += o.d; n.hit += o.d * g; }
  return sm;
}

/** Forget a note's scoring state (e.g. after seeking back over it). */
export function resetScore(n: Scored) {
  n.hit = 0; n.total = 0; n.span = undefined; n.voiced = undefined; n.recent = undefined;
}

/** Raw note score 0..1 (share of the note sung in tune). */
export const noteScore = (n: Scored) => {
  if (!(n.total > 0)) return 0;
  const s = Math.min(1, n.hit / n.total);
  if (n.span == null || n.span <= 0) return s; // v1
  return s * Math.min(1, (n.voiced ?? 0) / n.span / COVER);
};

/**
 * Karaoke-machine style display score: the same singing reads higher, much like DAM / JOYSOUND
 * where ~85 % pitch accuracy lands in the mid 90s. Monotonic, so rankings never change.
 * 50 % → 67, 70 % → 85, 85 % → 95, 95 % → 99.
 */
export const karaokeCurve = (raw: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, raw)), 1.6);

/** The score shown and saved for a note, honouring the "karaoke-style score" setting. */
export const shownScore = (n: Scored, curve: boolean) => (curve ? karaokeCurve(noteScore(n)) : noteScore(n));

export function analyzeNote(n: NoteMeasure, tol: number, m: number, iv: number | null): NoteResult {
  const raw = n.samples;
  const out: NoteResult = { m, iv, score: Math.round(noteScore(n) * 100), voiced: Math.round((100 * raw.length) / Math.max(1, n.frames)), sung: false };
  if (raw.length < 6) return out;
  out.sung = true;
  const m0 = med(raw.map(x => x[1]));
  let oct = 0;
  if (Math.abs(m0) >= 1000) {
    const o = Math.round(m0 / 1200);
    if (o && Math.abs(m0 - o * 1200) < 200) { oct = o; out.oct = o; }
  }
  const s = raw.map(([t, c]) => [t, c - oct * 1200] as [number, number]);
  out.start = +s[0][0].toFixed(2);
  let settle: number | null = null, run: number | null = null;
  for (const [t, c] of s) {
    if (Math.abs(c) <= tol) { if (run == null) run = t; if (t - run >= 0.1) { settle = run; break; } }
    else run = null;
  }
  out.settle = settle == null ? null : +settle.toFixed(2);
  out.onset = Math.round(med(s.filter(([t]) => t - s[0][0] < 0.15).map(x => x[1])));
  const from = settle != null ? settle : Math.min(0.25, s[s.length - 1][0]);
  let body = s.filter(([t]) => t >= from);
  if (body.length < 4) body = s;
  const bc = body.map(x => x[1]);
  out.cents = Math.round(med(bc));
  out.wobble = Math.round(sdev(bc));
  const dur = body[body.length - 1][0] - body[0][0];
  out.held = +dur.toFixed(2);
  if (dur >= 0.6) {
    const k = Math.max(2, Math.floor(bc.length / 3));
    out.drift = Math.round(med(bc.slice(-k)) - med(bc.slice(0, k)));
  }
  if (dur >= 0.8 && out.wobble >= 12) {
    const mc = med(bc);
    let st = 0, cross = 0;
    for (const c of bc) {
      const d = c - mc, sg = d > 8 ? 1 : d < -8 ? -1 : 0;
      if (sg && sg !== st) { if (st) cross++; st = sg; }
    }
    const rate = cross / 2 / dur;
    if (rate >= 4 && rate <= 8.5) out.vib = +rate.toFixed(1);
  }
  return out;
}
