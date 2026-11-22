import { getS } from './settings';
import { IVN, letter } from './notes';

export interface ExerciseCfg {
  type: 'single' | 'interval' | 'scale' | 'arp' | 'melody';
  intervals?: number[]; dir?: 'up' | 'down' | 'both';
  types?: string[]; shape?: 'up' | 'down' | 'updown';
  len?: number; rounds?: number;
}
export interface Pattern { notes: number[]; durs: number[]; root: number; label: string }

export const SCALES: Record<string, { n: string; s: number[] }> = {
  five: { n: 'Major 5-note', s: [0, 2, 4, 5, 7] }, major: { n: 'Major scale', s: [0, 2, 4, 5, 7, 9, 11, 12] },
  minor: { n: 'Natural minor', s: [0, 2, 3, 5, 7, 8, 10, 12] }, harmonic: { n: 'Harmonic minor', s: [0, 2, 3, 5, 7, 8, 11, 12] },
  majpent: { n: 'Major pentatonic', s: [0, 2, 4, 7, 9, 12] }, minpent: { n: 'Minor pentatonic', s: [0, 3, 5, 7, 10, 12] },
  blues: { n: 'Blues', s: [0, 3, 5, 6, 7, 10, 12] }, dorian: { n: 'Dorian', s: [0, 2, 3, 5, 7, 9, 10, 12] },
  chrom: { n: 'Chromatic', s: [0, 1, 2, 3, 4] },
};
export const ARPS: Record<string, { n: string; s: number[] }> = {
  maj: { n: 'Major triad', s: [0, 4, 7, 12] }, min: { n: 'Minor triad', s: [0, 3, 7, 12] }, dim: { n: 'Diminished', s: [0, 3, 6] },
  aug: { n: 'Augmented', s: [0, 4, 8] }, dom7: { n: 'Dominant 7th', s: [0, 4, 7, 10] }, maj7: { n: 'Major 7th', s: [0, 4, 7, 11] },
  min7: { n: 'Minor 7th', s: [0, 3, 7, 10] },
};

const ri = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const ARROW = { up: '↑', down: '↓', updown: '↑↓' } as const;

function pickRoot(span: number) {
  const S = getS(), lo = S.lo, hi = S.hi - span;
  return hi < lo ? Math.max(28, Math.round((S.lo + S.hi - span) / 2)) : ri(lo, hi);
}
function shapeSeq(s: number[], shape: string) {
  if (shape === 'down') return [...s].reverse();
  if (shape === 'updown') return s.concat(s.slice(0, -1).reverse());
  return [...s];
}

export function gen(cfg: ExerciseCfg): Pattern {
  const S = getS();
  switch (cfg.type) {
    case 'interval': {
      const iv = pick(cfg.intervals?.length ? cfg.intervals : [7]);
      const dir = cfg.dir === 'both' ? pick(['up', 'down'] as const) : cfg.dir || 'up';
      const root = pickRoot(iv);
      return { notes: dir === 'up' ? [root, root + iv] : [root + iv, root], durs: [1.5, 1.5], root, label: IVN[iv] + ' ' + (iv ? ARROW[dir] : '') };
    }
    case 'scale':
    case 'arp': {
      const lib = cfg.type === 'scale' ? SCALES : ARPS;
      const def = lib[pick(cfg.types?.length ? cfg.types : Object.keys(lib))];
      const span = Math.max(...def.s), root = pickRoot(span), shape = cfg.shape || 'updown';
      const seq = shapeSeq(def.s, shape);
      return { notes: seq.map(x => root + x), durs: seq.map((_, i) => (i === seq.length - 1 ? 2 : 1)), root, label: `${letter(root, false)} ${def.n} ${ARROW[shape]}` };
    }
    case 'melody': {
      const sc = [0, 2, 4, 5, 7, 9, 11, 12], len = cfg.len || 5;
      const range = S.hi - S.lo;
      const maxD = range >= 12 ? 7 : range >= 7 ? 4 : Math.max(1, sc.filter(x => x <= range).length - 1);
      const root = pickRoot(sc[maxD]);
      let d = pick([0, 2, 4].filter(x => x <= maxD));
      const notes: number[] = [], durs: number[] = [];
      for (let i = 0; i < len; i++) {
        notes.push(root + sc[d]);
        durs.push(i === len - 1 ? 2 : pick([1, 1, 1, 2]));
        let nd: number;
        do { nd = d + pick([-2, -1, -1, 1, 1, 2, 3, -3]); } while (nd < 0 || nd > maxD || nd === d);
        d = nd;
      }
      return { notes, durs, root, label: `Melody in ${letter(root, false)} major` };
    }
    default: {
      const m = ri(S.lo, S.hi);
      return { notes: [m], durs: [2], root: m, label: 'Match the note' };
    }
  }
}

