import { describe, expect, it } from 'vitest';
import { noteScore, step, type Scored, type StepIn } from '../../src/lib/analysis';

const DT = 1 / 60;
const base = { dur: 1, d: DT, tol: 35, slide: 0, v: 'v2' } as const;
/** Feed a sequence of cents readings (one per frame) into a fresh note; returns the judged values. */
function sing(cents: (number | null)[], opts: Partial<StepIn> = {}) {
  const n: Scored = { hit: 0, total: 0 };
  const judged = cents.map((c, i) => step(n, { ...base, ...opts, t: i * DT, cents: c }));
  return { n, judged };
}

describe('v2 scoring', () => {
  it('counts even vibrato around the note as in tune', () => {
    const vib = Array.from({ length: 60 }, (_, i) => 60 * Math.sin((2 * Math.PI * 5.5 * i) / 60)); // ±60 cents at 5.5 Hz
    expect(noteScore(sing(vib).n)).toBeGreaterThan(0.9);
    expect(noteScore(sing(vib, { v: 'v1' }).n)).toBeLessThan(0.75); // v1 was harsh on this
  });

  it('a correction counts straight away (smoothing restarts after a jump)', () => {
    // 2 semitones flat for 20 frames, then in tune
    const { judged } = sing([...Array(20).fill(-200), ...Array(20).fill(0)]);
    expect(judged[20]).toBe(0);
  });

  it('ignores moments with no voice, up to the coverage limit', () => {
    const gappy = Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? null : 0)); // 75% voiced
    expect(noteScore(sing(gappy).n)).toBeCloseTo(1, 5);
    const mostlySilent = Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? 0 : null)); // 25% voiced
    expect(noteScore(sing(mostlySilent).n)).toBeLessThan(0.5);
  });

  it('gives partial credit when slightly off', () => {
    const s = noteScore(sing(Array(60).fill(60)).n); // 60 cents off with 35 tolerance
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.8);
  });
});
