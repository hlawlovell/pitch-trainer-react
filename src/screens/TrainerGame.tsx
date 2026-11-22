import { useCallback, useEffect, useRef, useState } from 'react';
import Roll, { type RollNote, type Scene, type TraceClass, type TracePoint } from '../components/Roll';
import Readout from '../components/Readout';
import { Results, saveRecording, toast } from '../components/ui';
import { pianoTarget } from '../components/TopPiano';
import { click, ensureAudio, live, onFrame, playNote, stopAll } from '../audio/engine';
import { pauseRecording, recTime, stamp, startRecording, stopRecording } from '../audio/recorder';
import { gen, LEVELS, starCount, type ExerciseCfg, type Pattern } from '../lib/exercises';
import { analyzeNote, shownScore, step, type NoteMeasure } from '../lib/analysis';
import { addSession, type RoundLog, type Session } from '../lib/history';
import { getS } from '../lib/settings';
import { lsGet, lsSet } from '../lib/storage';
import { claimSpace, isControl, isTyping } from '../lib/keys';

const PX_PER_BEAT = 110;

interface GNote extends NoteMeasure {
  midi: number; start: number; end: number; kind: 'listen' | 'sing';
  play?: boolean; fired?: boolean; done?: boolean; cents?: number | null;
}
interface Round {
  pattern: Pattern | null; notes: GNote[]; events: { t: number; accent: boolean; fired?: boolean }[];
  vt: number; end: number; listenEnd: number; singStart: number; viewLo: number; viewHi: number;
  trace: TracePoint[]; state: 'run' | 'done'; active: GNote | null; score?: number; recMark: number | null;
  waiting: boolean; cls: TraceClass; free?: boolean;
}

const beat = () => 60 / getS().tempo;

function buildRound(p: Pattern): Round {
  const S = getS(), b = beat(), notes: GNote[] = [], events: Round['events'] = [];
  const blank = (): NoteMeasure => ({ hit: 0, total: 0, frames: 0, samples: [] });
  let t = 0.8;
  if (S.mode === 'echo') p.notes.forEach((m, i) => { notes.push({ ...blank(), midi: m, start: t, end: t + p.durs[i] * b * 0.93, kind: 'listen' }); t += p.durs[i] * b; });
  else if (S.mode === 'cue') { notes.push({ ...blank(), midi: p.notes[0], start: t, end: t + 2 * b * 0.93, kind: 'listen' }); t += 2 * b; }
  const listenEnd = t;
  if (S.countIn) { t += b * 0.5; for (let k = 0; k < 2; k++) { events.push({ t, accent: k === 0 }); t += b; } } else t += b;
  const singStart = t;
  p.notes.forEach((m, i) => { notes.push({ ...blank(), midi: m, start: t, end: t + p.durs[i] * b * 0.95, kind: 'sing', play: S.mode === 'along' }); t += p.durs[i] * b; });
  let lo = Math.min(...p.notes) - 4, hi = Math.max(...p.notes) + 4;
  while (hi - lo < 13) { lo--; hi++; }
  return { pattern: p, notes, events, vt: 0, end: t + 0.6, listenEnd, singStart, viewLo: lo, viewHi: hi, trace: [], state: 'run', active: null, recMark: null, waiting: false, cls: 'none' };
}

export interface GameProps {
  cfg?: ExerciseCfg; title: string; level?: number | null; free?: boolean;
  onExit: () => void; onAgain?: () => void; onLevel?: (i: number) => void;
}

