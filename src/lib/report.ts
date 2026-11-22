import { letter } from './notes';
import { mean, med, type NoteResult } from './analysis';
import type { Session } from './history';

const nm = (m: number) => letter(m, true);
const fc = (c: number) => (c > 0 ? '+' : '') + c + 'c';
const pct = (x: number | null) => (x == null || isNaN(x) ? '–' : Math.round(x) + '%');
const r1 = (x: number) => Math.round(x);
const mmss = (s: number | null | undefined) => {
  if (s == null) return '';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const localTime = (iso: string) => {
  const d = new Date(iso), p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const MODE_TXT: Record<string, string> = {
  echo: 'hears the pattern first, then sings it back',
  along: 'sings along while the reference plays',
  cue: 'hears only the first note, then sings the rest',
};

function moveCat(iv: number | null) {
  if (iv == null) return 'First note of pattern/phrase';
  const a = Math.abs(iv), d = iv > 0 ? ' up' : ' down';
  if (a === 0) return 'Repeated note';
  return (a <= 2 ? 'Step (2nd)' : a <= 4 ? 'Skip (3rd)' : a <= 7 ? 'Leap (4th–5th)' : 'Big leap (6th+)') + d;
}
const ORDER = ['First note of pattern/phrase', 'Repeated note', 'Step (2nd) up', 'Step (2nd) down', 'Skip (3rd) up', 'Skip (3rd) down',
  'Leap (4th–5th) up', 'Leap (4th–5th) down', 'Big leap (6th+) up', 'Big leap (6th+) down'];

function aggLine(label: string, ns: NoteResult[]) {
  if (!ns.length) return null;
  const sung = ns.filter(n => n.sung);
  return `- ${label}: ${ns.length} notes · in tune ${pct(mean(ns.map(n => n.score)))} · avg error ${sung.length ? fc(r1(mean(sung.map(n => n.cents!)))) : '–'} (typical miss ${sung.length ? r1(mean(sung.map(n => Math.abs(n.cents!)))) + 'c' : '–'})`;
}

function noteText(x: NoteResult) {
  if (!x.sung) return `${nm(x.m)}: not sung / not detected`;
  const p = [`${nm(x.m)} ${fc(x.cents!)}`, `${x.score}% in tune`];
  if (x.oct) p.push(`sang ${Math.abs(x.oct)} octave${Math.abs(x.oct) > 1 ? 's' : ''} ${x.oct > 0 ? 'higher' : 'lower'}`);
  if ((x.start ?? 0) >= 0.3) p.push(`came in ${x.start}s late`);
  if (Math.abs(x.onset ?? 0) >= 40) p.push(`started ${fc(x.onset!)}`);
  p.push(x.settle == null ? 'never settled' : `settled after ${x.settle}s`);
  if (x.drift != null && Math.abs(x.drift) >= 15) p.push(`drifted ${fc(x.drift)}`);
  if (x.vib) p.push(`vibrato ~${x.vib}Hz ±${x.wobble}c`);
  else if ((x.wobble ?? 0) >= 20) p.push(`unsteady ±${x.wobble}c`);
  return p.join(', ');
}

export function buildReport(sessions: Session[], detail: boolean): string {
  if (!sessions.length) return 'No sessions recorded yet. Finish at least one exercise round or sing part of a song first.';
  const last = sessions[sessions.length - 1];
  const L: string[] = [];
  const all: (NoteResult & { lo: number; hi: number })[] = [];
  sessions.forEach(se => se.rounds.forEach(r => r.notes.forEach(n => all.push({ ...n, lo: se.lo, hi: se.hi }))));
  const sung = all.filter(n => n.sung);
  const hasKaraoke = sessions.some(s => s.kind === 'karaoke');
  const anyRec = sessions.some(s => s.rec);

  L.push('# Singing pitch analysis', '');
  L.push(`I'm training my singing pitch accuracy with an app that listens through my microphone and measures how accurately I sing each target note${hasKaraoke ? ' (in ear-training exercises and/or while singing along to songs karaoke-style)' : ''}. Please analyse these measurements like a voice teacher: find my consistent habits (e.g. going flat or sharp in certain parts of my range, on certain intervals or directions, how I start notes, whether I hold them steadily), explain what is likely causing them, and give me a short prioritised practice plan with specific exercises. Point out what I'm doing well too.${anyRec ? ' If you can listen to audio, my voice recording is attached as well; the timestamps below show where each part starts in it.' : ''}`);
  L.push('');
  L.push('How to read the numbers: 100 cents (c) = 1 semitone. + means sharp (too high), − means flat (too low). Error = my median pitch on the held part of the note. "In tune" = % of the note\'s time within the tolerance. "Started" = where my pitch was in the first 0.15s (scoops). "Settled" = seconds until I stayed in tune. "Drifted" = change from the start to the end of the held note. "Unsteady" = pitch spread (standard deviation).');
  if (hasKaraoke) L.push('Karaoke sessions use octave-free scoring: singing the right note in a different octave counts, and is listed as "sang 1 octave lower/higher".');
  L.push('', '## Setup');
  L.push(`- Vocal range set in app: ${nm(last.lo)}–${nm(last.hi)}`);
  L.push(`- In-tune tolerance: ±${last.tol} cents`);
  const tr = [...sessions].reverse().find(s => s.kind === 'trainer');
  if (tr) L.push(`- Exercise mode: the singer ${MODE_TXT[tr.mode ?? 'echo'] ?? tr.mode}${tr.wait ? ' (app waits on each note until it is hit)' : ''}; tempo ${tr.tempo} BPM`);
  L.push(`- Sessions included: ${sessions.length} (${localTime(sessions[0].date).slice(0, 10)} to ${localTime(last.date).slice(0, 10)}), ${all.length} target notes`);

  L.push('', '## Overall');
  L.push(`- Average in-tune: ${pct(mean(all.map(n => n.score)))}`);
  if (sung.length) {
    L.push(`- Average error: ${fc(r1(mean(sung.map(n => n.cents!))))} (median of notes: ${fc(r1(med(sung.map(n => n.cents!))))}); typical size of miss: ${r1(mean(sung.map(n => Math.abs(n.cents!))))}c`);
    L.push(`- Notes sung flat by >${last.tol}c: ${pct((100 * sung.filter(n => n.cents! < -last.tol).length) / sung.length)} · sharp by >${last.tol}c: ${pct((100 * sung.filter(n => n.cents! > last.tol).length) / sung.length)}`);
  }
  const oct = sung.filter(n => n.oct).length, miss = all.length - sung.length;
  if (oct) L.push(`- Notes sung in a different octave: ${oct}`);
  if (miss) L.push(`- Notes not sung or not detected: ${miss}`);

  L.push('', '## By part of my range');
  const reg = (n: { m: number; lo: number; hi: number }) => { const span = n.hi - n.lo; return n.m < n.lo + span / 3 ? 0 : n.m < n.lo + (2 * span) / 3 ? 1 : 2; };
  ['Low third', 'Middle third', 'High third'].forEach((lab, i) => { const l = aggLine(lab, all.filter(n => reg(n) === i)); if (l) L.push(l); });
  const above = all.filter(n => n.m > n.hi), below = all.filter(n => n.m < n.lo);
  if (above.length) L.push(aggLine('Above my set range', above)!);
  if (below.length) L.push(aggLine('Below my set range', below)!);

  L.push('', '## By melodic movement (how the note was approached)');
  const cats: Record<string, NoteResult[]> = {};
  all.forEach(n => { (cats[moveCat(n.iv)] ||= []).push(n); });
  ORDER.forEach(k => { if (cats[k]) { const l = aggLine(k, cats[k]); if (l) L.push(l); } });

  if (sung.length) {
    L.push('', '## Starting notes');
    const st = sung.filter(n => n.settle != null);
    L.push(`- Scooped up from below (started >40c flat): ${pct((100 * sung.filter(n => n.onset! < -40).length) / sung.length)} of notes`);
    L.push(`- Came down from above (started >40c sharp): ${pct((100 * sung.filter(n => n.onset! > 40).length) / sung.length)} of notes`);
    L.push(`- Average time to settle in tune: ${st.length ? mean(st.map(n => n.settle!)).toFixed(2) + 's' : '–'}; never settled: ${pct((100 * (sung.length - st.length)) / sung.length)} of notes`);
    L.push('', '## Holding notes');
    const dr = sung.filter(n => n.drift != null);
    if (dr.length) L.push(`- Average drift over a held note (${dr.length} notes long enough to measure): ${fc(r1(mean(dr.map(n => n.drift!))))}; drifted flat >15c: ${pct((100 * dr.filter(n => n.drift! < -15).length) / dr.length)}, sharp >15c: ${pct((100 * dr.filter(n => n.drift! > 15).length) / dr.length)}`);
    else L.push('- Drift: notes were too short to measure (needs notes held ~0.6s+)');
    L.push(`- Average pitch spread while holding: ±${r1(mean(sung.map(n => n.wobble!)))}c`);
    const lg = sung.filter(n => (n.held ?? 0) >= 0.8);
    L.push(lg.length ? `- Vibrato detected on ${pct((100 * lg.filter(n => n.vib).length) / lg.length)} of the ${lg.length} notes long enough to measure` : '- Vibrato: notes were too short to measure (needs ~0.8s+)');

    L.push('', '## Target notes I found hardest (min. 2 attempts)');
    const by: Record<number, NoteResult[]> = {};
    sung.forEach(n => { (by[n.m] ||= []).push(n); });
    const hard = Object.entries(by).filter(([, v]) => v.length >= 2)
      .map(([m, v]) => ({ m: +m, n: v.length, e: mean(v.map(x => x.cents!)), a: mean(v.map(x => Math.abs(x.cents!))), s: mean(v.map(x => x.score)) }))
      .sort((a, b) => b.a - a.a).slice(0, 6);
    hard.forEach(h => L.push(`- ${nm(h.m)}: ${h.n} attempts, avg error ${fc(r1(h.e))}, in tune ${pct(h.s)}`));
    if (!hard.length) L.push('- (not enough repeats yet)');
  }

  if (sessions.length > 1) {
    L.push('', '## Sessions over time');
    sessions.forEach(se => {
      const ns = se.rounds.flatMap(r => r.notes).filter(n => n.sung);
      L.push(`- ${localTime(se.date)} · ${se.kind === 'karaoke' ? 'Karaoke: ' : ''}${se.title}${se.partial ? ' (stopped early)' : ''} · ${se.rounds.length} ${se.kind === 'karaoke' ? 'lines' : 'rounds'} · in tune ${se.avg}% · typical miss ${ns.length ? r1(mean(ns.map(n => Math.abs(n.cents!)))) + 'c' : '–'}`);
    });
  }

  if (detail) {
    sessions.forEach(se => {
      L.push('', `## Note by note: ${se.kind === 'karaoke' ? 'Karaoke: ' : ''}${se.title} (${localTime(se.date)})${se.rec ? ' · recording: ' + se.rec : ''}`);
      se.rounds.forEach((r, i) => {
        const where = [r.songTime != null ? `${mmss(r.songTime)} in song` : '', r.rec != null ? `${mmss(r.rec)} in recording` : ''].filter(Boolean).join(', ');
        L.push(`${i + 1}. ${r.label}${where ? ` [${where}]` : ''} - ${r.score}%`);
        r.notes.forEach(n => L.push(`   - ${noteText(n)}`));
      });
    });
  }
  return L.join('\n');
}
