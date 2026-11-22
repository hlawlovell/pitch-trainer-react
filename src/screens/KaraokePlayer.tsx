import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Roll, { type RollNote, type Scene, type ScrubPhase, type TraceClass, type TracePoint } from '../components/Roll';
import Readout from '../components/Readout';
import { pianoTarget } from '../components/TopPiano';
import { Results, saveRecording, toast } from '../components/ui';
import { ensureAudio, live, onFrame, playNote, stopAll } from '../audio/engine';
import { pauseRecording, recTime, stamp, startRecording, stopRecording, isRecording } from '../audio/recorder';
import { analyzeNote, resetScore, shownScore, step, type NoteMeasure, type NoteResult } from '../lib/analysis';
import { addSession, type RoundLog, type Session } from '../lib/history';
import { fmtTime } from '../lib/notes';
import { getS, setS, useSettings } from '../lib/settings';
import { bestOctaveShift, type UNote } from '../lib/ultrastar';
import type { SongEntry } from '../lib/library';
import { scoreColor } from '../lib/exercises';
import { claimSpace, isControl, isTyping } from '../lib/keys';
import { lsGet, lsSet } from '../lib/storage';
import { seekableAudio } from '../audio/seekable';
import { hasHan, usePinyin } from '../lib/pinyin';

const SPEEDS = [0.5, 0.6, 0.75, 0.9, 1];

interface KNote extends NoteMeasure {
  u: UNote; midi: number; start: number; end: number; line: number; idx: number;
  kind: RollNote['kind']; obs: number; finalized: boolean; score: number | null; result: NoteResult | null; fired: boolean; cents: number | null;
  /** Perform mode: stretches sung in tune [from, to] (fill the note bar), and off-pitch [from, to, sung midi]. */
  hits: [number, number][]; misses: [number, number, number][];
}

/** Extend the last stretch if it continues from the previous frame (same pitch), else start a new one. */
function extendSeg<T extends [number, number, ...number[]]>(segs: T[], from: number, to: number, make: () => T, same: (s: T) => boolean) {
  const last = segs[segs.length - 1];
  if (last && same(last) && last[1] >= from - 0.05) last[1] = to;
  else segs.push(make());
}
interface KLine { start: number; end: number; first: number; last: number; text: string; done: boolean; recMark: number | null }
interface LineScore { last: number; best: number; tries: number }

// vertical view: fixed height (semitones), notes kept at least EDGE semitones from the top/bottom
// (kept small so the note bars are tall; the view pans to follow the melody). The height fits 90 % of the
// song's on-screen stretches; in the rare wider stretch the view follows the nearest notes instead.
const MIN_SPAN = 10, MAX_SPAN = 16, EDGE = 1, FIT_SHARE = 0.9;
// pitch range of sung notes near time t (a little behind, `ahead` seconds ahead – about what's on screen)
function windowRange(notes: { start: number; end: number; midi: number; kind: RollNote['kind'] }[], t: number, ahead = 3) {
  let lo = Infinity, hi = -Infinity;
  for (const n of notes) {
    if (n.start > t + ahead) break;
    if (n.end < t - 0.5 || n.kind === 'free') continue;
    lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi);
  }
  return isFinite(lo) ? { lo, hi } : null;
}

/** The sung (non-freestyle) note at time t, if any. Notes are sorted by start. */
function nowNote<N extends { start: number; end: number; kind: RollNote['kind'] }>(notes: N[], t: number): N | null {
  for (const n of notes) { if (n.start > t) break; if (t < n.end && n.kind !== 'free') return n; }
  return null;
}

const kindOf =(u: UNote): RollNote['kind'] => (u.type === 'golden' || u.type === 'rapgolden' ? 'golden' : u.type === 'free' ? 'free' : u.type === 'rap' ? 'rap' : 'sing');

