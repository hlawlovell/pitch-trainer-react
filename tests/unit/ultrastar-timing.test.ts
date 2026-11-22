import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUltrastar } from '../../src/lib/ultrastar';

const song = (body: string, head = '#TITLE:T\n#ARTIST:A\n#BPM:300\n#GAP:0\n') => parseUltrastar(head + body + '\nE\n');
const notes = (s: ReturnType<typeof parseUltrastar>) => s.tracks[0].lines.flatMap(l => l.notes);

describe('UltraStar note timing (time = GAP + beat × 60 / (BPM × 4))', () => {
  it('places notes at the right seconds', () => {
    const n = notes(song(': 0 4 0 a\n: 20 10 2 b'));
    // BPM 300 → 0.05 s per beat
    expect(n[0].start).toBeCloseTo(0, 6);
    expect(n[0].end).toBeCloseTo(0.2, 6);
    expect(n[1].start).toBeCloseTo(1.0, 6);
    expect(n[1].end).toBeCloseTo(1.5, 6);
  });

  it('applies GAP in milliseconds', () => {
    const n = notes(song(': 0 4 0 a', '#BPM:300\n#GAP:6352\n'));
    expect(n[0].start).toBeCloseTo(6.352, 6);
  });

  it('accepts decimal commas in BPM and GAP (common in real files)', () => {
    const n = notes(song(': 100 4 0 a', '#BPM:288,04\n#GAP:29728,92\n'));
    expect(n[0].start).toBeCloseTo(29.72892 + (100 * 60) / (288.04 * 4), 6);
  });

  it('handles RELATIVE files (beats restart after each line break)', () => {
    const n = notes(song(': 0 4 0 a\n- 8 8\n: 0 4 0 b', '#BPM:300\n#GAP:0\n#RELATIVE:yes\n'));
    expect(n[1].start).toBeCloseTo(8 * 0.05, 6);
  });

  it('matches the audio-sync fixture: first note at 20 s', () => {
    const s = parseUltrastar(readFileSync(new URL('../fixtures/sync/sync-test.txt', import.meta.url), 'utf8'));
    expect(notes(s)[0].start).toBeCloseTo(20, 6);
  });
});

describe('octave normalisation', () => {
  it('leaves normal files (pitch 0 = C4) as written', () => {
    expect(notes(song(': 0 4 0 a\n: 4 4 7 b')).map(n => n.midi)).toEqual([60, 67]);
  });

  it('fixes files written in absolute MIDI numbers', () => {
    // 52..69 = E3..A4 written as MIDI numbers; must not end up at E8..A9
    const n = notes(song(': 0 4 52 a\n: 4 4 61 b\n: 8 4 69 c'));
    expect(n.map(x => x.midi)).toEqual([52, 61, 69]);
  });
});
