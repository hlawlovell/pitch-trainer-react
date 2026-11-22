import { describe, expect, it } from 'vitest';
import { smoothStep, smoothTrace, type TracePt } from '../../src/lib/trace';

const DT = 1 / 60; // one animation frame
const pts = (ms: (number | null)[], dt = DT) => ms.map((m, i) => ({ t: i * dt, m })) as TracePt[];
const jitter = (n: number, base = 60, amp = 0.3) => Array.from({ length: n }, (_, i) => base + (i % 2 ? amp : -amp));

describe('smoothTrace (pitch line, display only)', () => {
  it('returns the raw line when smoothing is off', () => {
    expect(smoothTrace(pts([60, 61, 60]), 0)).toEqual([60, 61, 60]);
  });

  it('steadies jitter on a held note, including the newest point', () => {
    const ys = smoothTrace(pts(jitter(120)), 0.12);
    // after it settles, every point – right up to the live end – stays within a few cents of the note
    for (const y of ys.slice(40)) expect(Math.abs(y - 60)).toBeLessThan(0.05);
    expect(Math.abs(ys.at(-1)! - 60)).toBeLessThan(0.05);
  });

  it('only looks backwards: adding points never changes ones already drawn', () => {
    const tr = pts(jitter(60));
    const before = smoothTrace(tr.slice(0, 40), 0.12);
    const after = smoothTrace(tr, 0.12).slice(0, 40);
    expect(after).toEqual(before);
  });

  it('never smooths across silence', () => {
    const ys = smoothTrace(pts([60, 60, 60, null, 64, 64, 64]), 1);
    expect(ys.slice(0, 3)).toEqual([60, 60, 60]);
    expect(Number.isNaN(ys[3])).toBe(true);
    expect(ys.slice(4)).toEqual([64, 64, 64]);
  });

  it('keeps note changes sharp (restarts after a jump of more than 1.5 semitones)', () => {
    const ys = smoothTrace(pts([60, 60, 60, 60, 63, 63, 63, 63]), 1);
    expect(ys.slice(0, 4)).toEqual([60, 60, 60, 60]);
    expect(ys.slice(4)).toEqual([63, 63, 63, 63]);
  });

  it('never smooths across a time gap', () => {
    const tr: TracePt[] = [{ t: 0, m: 60 }, { t: 0.01, m: 60 }, { t: 1, m: 61 }, { t: 1.01, m: 61 }];
    expect(smoothTrace(tr, 2)).toEqual([60, 60, 61, 61]);
  });
});

describe('smoothStep (live pitch dot and tuner)', () => {
  it('follows a small pitch change gradually', () => {
    let y: number | null = 60;
    for (let i = 0; i < 6; i++) y = smoothStep(y, 60.5, DT, 0.12);
    expect(y!).toBeGreaterThan(60.1);
    expect(y!).toBeLessThan(60.5);
  });

  it('settles on the sung pitch within about half a second', () => {
    let y: number | null = 60;
    for (let i = 0; i < 30; i++) y = smoothStep(y, 60.5, DT, 0.12);
    expect(y!).toBeCloseTo(60.5, 1);
  });

  it('jumps straight to a new note and clears on silence', () => {
    expect(smoothStep(60, 64, DT, 0.12)).toBe(64);
    expect(smoothStep(60, null, DT, 0.12)).toBeNull();
    expect(smoothStep(null, 62, DT, 0.12)).toBe(62);
  });
});