export default function KaraokePlayer({ entry, onExit }: { entry: SongEntry; onExit: () => void }) {
  const S = useSettings();
  const song = entry.song;
  const [trackIdx, setTrackIdx] = useState(0);
  const [mode, setMode] = useState<'practice' | 'perform'>('practice');
  const [started, setStarted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [octChoice, setOctChoice] = useState<'auto' | number>('auto');
  const [speed, setSpeed] = useState(1);
  const [ui, setUi] = useState({ t: 0, playing: false, line: 0, dur: 0 });
  const [loop, setLoopState] = useState<{ a: number; b: number; from: number; to: number } | null>(null);
  const [lineScores, setLineScores] = useState<Record<number, LineScore>>({});
  const [summary, setSummary] = useState<{ scores: number[]; session: Session | null } | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoUrl = useMemo(() => (entry.video ? URL.createObjectURL(entry.video) : null), [entry]);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  // MP3s are decoded to WAV first so seeking is exact (see audio/seekable.ts); takes a moment on open
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!entry.audio) return;
    let alive = true, url: string | null = null;
    seekableAudio(entry.audio, entry.audioName).then(b => { if (alive) { url = URL.createObjectURL(b); setAudioUrl(url); } });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); setAudioUrl(null); };
  }, [entry]);
  const audioReady = !entry.audio || !!audioUrl;
  const urls = { audio: audioUrl, video: videoUrl };
  const videoIsMaster = !entry.audio && !!videoUrl;

  const track = song.tracks[Math.min(trackIdx, song.tracks.length - 1)];
  // pinyin under Chinese lyrics: one string per lyric line, the same text the lyric display shows
  const lineTexts = useMemo(() => track.lines.map(l => l.notes.map(n => n.text.replace(/~/g, '')).join('')), [track]);
  const pinyin = usePinyin(lineTexts, S.kPinyin);
  const autoShift = useMemo(() => bestOctaveShift(track.lines.flatMap(l => l.notes), S.lo, S.hi), [track, S.lo, S.hi]);
  const shift = octChoice === 'auto' ? autoShift : octChoice;

  const K = useRef({
    notes: [] as KNote[], lines: [] as KLine[], trace: [] as TracePoint[], active: null as KNote | null, cls: 'none' as TraceClass,
    lastSongT: 0, viewLo: 55, viewHi: 70, span: 15, targetLo: 55, traceStale: false, sync: 0, perform: false, dotMidi: null as number | null, loop: null as typeof loop, attempts: [] as RoundLog[],
    startedAt: new Date(), recName: null as string | null, ended: false, saved: false, uiAt: 0,
  });

  // build note model when track changes
  useEffect(() => {
    const k = K.current;
    const notes: KNote[] = [], lines: KLine[] = [];
    track.lines.forEach((l, li) => {
      const first = notes.length;
      l.notes.forEach(u => notes.push({
        u, midi: u.midi, start: u.start, end: u.end, line: li, idx: notes.length, kind: kindOf(u),
        hit: 0, total: 0, frames: 0, samples: [], obs: 0, hits: [], misses: [], finalized: false, score: null, result: null, fired: false, cents: null,
      }));
      lines.push({ start: l.start, end: l.end, first, last: notes.length - 1, text: l.notes.map(n => n.text).join('').replace(/~/g, '').trim(), done: false, recMark: null });
    });
    k.notes = notes; k.lines = lines; k.trace = []; k.active = null;
    // one fixed view height for the whole song: big enough for most stretches of nearby notes
    const sung = notes.filter(n => n.kind !== 'free');
    const ranges = sung.map(n => { const r = windowRange(sung, n.start + 0.5); return r ? r.hi - r.lo : 0; }).sort((a, b) => a - b);
    const fit = ranges.length ? ranges[Math.min(ranges.length - 1, Math.floor(ranges.length * FIT_SHARE))] : 0;
    k.span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, fit + 2 * EDGE + 1));
    setLineScores({});
  }, [track]);

  // per-song sync offset (ms, + = notes earlier): fixes song files whose timing doesn't match the audio
  const syncKey = `${song.artist}|${song.title}`;
  const [syncMs, setSyncMs] = useState<number>(() => lsGet<Record<string, number>>('pt_sync', {})[syncKey] ?? 0);
  useEffect(() => {
    K.current.sync = syncMs / 1000;
    const all = lsGet<Record<string, number>>('pt_sync', {});
    if (syncMs) all[syncKey] = syncMs; else delete all[syncKey];
    lsSet('pt_sync', all);
  }, [syncMs, syncKey]);

  // apply octave shift (and recentre the view on the opening notes)
  useEffect(() => {
    const k = K.current;
    k.notes.forEach(n => (n.midi = n.u.midi + shift));
    const ms = k.notes.filter(n => n.kind !== 'free').slice(0, 20).map(n => n.midi);
    if (ms.length) {
      k.targetLo = k.viewLo = (Math.min(...ms) + Math.max(...ms)) / 2 - k.span / 2;
      k.viewHi = k.viewLo + k.span;
    }
  }, [shift, track]);

  const media = () => (videoIsMaster ? videoRef.current : audioRef.current);

  /* ---------- seeking & loop ---------- */
  const resetFrom = (tEval: number, songT: number) => {
    const k = K.current;
    for (const n of k.notes) {
      if (n.end > tEval) { resetScore(n); n.hits = []; n.misses = []; n.frames = 0; n.samples = []; n.obs = 0; n.finalized = false; n.score = null; n.result = null; }
      if (n.start >= songT) n.fired = false;
    }
    for (const l of k.lines) if (l.end > tEval) { l.done = false; l.recMark = null; }
    // keep the sung pitch on screen while paused (e.g. scrubbing back to look at it); clear it on play
    if (media()?.paused) k.traceStale = true; else k.trace = [];
    k.active = null;
    stopAll();
  };
  /** Position in the song's note timeline (= audio time + this song's sync offset). */
  const songNow = () => { const m = media(); return m ? m.currentTime + K.current.sync : 0; };
  /** Seek to a time on the song's note timeline. */
  const seek = (t: number) => {
    const m = media();
    if (!m) return;
    const dur = isFinite(m.duration) ? m.duration : Infinity;
    m.currentTime = Math.max(0, Math.min(dur - 0.05, t - K.current.sync));
  };
  const setLoop = (l: typeof loop) => { K.current.loop = l; setLoopState(l); };
  const loopLines = (from: number, to: number) => {
    const k = K.current, a = Math.min(from, to), b = Math.max(from, to);
    setLoop({ a: k.lines[a].start, b: k.lines[b].end + 0.3, from: a, to: b });
    seek(k.lines[a].start - 1);
  };

  /* ---------- saving ---------- */
  const save = (partial: boolean): Session | null => {
    const k = K.current;
    if (k.saved || !k.attempts.length) return null;
    k.saved = true;
    const sc = k.attempts.map(a => a.score);
    const s: Session = {
      date: k.startedAt.toISOString(), kind: 'karaoke', title: `${song.artist} – ${song.title}`, partial, octaveFree: getS().kAnyOctave,
      tol: getS().tol, lo: getS().lo, hi: getS().hi, avg: Math.round(sc.reduce((a, b) => a + b, 0) / sc.length), rec: k.recName, rounds: k.attempts,
    };
    addSession(s);
    return s;
  };
  const finish = () => {
    const k = K.current;
    media()?.pause();
    stopRecording();
    k.ended = true;
    const sess = save(false);
    setSummary({ scores: k.attempts.map(a => a.score / 100), session: sess });
  };

  useEffect(() => () => {
    const k = K.current;
    if (!k.ended) { save(true); stopRecording(); }
    stopAll();
    pianoTarget.midi = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- per-frame engine ---------- */
  useEffect(() => onFrame(dt => {
    const k = K.current, m = media();
    if (!m) return;
    const Sx = getS();
    const songT = m.currentTime + k.sync;
    const lat = Sx.kLatencyMs / 1000;
    const tEval = songT - lat;
    const playing = !m.paused && !m.ended;
    const dSong = songT - k.lastSongT;
    if (dSong < -0.05 || dSong > 0.6) resetFrom(tEval, songT);
    const prevSong = k.lastSongT;
    k.lastSongT = songT;

    // A-B loop
    if (k.loop && playing && songT >= k.loop.b) { seek(Math.max(0, k.loop.a - 0.8)); return; }

    // background video sync
    const v = videoRef.current;
    if (v && !videoIsMaster && v.readyState >= 1) {
      const vt = m.currentTime + song.videoGap; // video follows the audio, not the note timeline
      if (vt < 0) { if (!v.paused) v.pause(); }
      else {
        if (Math.abs(v.currentTime - vt) > 0.3) v.currentTime = vt;
        v.playbackRate = m.playbackRate;
        if (playing && v.paused) v.play().catch(() => {});
        if (!playing && !v.paused) v.pause();
      }
    }

    // find the active note (at mic-latency-compensated time)
    let active: KNote | null = null;
    for (const n of k.notes) { if (n.start > tEval) break; if (tEval < n.end && n.kind !== 'free') { active = n; break; } }
    k.active = active;
    const shown = nowNote(k.notes, songT); // what to sing now, in time with the music
    pianoTarget.midi = shown ? shown.midi : null;

    const pitch = live.pitch;
    const advancing = playing && dSong > 0 && dSong <= 0.6;
    let cls: TraceClass = 'none';
    k.dotMidi = live.shown != null ? Math.round(live.shown) : null; // between notes: nearest semitone
    if (active) {
      active.cents = null;
      let c: number | null = null;
      if (pitch != null) {
        c = (pitch - active.midi) * 100;
        if (Sx.kAnyOctave) c = (((c % 1200) + 1800) % 1200) - 600;
        active.cents = c;
      }
      const isRap = active.u.type === 'rap' || active.u.type === 'rapgolden';
      // score this frame; the judged error (smoothed in v2) also colours the trace
      const judged = advancing
        ? step(active, { t: tEval - active.start, dur: active.end - active.start, d: dSong, cents: c, tol: Sx.tol, slide: Sx.slideMs / 1000, v: Sx.scoring, anyPitch: isRap })
        : c;
      if (judged != null) { const a = Math.abs(judged); cls = isRap || a <= Sx.tol ? 'good' : a <= 100 ? 'warn' : 'bad'; }
      // Perform mode's pitch dot sits exactly where the bar is drawn: on the note when in tune, else on the sung semitone
      k.dotMidi = judged == null ? null : cls === 'good' ? active.midi : active.midi + Math.round(judged / 100);
      // UltraStar-style bars (shown in Perform mode): in tune fills the note, off pitch draws a small bar where you sang
      if (advancing && judged != null) {
        const from = Math.max(active.start, tEval - dSong), to = Math.min(active.end, tEval);
        if (to > from) {
          if (cls === 'good') extendSeg(active.hits, from, to, () => [from, to], () => true);
          else {
            const sung = active.midi + Math.round(judged / 100);
            extendSeg(active.misses, from, to, () => [from, to, sung], s => s[2] === sung);
          }
        }
      }
    }
    k.cls = cls;

    if (advancing) {
      if (active) {
        active.obs += dSong;
        active.frames++;
        if (pitch != null) active.samples.push([tEval - active.start, (pitch - active.midi) * 100]);
      }
      k.trace.push({ t: tEval, m: pitch, c: cls });
      if (k.trace.length > 4000) k.trace.splice(0, 1000);

      // line start marks (for the recording timestamps)
      for (const l of k.lines) if (l.recMark == null && tEval >= l.start && tEval < l.end) l.recMark = recTime();

      // finalize notes we've passed
      for (const n of k.notes) {
        if (n.start > tEval) break;
        if (n.finalized || n.end > tEval) continue;
        n.finalized = true;
        if (n.kind === 'free' || n.obs < 0.6 * (n.end - n.start)) continue;
        // very short pickup notes (< ~0.2 s) can't be measured reliably: skip unless clearly sung
        if (n.end - n.start < 0.2 && n.samples.length < 6) continue;
        n.score = shownScore(n, Sx.scoreCurve);
        const prev = n.idx > 0 && k.notes[n.idx - 1].line === n.line ? k.notes[n.idx - 1].midi : null;
        n.result = analyzeNote(n, Sx.tol, n.midi, prev == null ? null : n.midi - prev);
      }
      // completed lines
      k.lines.forEach((l, li) => {
        if (l.done || l.end > tEval) return;
        l.done = true;
        const ns = k.notes.slice(l.first, l.last + 1).filter(n => n.result);
        if (!ns.length) return;
        const w = (n: KNote) => (n.kind === 'golden' ? 2 : 1) * (n.end - n.start);
        const score = ns.reduce((a, n) => a + n.score! * w(n), 0) / ns.reduce((a, n) => a + w(n), 0);
        k.attempts.push({ label: `Line ${li + 1}`, score: Math.round(score * 100), rec: l.recMark, songTime: +l.start.toFixed(1), notes: ns.map(n => n.result!) });
        setLineScores(cur => {
          const p = cur[li];
          return { ...cur, [li]: { last: score, best: Math.max(score, p?.best ?? 0), tries: (p?.tries ?? 0) + 1 } };
        });
      });

      // guide melody on the piano
      if (Sx.kGuide) {
        for (const n of k.notes) {
          if (n.start > songT) break;
          if (n.fired || n.kind === 'free' || n.start <= prevSong - 0.05) continue;
          n.fired = true;
          playNote(n.midi, Math.max(0.12, (n.end - n.start) / m.playbackRate), Sx.kGuideVol);
        }
      }
    }

    // vertical follow: fixed height, pan only as much as needed to keep nearby notes on screen.
    // If the next 3 s don't fit, keep the next ~1.2 s on screen; failing that, the current/next note.
    const room = k.span - 2 * EDGE;
    let r = windowRange(k.notes, tEval);
    if (r && r.hi - r.lo > room) r = windowRange(k.notes, tEval, 1.2);
    if (r && r.hi - r.lo > room) { const n = k.notes.find(q => q.kind !== 'free' && q.end > tEval); if (n) r = { lo: n.midi, hi: n.midi }; }
    if (r) {
      let tl = k.targetLo;
      if (r.hi > tl + k.span - EDGE) tl = r.hi + EDGE - k.span;
      if (r.lo < tl + EDGE) tl = r.lo - EDGE;
      k.targetLo = tl;
    }
    k.viewLo += (k.targetLo - k.viewLo) * Math.min(1, dt * 2.5);
    k.viewHi = k.viewLo + k.span;

    // UI refresh ~12 fps
    const now = performance.now();
    if (now - k.uiAt > 80) {
      k.uiAt = now;
      // a line stays up until shortly after it ends, but never once the next line has started
      let line = k.lines.findIndex(l => l.end + 0.4 > songT);
      if (line < 0) line = k.lines.length - 1;
      while (line + 1 < k.lines.length && k.lines[line + 1].start <= songT + 0.05) line++;
      const dur = isFinite(m.duration) ? m.duration : (k.lines.at(-1)?.end ?? 0) + 5;
      setUi(u => (Math.abs(u.t - songT) > 0.05 || u.playing !== playing || u.line !== line || u.dur !== dur ? { t: songT, playing, line, dur } : u));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [videoIsMaster, song.videoGap]);

  const getScene = useCallback((): Scene | null => {
    const k = K.current, m = media();
    if (!m) return null;
    // notes scroll in sync with the music; your pitch (heard `lag` late) is drawn where it was sung,
    // just left of the playhead (trace points are already stamped with latency-corrected times)
    const songT = m.currentTime + k.sync, lag = getS().kLatencyMs / 1000;
    // highlight the note under the playhead (in time with the music); scoring separately uses the
    // mic-latency-delayed time, which would light notes up late
    const now = nowNote(k.notes, songT);
    const notes: RollNote[] = [];
    for (const n of k.notes) {
      if (n.start > songT + 12) break;
      if (n.end < songT - 8) continue;
      notes.push(k.perform
        // Perform: UltraStar-style – note bars fill as you sing them in tune (no per-note % or score colours)
        ? { start: n.start, end: n.end, midi: n.midi, kind: n.kind, text: n.u.text, score: null, active: n === now, hits: n.hits, misses: n.misses }
        : { start: n.start, end: n.end, midi: n.midi, kind: n.kind, text: n.u.text, score: n.score, active: n === now });
    }
    return {
      t: songT, inputLag: lag, notes, trace: k.trace, hideTrace: k.perform, subtleMarker: k.perform,
      clearRows: !!videoRef.current && !videoRef.current.error && getS().kVideo, ...(k.perform ? { markerMidi: k.dotMidi } : {}), viewLo: k.viewLo, viewHi: k.viewHi, pps: getS().kZoom, playhead: 0.28, root: null,
      title: `${song.artist} – ${song.title}`,
      phase: [m.playbackRate !== 1 ? `${m.playbackRate}×` : '', k.loop ? '🔁 loop' : ''].filter(Boolean).join('  '),
      activeMidi: now?.midi ?? null, currentClass: k.cls,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song]);

  const getTarget = useCallback(() => {
    const a = K.current.active;
    return a ? { midi: a.midi, cents: a.cents, root: null } : null;
  }, []);

  // drag the note area to scrub (practice mode); pauses while dragging, resumes if it was playing
  const scrubRef = useRef<{ t0: number; wasPlaying: boolean } | null>(null);
  const onScrub = useCallback((dt: number, phase: ScrubPhase) => {
    const m = media();
    if (!m) return;
    if (phase === 'start') {
      scrubRef.current = { t0: songNow(), wasPlaying: !m.paused && !m.ended };
      m.pause();
      return;
    }
    const s = scrubRef.current;
    if (!s) return;
    seek(s.t0 + dt);
    if (phase === 'end') { scrubRef.current = null; if (s.wasPlaying) m.play().catch(() => {}); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoIsMaster]);

  /* ---------- transport ---------- */
  const start = async () => {
    setMicError(null);
    try { await ensureAudio(true); }
    catch (e: any) { setMicError(String(e?.message || e)); return; }
    const m = media();
    if (!m) return;
    m.volume = getS().kSongVol;
    if (song.startSec > 0 && m.currentTime < song.startSec) m.currentTime = song.startSec;
    setStarted(true);
    try { await m.play(); } catch (e: any) {
      // the browser wants a click before playing sound: wait paused for ▶ / Space
      if (e?.name === 'NotAllowedError') toast('Press ▶ or Space to start the song.');
      else toast('Could not play the audio: ' + (e.message || e));
    }
  };
  // start by itself as soon as the audio is ready
  const autoStarted = useRef(false);
  useEffect(() => {
    if (audioReady && !started && !autoStarted.current) { autoStarted.current = true; start(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioReady]);
  const togglePlay = () => {
    const m = media();
    if (!m || !started) return;
    if (m.paused) m.play().catch(() => {}); else m.pause();
  };
  const onPlayEv = () => {
    const k = K.current;
    if (k.traceStale) { k.trace = []; k.traceStale = false; }
    if (!isRecording() && !k.ended && !k.recName) k.recName = startRecording(`karaoke-${stamp(k.startedAt)}`);
    else pauseRecording(false);
  };
  const onPauseEv = () => { pauseRecording(true); stopAll(); };
  const onEnded = () => { if (mode === 'perform') finish(); else toast('End of song. Press "Finish" to see your results, or keep practising.'); };

  useEffect(() => { const m = media(); if (m) { m.playbackRate = speed; (m as any).preservesPitch = true; } }, [speed, started]);
  useEffect(() => { const m = media(); if (m) m.volume = S.kSongVol; }, [S.kSongVol]);
  useEffect(() => { K.current.perform = mode === 'perform'; if (mode === 'perform') { setSpeed(1); setLoop(null); } }, [mode]);

  const practice = mode === 'practice';
  useEffect(() => {
    const kh = (e: KeyboardEvent) => {
      if (summary || isTyping(e.target)) return;
      const m = media(), k = K.current;
      if (claimSpace(e)) { started ? togglePlay() : start(); }
      else if (e.key === 'Escape') onExit();
      else if (!practice || !m || isControl(e.target)) return; // dropdowns/sliders keep their own arrow keys
      else if (e.key === 'ArrowLeft') seek(songNow() - 5);
      else if (e.key === 'ArrowRight') seek(songNow() + 5);
      else if (e.key === 'l' || e.key === 'L') { if (k.loop) setLoop(null); else loopLines(ui.line, ui.line); }
      else if (e.key === '[') { const i = Math.max(0, ui.line - 1); seek(k.lines[i].start - 1); }
      else if (e.key === ']') { const i = Math.min(k.lines.length - 1, ui.line + 1); seek(k.lines[i].start - 1); }
    };
    // capture phase: run before the focused button/checkbox/dropdown handles the key
    window.addEventListener('keydown', kh, true);
    return () => window.removeEventListener('keydown', kh, true);
  });

  /* ---------- render ---------- */
  const k = K.current;
  const lines = k.lines;
  const cur = lines[ui.line], next = lines[ui.line + 1];
  const lyricLine = (li: number, active: boolean) => {
    const l = lines[li];
    if (!l) return null;
    const py = pinyin?.[li];
    let at = 0; // character offset of this note within the line (pinyin is per character of the line)
    return <>{k.notes.slice(l.first, l.last + 1).map(n => {
      const txt = n.u.text.replace(/~/g, '');
      const from = at; at += txt.length;
      if (!txt) return null;
      const cls = [active && ui.t >= n.start ? 'done' : '', n.kind === 'golden' ? 'gold' : '', n.kind === 'free' ? 'free' : ''].join(' ');
      if (!py || !hasHan(txt)) return <span key={n.idx} className={cls}>{txt}</span>;
      return <span key={n.idx} className={cls}>{[...txt].map((ch, i) => py[from + i]
        ? <ruby key={i}>{ch}<rt>{py[from + i]}</rt></ruby>
        : <span key={i}>{ch}</span>)}</span>;
    })}</>;
  };
  const dur = ui.dur || 1;
  const pct = (t: number) => `${(100 * Math.max(0, Math.min(dur, t))) / dur}%`;
  const scoreAvg = k.attempts.length ? k.attempts.reduce((a, b) => a + b.score, 0) / k.attempts.length : null;

  return (
    <div className="game">
      <div className="gbar">
        <button className="btn sm" onClick={onExit}>← Songs</button>
        <span className="title">{song.title}</span><span className="meta">{song.artist}</span>
        {scoreAvg != null && <span className="meta">· {k.attempts.length} line{k.attempts.length === 1 ? '' : 's'} sung · avg {Math.round(scoreAvg)}%</span>}
        <span className="sp" />
        <div className="chips">
          <button className={'btn sm' + (practice ? ' on' : '')} onClick={() => setMode('practice')}>Practice</button>
          <button className={'btn sm' + (!practice ? ' on' : '')} onClick={() => setMode('perform')}>Perform</button>
        </div>
        {song.tracks.length > 1 && (
          <select value={trackIdx} onChange={e => setTrackIdx(+e.target.value)}>{song.tracks.map((t, i) => <option key={i} value={i}>{t.name}</option>)}</select>
        )}
        <select value={String(octChoice)} onChange={e => setOctChoice(e.target.value === 'auto' ? 'auto' : +e.target.value)} title="Which octave to show and score the melody in">
          <option value="auto">Octave: auto ({autoShift === 0 ? 'as written' : `${autoShift > 0 ? '+' : ''}${autoShift / 12} oct`})</option>
          <option value={-24}>2 octaves down</option><option value={-12}>1 octave down</option><option value={0}>As written</option><option value={12}>1 octave up</option>
        </select>
        <button className="btn sm" onClick={saveRecording} title="Download the recording so far">⬇ Recording</button>
        <button className="btn sm primary" onClick={finish} disabled={!k.attempts.length}>Finish</button>
      </div>

      <div className="kplayer">
        <div className="kmain">
          <Roll getScene={getScene} onScrub={practice && started ? onScrub : undefined}>
            {urls.video && <video ref={videoRef} src={urls.video} muted={!videoIsMaster} playsInline preload="auto"
              style={{ opacity: S.kVideo ? 0.22 : 0 }}
              {...(videoIsMaster ? { onPlay: onPlayEv, onPause: onPauseEv, onEnded } : {})} />}
            {!started && (
              <div className="startcover">
                <div style={{ fontSize: 22, fontWeight: 700 }}>{song.title}</div>
                <div className="muted">{song.artist}</div>
                <div className="hint" style={{ maxWidth: 460 }}>
                  {practice ? 'Practice mode: pause, scrub, slow down and loop any line. Click a line on the right to jump to it.' : 'Perform mode: sing the whole song through, then see your score.'}
                  {' '}Use headphones so the mic only hears you.
                </div>
                {micError ? (
                  <>
                    <div style={{ color: 'var(--bad)' }}>Microphone unavailable: {micError}</div>
                    <button className="btn primary" onClick={start}>Try again</button>
                  </>
                ) : <div className="muted">{audioReady ? 'Starting…' : 'Preparing audio…'}</div>}
              </div>
            )}
          </Roll>
          <div className="lyrics">
            <div className={'l1' + (pinyin ? ' py' : '')}>{lyricLine(ui.line, true)}</div>
            <div className={'l2' + (pinyin ? ' py' : '')}>{lyricLine(ui.line + 1, false)}</div>
          </div>
          <div className="transport">
            <button className="btn" onClick={() => (started ? togglePlay() : start())}>{ui.playing ? '⏸' : '▶'}</button>
            {practice && <button className="btn sm" onClick={() => seek(ui.t - 5)} title="Back 5 s (←)">−5s</button>}
            {practice && <button className="btn sm" onClick={() => seek(ui.t + 5)} title="Forward 5 s (→)">+5s</button>}
            <span className="time">{fmtTime(ui.t)} / {fmtTime(dur)}</span>
            <div className="scrub">
              <div className="lines">
                {lines.map((l, i) => <span key={i} style={{ left: pct(l.start), width: `calc(${pct(l.end)} - ${pct(l.start)})` }} />)}
                {loop && <span className="loop" style={{ left: pct(loop.a), width: `calc(${pct(loop.b)} - ${pct(loop.a)})` }} />}
              </div>
              <input type="range" min={0} max={dur} step={0.1} value={ui.t} disabled={!practice || !started}
                onChange={e => seek(+e.target.value)} />
            </div>
            {practice && <>
              <select value={speed} onChange={e => setSpeed(+e.target.value)} title="Playback speed (pitch stays the same)">
                {SPEEDS.map(s => <option key={s} value={s}>{s === 1 ? 'Speed 1×' : `${s}×`}</option>)}
              </select>
              <button className={'btn sm' + (loop ? ' on' : '')} onClick={() => (loop ? setLoop(null) : loopLines(ui.line, ui.line))} title="Loop the current line (L)">🔁 {loop ? 'Stop loop' : 'Loop line'}</button>
              <button className="btn sm" title="Set loop start here" onClick={() => setLoop({ a: ui.t, b: Math.max(ui.t + 2, loop?.b ?? ui.t + 8), from: -1, to: -1 })}>A</button>
              <button className="btn sm" title="Set loop end here" onClick={() => setLoop({ a: Math.min(loop?.a ?? ui.t - 8, ui.t - 1), b: ui.t, from: -1, to: -1 })}>B</button>
            </>}
            <span className="chips" title="If the notes and lyrics run behind the singer, press +; if they run ahead, press −. Saved for this song.">
              <span className="hint">Sync</span>
              <button className="btn sm" onClick={() => setSyncMs(s => s - 50)}>−</button>
              <button className="btn sm" onClick={() => setSyncMs(0)} title="Reset sync" style={{ minWidth: 64 }}>{syncMs > 0 ? '+' : ''}{(syncMs / 1000).toFixed(2)}s</button>
              <button className="btn sm" onClick={() => setSyncMs(s => s + 50)}>+</button>
            </span>
            <label className="chip" title="Play the vocal melody on the piano"><input type="checkbox" checked={S.kGuide} onChange={e => setS({ kGuide: e.target.checked })} /> Guide melody</label>
            <span className="hint">Song</span>
            <input type="range" min={0} max={1} step={0.05} value={S.kSongVol} onChange={e => setS({ kSongVol: +e.target.value })} style={{ width: 80 }} />
          </div>
          <Readout getTarget={getTarget} hint={practice ? <><kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> 5 s · <kbd>[</kbd><kbd>]</kbd> lines · <kbd>L</kbd> loop</> : <><kbd>Space</kbd> play/pause</>} />
        </div>

        {practice && (
          <div className="kside">
            <div className="head">Lines · click to jump · 🔁 to loop · shift-click to loop a range</div>
            <div className="klines">
              {lines.map((l, i) => {
                const sc = lineScores[i];
                const inLoop = loop && loop.from >= 0 && i >= loop.from && i <= loop.to;
                return (
                  <div key={i} className={'kline' + (i === ui.line ? ' cur' : '') + (inLoop ? ' inloop' : '')}
                    onClick={e => { if (e.shiftKey && loop && loop.from >= 0) loopLines(loop.from, i); else seek(l.start - 1); }}>
                    <span className="tm">{fmtTime(l.start)}</span>
                    <span className="tx" title={l.text}>{l.text || '…'}</span>
                    <span className="sc" style={{ color: sc ? scoreColor(sc.last) : undefined }} title={sc ? `best ${Math.round(sc.best * 100)}% · ${sc.tries} tries` : ''}>{sc ? Math.round(sc.last * 100) + '%' : ''}</span>
                    <button className={'lp' + (inLoop ? ' on' : '')} title="Loop this line"
                      onClick={e => { e.stopPropagation(); if (loop && loop.from === i && loop.to === i) setLoop(null); else loopLines(i, i); }}>🔁</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {urls.audio && <audio ref={audioRef} src={urls.audio} preload="auto" onPlay={onPlayEv} onPause={onPauseEv} onEnded={onEnded} />}

      {summary && (
        <Results title={`${song.artist} – ${song.title}`} scores={summary.scores} session={summary.session} unit="line"
          onBack={onExit} />
      )}
    </div>
  );
}
