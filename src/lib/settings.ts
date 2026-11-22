import { useSyncExternalStore } from 'react';
import { lsGet, lsSet } from './storage';
import type { ScoringVersion } from './analysis';

export type Naming = 'letter' | 'both' | 'fixed' | 'movable';
export type Mode = 'echo' | 'along' | 'cue';
export type Tone = 'piano' | 'soft' | 'bright' | 'sine';

export interface Settings {
  lo: number; hi: number; rangeSet: boolean;
  naming: Naming; octave: boolean; accidental: 'sharp' | 'flat';
  tol: number; slideMs: number; scoring: ScoringVersion; scoreCurve: boolean; tempo: number; mode: Mode; wait: boolean; countIn: boolean; anyOctave: boolean;
  tone: Tone; volume: number; gate: number; record: boolean; traceSmoothMs: number;
  // karaoke
  kLatencyMs: number; kAnyOctave: boolean; kGuide: boolean; kGuideVol: number; kSongVol: number;
  kVideo: boolean; kStoreSongs: boolean; kZoom: number; kPinyin: boolean;
}

export const DEFAULTS: Settings = {
  lo: 48, hi: 72, rangeSet: false,
  naming: 'letter', octave: true, accidental: 'sharp',
  tol: 35, slideMs: 150, scoring: 'v2', scoreCurve: false, tempo: 80, mode: 'echo', wait: false, countIn: true, anyOctave: false,
  tone: 'piano', volume: 0.6, gate: 0.01, record: true, traceSmoothMs: 120,
  kLatencyMs: 100, kAnyOctave: true, kGuide: false, kGuideVol: 0.5, kSongVol: 0.8,
  kVideo: true, kStoreSongs: true, kZoom: 260, kPinyin: true,
};

const KEY = 'pt_settings';

/**
 * Settings are saved whole, so a saved value that was only ever the old default would hide a new
 * default forever. Each migration moves values still at an old default to the new one (values the user
 * actually changed are left alone). Bump VERSION and add a step when changing a default.
 */
const VERSION = 1;
const MIGRATIONS: ((s: Partial<Settings>) => void)[] = [
  // v1: wider karaoke notes (scroll speed 170 → 260 px/s), steadier pitch display (80 → 120 ms)
  s => {
    if (s.kZoom === 170) s.kZoom = 260;
    if (s.traceSmoothMs === 80) s.traceSmoothMs = 120;
  },
];
function loadSettings(): Settings {
  const saved = lsGet<Partial<Settings> & { _v?: number }>(KEY, {});
  const from = saved._v ?? 0;
  if (Object.keys(saved).length && from < VERSION) {
    for (let v = from; v < VERSION; v++) MIGRATIONS[v](saved);
    saved._v = VERSION;
    lsSet(KEY, saved);
  }
  delete saved._v;
  return { ...DEFAULTS, ...saved };
}
let S: Settings = loadSettings();
const listeners = new Set<() => void>();

export const getS = () => S;

export function setS(patch: Partial<Settings>) {
  S = { ...S, ...patch };
  if (S.hi - S.lo < 5) {
    if ('lo' in patch) S.hi = S.lo + 5; else S.lo = S.hi - 5;
  }
  lsSet(KEY, { ...S, _v: VERSION });
  listeners.forEach(l => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getS);
}
