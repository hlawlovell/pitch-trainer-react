/**
 * UltraStar Deluxe .txt parser.
 * Format: header tags (#TITLE:, #BPM:, #GAP: …) then note lines:
 *   ": beat length pitch text"  normal     "* …" golden     "F …" freestyle
 *   "R …" rap      "G …" golden rap     "- beat [beat2]" line break     "E" end
 *   "P1" / "P2" (duet tracks). Pitch 0 = C4 (MIDI 60). Time = GAP + beat × 60 / (BPM × 4).
 */
export type NoteType = 'normal' | 'golden' | 'free' | 'rap' | 'rapgolden';

export interface UNote {
  type: NoteType; beat: number; len: number; pitch: number; text: string;
  start: number; end: number;   // seconds in the song
  midi: number;                 // pitch + 60 (written octave)
}
export interface ULine { start: number; end: number; notes: UNote[] }
export interface UTrack { name: string; lines: ULine[] }
export interface USong {
  title: string; artist: string; bpm: number; gap: number;
  videoGap: number; startSec: number; endSec: number | null;
  mp3?: string; video?: string; cover?: string; background?: string;
  language?: string; year?: string;
  tracks: UTrack[];
  tags: Record<string, string>;
}

const TYPE: Record<string, NoteType> = { ':': 'normal', '*': 'golden', F: 'free', R: 'rap', G: 'rapgolden' };
const num = (s: string | undefined) => (s == null ? NaN : parseFloat(s.trim().replace(',', '.')));

export function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function parseUltrastar(text: string): USong {
  const tags: Record<string, string> = {};
  const rawTracks: Record<string, { lines: { notes: Omit<UNote, 'start' | 'end' | 'midi'>[] }[] }> = {};
  let cur = 'P1';
  const track = () => (rawTracks[cur] ||= { lines: [{ notes: [] }] });
  let relOffset = 0;
  const lines = text.split(/\r?\n/);
  let relative = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const i = line.indexOf(':');
      if (i > 0) {
        const k = line.slice(1, i).trim().toUpperCase();
        tags[k] = line.slice(i + 1).trim();
        if (k === 'RELATIVE') relative = /^y/i.test(tags[k]);
      }
      continue;
    }
    const c = line.trimStart()[0];
    const body = line.trimStart().slice(1);
    if (c === 'E') break;
    if (c === 'P') {
      const n = body.trim();
      cur = n === '3' ? 'P1' : 'P' + (n || '1');
      track();
      relOffset = 0;
      continue;
    }
    if (c === '-') {
      const p = body.trim().split(/\s+/).map(Number);
      const t = track();
      if (t.lines[t.lines.length - 1].notes.length) t.lines.push({ notes: [] });
      if (relative) relOffset += isNaN(p[1]) ? p[0] || 0 : p[1];
      continue;
    }
    const type = TYPE[c];
    if (!type) continue;
    // ": beat len pitch text" — text keeps its leading space (word boundary)
    const m = body.match(/^\s*(-?\d+)\s+(\d+)\s+(-?\d+)\s?(.*)$/);
    if (!m) continue;
    const t = track();
    t.lines[t.lines.length - 1].notes.push({
      type, beat: +m[1] + (relative ? relOffset : 0), len: +m[2], pitch: +m[3], text: m[4] ?? '',
    });
  }

  const bpm = num(tags.BPM) || 120;
  const gap = num(tags.GAP) || 0;
  const spb = 60 / (bpm * 4);
  const toSec = (beat: number) => gap / 1000 + beat * spb;

  const tracks: UTrack[] = Object.entries(rawTracks).map(([name, t]) => {
    // UltraStar pitch 0 = C4, but some files store absolute MIDI numbers (64 = E4), which would land
    // several octaves too high. Shift whole octaves so the track's median sits in a vocal range (C2–C5);
    // for absolute-MIDI files this recovers the true pitches exactly (shift of −60).
    const ps = t.lines.flatMap(l => l.notes).filter(n => n.type !== 'free').map(n => n.pitch).sort((a, b) => a - b);
    let oct = 0;
    if (ps.length) {
      const med = ps[ps.length >> 1];
      while (med + oct > 12) oct -= 12;
      while (med + oct < -24) oct += 12;
    }
    return {
      name: tags['DUETSINGER' + name] || tags[name] || (Object.keys(rawTracks).length > 1 ? `Singer ${name.slice(1)}` : 'Vocals'),
      lines: t.lines.filter(l => l.notes.length).map(l => {
        const notes: UNote[] = l.notes.map(n => ({ ...n, start: toSec(n.beat), end: toSec(n.beat + Math.max(1, n.len)), midi: n.pitch + 60 + oct }));
        return { start: notes[0].start, end: notes[notes.length - 1].end, notes };
      }),
    };
  });
  if (!tracks.length) tracks.push({ name: 'Vocals', lines: [] });

  const endMs = num(tags.END);
  return {
    title: tags.TITLE || 'Untitled', artist: tags.ARTIST || 'Unknown artist', bpm, gap,
    videoGap: num(tags.VIDEOGAP) || 0, startSec: num(tags.START) || 0, endSec: isNaN(endMs) ? null : endMs / 1000,
    mp3: tags.AUDIO || tags.MP3, video: tags.VIDEO, cover: tags.COVER, background: tags.BACKGROUND,
    language: tags.LANGUAGE, year: tags.YEAR, tracks, tags,
  };
}

/** Choose an octave shift (multiple of 12) that puts the most notes inside the singer's range. */
export function bestOctaveShift(notes: { midi: number }[], lo: number, hi: number): number {
  if (!notes.length) return 0;
  let best = 0, bestScore = -Infinity;
  const mid = (lo + hi) / 2;
  const ms = notes.map(n => n.midi).sort((a, b) => a - b);
  const median = ms[ms.length >> 1];
  for (let k = -3; k <= 2; k++) {
    const sh = k * 12;
    const inside = notes.filter(n => n.midi + sh >= lo && n.midi + sh <= hi).length;
    const score = inside * 100 - Math.abs(median + sh - mid);
    if (score > bestScore) { bestScore = score; best = sh; }
  }
  return best;
}