export const LEVELS: { name: string; desc: string; cfg: ExerciseCfg }[] = [
  { name: 'Match the note', desc: 'Hear a single note and sing it back.', cfg: { type: 'single' } },
  { name: 'Repeat & step', desc: 'Unisons and whole steps.', cfg: { type: 'interval', intervals: [0, 2], dir: 'both' } },
  { name: 'Half & whole steps', desc: 'Minor and major 2nds, up and down.', cfg: { type: 'interval', intervals: [1, 2], dir: 'both' } },
  { name: 'Thirds', desc: 'Minor and major 3rds.', cfg: { type: 'interval', intervals: [3, 4], dir: 'both' } },
  { name: 'Five-note scale', desc: 'Do Re Mi Fa Sol and back.', cfg: { type: 'scale', types: ['five'], shape: 'updown' } },
  { name: 'Fourths & fifths ↑', desc: 'Perfect 4th and 5th, ascending.', cfg: { type: 'interval', intervals: [5, 7], dir: 'up' } },
  { name: 'Fourths & fifths ↓', desc: 'Perfect 4th and 5th, descending.', cfg: { type: 'interval', intervals: [5, 7], dir: 'down' } },
  { name: 'Major triad', desc: 'Do Mi Sol Do arpeggios.', cfg: { type: 'arp', types: ['maj'], shape: 'updown' } },
  { name: 'Minor triad', desc: 'Minor arpeggios.', cfg: { type: 'arp', types: ['min'], shape: 'updown' } },
  { name: 'Major scale', desc: 'A full octave up and down.', cfg: { type: 'scale', types: ['major'], shape: 'updown' } },
  { name: 'Minor scale', desc: 'Natural minor, up and down.', cfg: { type: 'scale', types: ['minor'], shape: 'updown' } },
  { name: 'Pentatonics', desc: 'Major and minor pentatonic.', cfg: { type: 'scale', types: ['majpent', 'minpent'], shape: 'updown' } },
  { name: 'Sixths & octaves', desc: 'Bigger leaps.', cfg: { type: 'interval', intervals: [8, 9, 12], dir: 'both' } },
  { name: 'Seventh chords', desc: 'Dom7, maj7 and min7 arpeggios.', cfg: { type: 'arp', types: ['dom7', 'maj7', 'min7'], shape: 'up' } },
  { name: 'Chromatic steps', desc: 'Five semitones up and down.', cfg: { type: 'scale', types: ['chrom'], shape: 'updown' } },
  { name: 'Tritones & sevenths', desc: 'The tricky intervals.', cfg: { type: 'interval', intervals: [6, 10, 11], dir: 'both' } },
  { name: 'Short melodies', desc: 'Random 4-note tunes.', cfg: { type: 'melody', len: 4 } },
  { name: 'Longer melodies', desc: 'Random 6-note tunes.', cfg: { type: 'melody', len: 6 } },
  { name: 'All intervals', desc: 'Anything from a half step to an octave.', cfg: { type: 'interval', intervals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], dir: 'both' } },
];

export const starCount = (p: number) => (p >= 0.9 ? 3 : p >= 0.8 ? 2 : p >= 0.7 ? 1 : 0);
export const scoreColor = (s: number) => (s >= 0.8 ? '#46d18a' : s >= 0.6 ? '#f5b84a' : '#ff6b6b');