export default function TrainerGame({ cfg, title, level = null, free = false, onExit, onAgain, onLevel }: GameProps) {
  const total = cfg?.rounds || 8;
  const G = useRef({
    round: null as Round | null, results: [] as number[], log: [] as RoundLog[], paused: false, ended: false,
    started: new Date(), timer: 0 as any, recName: null as string | null,
  });
  const [bar, setBar] = useState({ round: 1, avg: null as number | null, paused: false });
  const [summary, setSummary] = useState<{ scores: number[]; session: Session | null } | null>(null);

  const refreshBar = () => {
    const g = G.current, r = g.results;
    setBar({ round: Math.min(r.length + 1, total), avg: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null, paused: g.paused });
  };

  const saveSession = (partial: boolean): Session | null => {
    const g = G.current, S = getS();
    if (free || !g.log.length) return null;
    const s: Session = {
      date: g.started.toISOString(), kind: 'trainer', title, partial, tol: S.tol, lo: S.lo, hi: S.hi, tempo: S.tempo, mode: S.mode, wait: S.wait,
      avg: Math.round((100 * g.results.reduce((a, b) => a + b, 0)) / g.results.length), rec: g.recName, rounds: g.log,
    };
    addSession(s);
    return s;
  };

  const nextRound = useCallback(() => {
    stopAll();
    G.current.round = buildRound(gen(cfg!));
    refreshBar();
  }, [cfg]);

  const endSession = () => {
    const g = G.current;
    g.ended = true;
    const sess = saveSession(false);
    stopRecording();
    if (level != null) {
      const prog = lsGet<Record<number, number>>('pt_progress', {});
      const avg = g.results.reduce((a, b) => a + b, 0) / g.results.length;
      if (avg > (prog[level] || 0)) { prog[level] = avg; lsSet('pt_progress', prog); }
    }
    setSummary({ scores: [...g.results], session: sess });
  };

  const finishRound = () => {
    const g = G.current, r = g.round!, S = getS();
    r.state = 'done';
    const sing = r.notes.filter(n => n.kind === 'sing');
    r.score = sing.reduce((a, n) => a + shownScore(n, S.scoreCurve), 0) / sing.length;
    g.results.push(r.score);
    g.log.push({
      label: r.pattern!.label, score: Math.round(r.score * 100), rec: r.recMark,
      notes: sing.map((n, i) => analyzeNote(n, S.tol, n.midi, i ? n.midi - sing[i - 1].midi : null)),
    });
    refreshBar();
    g.timer = setTimeout(() => {
      if (G.current.round !== r) return;
      if (g.results.length >= total) endSession(); else nextRound();
    }, 1600);
  };

  // start / stop
  useEffect(() => {
    const g = G.current;
    let alive = true;
    (async () => {
      try { await ensureAudio(true); }
      catch (e: any) { toast('Microphone unavailable: ' + (e.message || e)); onExit(); return; }
      if (!alive) return;
      g.recName = startRecording(`pitch-session-${stamp(g.started)}`);
      if (free) {
        const S = getS();
        g.round = { pattern: null, notes: [], events: [], vt: 0, end: Infinity, listenEnd: 0, singStart: 0, viewLo: S.lo - 3, viewHi: S.hi + 3, trace: [], state: 'run', active: null, recMark: null, waiting: false, cls: 'none', free: true };
      } else nextRound();
    })();
    return () => {
      alive = false;
      clearTimeout(g.timer);
      if (!g.ended) { saveSession(true); stopRecording(); }
      stopAll();
      pianoTarget.midi = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // game loop
  useEffect(() => onFrame(dt => {
    const g = G.current, r = g.round;
    if (!r || g.paused) return;
    const S = getS(), pitch = live.pitch;
    if (r.free) {
      r.vt += dt;
      r.trace.push({ t: r.vt, m: pitch, c: 'none' });
      while (r.trace.length && r.vt - r.trace[0].t > 20) r.trace.shift();
      return;
    }
    if (r.state === 'done') return;
    const vt = r.vt;
    let active: GNote | null = null;
    for (const n of r.notes) if (n.kind === 'sing' && vt >= n.start && vt < n.end) { active = n; break; }
    r.active = active;
    pianoTarget.midi = active ? active.midi : null;
    let cls: TraceClass = 'none';
    if (active) {
      active.cents = null;
      let c: number | null = null;
      if (pitch != null) {
        c = (pitch - active.midi) * 100;
        if (S.anyOctave) c = (((c % 1200) + 1800) % 1200) - 600;
        active.cents = c;
      }
      // score this frame; the judged error (smoothed in v2) also colours the trace
      const judged = step(active, { t: vt - active.start, dur: active.end - active.start, d: dt, cents: c, tol: S.tol, slide: S.slideMs / 1000, v: S.scoring });
      if (judged != null) { const a = Math.abs(judged); cls = a <= S.tol ? 'good' : a <= 100 ? 'warn' : 'bad'; }
      active.frames++;
      if (pitch != null) active.samples.push([vt - active.start, (pitch - active.midi) * 100]);
    }
    r.cls = cls;
    if (r.recMark == null && vt >= r.singStart) r.recMark = recTime();
    let nvt = vt + dt;
    r.waiting = false;
    if (S.wait && active && !active.done) {
      const req = Math.min(0.6, (active.end - active.start) * 0.5);
      if (active.hit >= req) active.done = true;
      else if (nvt > active.end - 0.01) { nvt = active.end - 0.01; r.waiting = true; }
    }
    for (const e of r.events) if (!e.fired && nvt >= e.t) { e.fired = true; click(e.accent); }
    for (const n of r.notes) if (!n.fired && (n.kind === 'listen' || n.play) && nvt >= n.start) {
      n.fired = true;
      playNote(n.midi, Math.max(0.1, n.end - Math.max(n.start, vt)), n.kind === 'sing' ? 0.55 : 1);
    }
    r.trace.push({ t: vt, m: pitch, c: vt < r.singStart ? 'listen' : cls });
    r.vt = nvt;
    if (r.vt >= r.end) finishRound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const getScene = useCallback((): Scene | null => {
    const g = G.current, r = g.round;
    if (!r) return null;
    const S = getS();
    let phase = '';
    if (!r.free && r.state !== 'done') {
      if (S.mode !== 'along' && r.vt < r.listenEnd) phase = '🎧 Listen…';
      else if (r.vt < r.singStart) phase = 'Get ready…';
      else phase = r.waiting ? '🎤 Hold the note…' : '🎤 Sing!';
    }
    const notes: RollNote[] = r.notes.map(n => ({
      start: n.start, end: n.end, midi: n.midi, kind: n.kind, active: n === r.active,
      score: n.kind === 'sing' && r.vt >= n.end ? shownScore(n, getS().scoreCurve) : null,
    }));
    return {
      t: r.vt, notes, trace: r.trace, viewLo: r.viewLo, viewHi: r.viewHi,
      pps: r.free ? 110 : PX_PER_BEAT / beat(), root: r.pattern?.root ?? null,
      title: r.free ? 'Free sing: see what note you are singing' : r.pattern!.label, phase,
      activeMidi: r.active?.midi ?? null, currentClass: r.cls, paused: g.paused,
      result: r.state === 'done' ? r.score ?? null : null,
    };
  }, []);

  const getTarget = useCallback(() => {
    const r = G.current.round;
    return r?.active ? { midi: r.active.midi, cents: r.active.cents ?? null, root: r.pattern?.root ?? null } : null;
  }, []);

  const togglePause = () => {
    const g = G.current;
    g.paused = !g.paused;
    if (g.paused) stopAll();
    pauseRecording(g.paused);
    refreshBar();
  };
  const replay = () => {
    const g = G.current;
    if (free || !g.round?.pattern) return;
    clearTimeout(g.timer); stopAll();
    if (g.round.state === 'done') { g.results.pop(); g.log.pop(); }
    g.round = buildRound(g.round.pattern);
    refreshBar();
  };
  const skip = () => {
    const g = G.current;
    if (free) return;
    clearTimeout(g.timer);
    if (g.round?.state === 'done' && g.results.length >= total) endSession(); else nextRound();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (summary || isTyping(e.target)) return;
      if (claimSpace(e)) togglePause();
      else if (e.key === 'Escape') onExit();
      else if (isControl(e.target)) return;
      else if (e.key === 'r' || e.key === 'R') replay();
    };
    // capture phase: run before the focused button/checkbox/dropdown handles the key
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  const avg = summary ? summary.scores.reduce((a, b) => a + b, 0) / Math.max(1, summary.scores.length) : 0;

  return (
    <div className="game">
      <div className="gbar">
        <button className="btn sm" onClick={onExit}>← Back</button>
        <span className="title">{title}</span>
        {!free && <span className="meta">Round {bar.round} / {total}</span>}
        {!free && bar.avg != null && <span className="meta">Avg {Math.round(bar.avg * 100)}%</span>}
        <span className="sp" />
        <button className="btn sm" onClick={togglePause}>{bar.paused ? '▶ Resume' : '⏸ Pause'}</button>
        {!free && <button className="btn sm" onClick={replay}>↻ Replay</button>}
        {!free && <button className="btn sm" onClick={skip}>⏭ Skip</button>}
        <button className="btn sm" onClick={saveRecording} title="Download the recording so far">⬇ Recording</button>
      </div>
      <Roll getScene={getScene} />
      <Readout getTarget={getTarget} hint={<><kbd>Space</kbd> pause · <kbd>R</kbd> replay · <kbd>Esc</kbd> back · click the piano to hear a note</>} />
      {summary && (
        <Results title={title} scores={summary.scores} session={summary.session} onBack={onExit} onAgain={onAgain}
          extra={level != null && level + 1 < LEVELS.length && starCount(avg) > 0 && onLevel ? <button className="btn primary" onClick={() => onLevel(level + 1)}>Next level →</button> : null} />
      )}
    </div>
  );
}
