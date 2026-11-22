// Generates the synthetic UltraStar song used by the audio-sync regression test (8 minutes):
//   sync-test.txt  – notes at exactly known times
//   sync-test.mp3  – matching tones, encoded as VBR MP3 (with a Xing seek table)
//
// Why this shape: browsers seek MP3s using the coarse Xing table and then report the time that was
// asked for, not where playback actually landed. The error grows with file length and with uneven
// bitrate, so the song is long with three short melodies separated by silence (silence
// encodes to tiny frames, which makes the bitrate very uneven). Without the fix this file seeks
// ~0.2–0.5 s wrong in Chrome (either direction); with it, within a few hundredths of a second.
//
// Run: node tests/fixtures/sync/make-fixture.mjs   (needs ffmpeg with libmp3lame on PATH)
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SR = 22050, DURATION = 480, BPM = 300, BEAT = 60 / (BPM * 4); // 0.05 s per beat
export const SEGMENTS = [[20, 50], [210, 240], [420, 450]]; // seconds with melody

// deterministic pseudo-random melody
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const notes = []; // { beat, len, pitch } — pitch 0 = C4
const lines = [];
for (const [a, b] of SEGMENTS) {
  let beat = Math.round(a / BEAT);
  const end = Math.round(b / BEAT);
  let inLine = 0;
  while (beat + 8 <= end) {
    const len = 6 + Math.floor(rnd() * 6); // 0.3–0.55 s
    const pitch = Math.floor(rnd() * 13);  // C4..C5
    notes.push({ beat, len, pitch });
    beat += len + 2;
    if (++inLine === 8) { lines.push(beat - 1); inLine = 0; }
  }
  lines.push(beat + 4);
}

// audio: harmonic tone per note, short fades, digital silence elsewhere
const pcm = new Float32Array(SR * DURATION);
for (const n of notes) {
  const f = 440 * 2 ** ((n.pitch + 60 - 69) / 12);
  const s0 = Math.round(n.beat * BEAT * SR), s1 = Math.round((n.beat + n.len) * BEAT * SR);
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR, env = Math.min(1, t / 0.01, (s1 - i) / SR / 0.01);
    pcm[i] = env * 0.3 * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t));
  }
}
const wav = Buffer.alloc(44 + pcm.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
const tmp = join(here, 'tmp.wav');
writeFileSync(tmp, wav);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-codec:a', 'libmp3lame', '-q:a', '6', join(here, 'sync-test.mp3')]);
unlinkSync(tmp);

// UltraStar txt
const out = ['#TITLE:Sync Test', '#ARTIST:Test Fixture', '#MP3:sync-test.mp3', `#BPM:${BPM}`, '#GAP:0'];
let li = 0;
for (const n of notes) {
  while (li < lines.length && lines[li] < n.beat) out.push(`- ${lines[li++]}`);
  out.push(`: ${n.beat} ${n.len} ${n.pitch} la`);
}
out.push('E');
writeFileSync(join(here, 'sync-test.txt'), out.join('\n') + '\n');
console.log(`wrote ${notes.length} notes, ${lines.length} lines`);
