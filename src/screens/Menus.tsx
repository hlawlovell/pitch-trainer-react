import { useEffect, useMemo, useState } from 'react';
import { ARPS, LEVELS, SCALES, starCount, type ExerciseCfg } from '../lib/exercises';
import { IVN, SHARP, FLAT, octOf, pc } from '../lib/notes';
import { setS, useSettings, type Settings } from '../lib/settings';
import { lsGet, lsSet } from '../lib/storage';
import { clearHistory, useHistory } from '../lib/history';
import { buildReport } from '../lib/report';
import { ensureAudio, playNote, setMasterVolume, stableNote, live, onFrame } from '../audio/engine';
import { hasRecording } from '../audio/recorder';
import { Stars, copyText, downloadReport, saveRecording, toast } from '../components/ui';
import { scoreColor } from '../lib/exercises';

/* ---------- small bound inputs ---------- */
type K = keyof Settings;
export function Sel({ k, opts }: { k: K; opts: [string | number, string][] }) {
  const S = useSettings();
  return (
    <select value={String(S[k])} onChange={e => setS({ [k]: typeof S[k] === 'number' ? +e.target.value : e.target.value } as any)}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
export function Check({ k, label }: { k: K; label: string }) {
  const S = useSettings();
  return <label className="chip"><input type="checkbox" checked={!!S[k]} onChange={e => setS({ [k]: e.target.checked } as any)} /> {label}</label>;
}
export function Slider({ k, min, max, step, show, suffix = '', onChange }: { k: K; min: number; max: number; step: number; show?: boolean; suffix?: string; onChange?: (v: number) => void }) {
  const S = useSettings();
  return (
    <>
      <input type="range" min={min} max={max} step={step} value={S[k] as number}
        onChange={e => { setS({ [k]: +e.target.value } as any); onChange?.(+e.target.value); }} />
      {show && <span>{S[k] as number}{suffix}</span>}
    </>
  );
}
const MODE_OPTS: [string, string][] = [['echo', 'Echo: listen, then sing'], ['along', 'Sing along with the reference'], ['cue', 'First note only, then sing']];
const noteOpts = () => {
  const o: [number, string][] = [];
  for (let m = 28; m <= 96; m++) o.push([m, `${SHARP[pc(m)]}${octOf(m)}${FLAT[pc(m)] !== SHARP[pc(m)] ? ` / ${FLAT[pc(m)]}${octOf(m)}` : ''}`]);
  return o;
};

/* ---------- Course ---------- */
export function Course({ onLevel, onSettings }: { onLevel: (i: number) => void; onSettings: () => void }) {
  const S = useSettings();
  const prog = lsGet<Record<number, number>>('pt_progress', {});
  return (
    <div className="screen"><div className="wrap">
      {!S.rangeSet && <div className="banner">👋 First, set your vocal range so exercises fit your voice. <button className="btn sm primary" onClick={onSettings}>Set range</button></div>}
      <h2>Course</h2>
      <p className="sub">Work through the levels in order. Each level is 8 rounds; get 70% for ★, 80% for ★★ and 90% for ★★★. Every note is labelled with its name.</p>
      <div className="grid">
        {LEVELS.map((L, i) => {
          const b = prog[i] || 0;
          return (
            <div className="lvl" key={i} onClick={() => onLevel(i)}>
              <div className="n">Level {i + 1}</div><div className="t">{L.name}</div><div className="d">{L.desc}</div>
              <span className="best">{b ? Math.round(b * 100) + '%' : ''}</span><Stars n={starCount(b)} />
            </div>
          );
        })}
      </div>
    </div></div>
  );
}

/* ---------- Practice ---------- */
export function Practice({ onStart }: { onStart: (cfg: ExerciseCfg, title: string) => void }) {
  const [type, setType] = useState<ExerciseCfg['type']>('single');
  const [ivs, setIvs] = useState<number[]>([3, 4, 5, 7]);
  const [dir, setDir] = useState<'both' | 'up' | 'down'>('both');
  const [sc, setSc] = useState<string[]>(['major']);
  const [ar, setAr] = useState<string[]>(['maj', 'min']);
  const [shape, setShape] = useState<'updown' | 'up' | 'down'>('updown');
  const [len, setLen] = useState(5);
  const [rounds, setRounds] = useState(10);
  const toggle = <T,>(arr: T[], v: T, set: (a: T[]) => void) => set(arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);
  const names: Record<string, string> = { single: 'Single notes', interval: 'Intervals', scale: 'Scales', arp: 'Arpeggios / chords', melody: 'Random melodies' };

  const start = () => {
    const cfg: ExerciseCfg = { type, rounds: Math.max(1, Math.min(50, rounds || 10)) };
    if (type === 'interval') { if (!ivs.length) return toast('Pick at least one interval.'); cfg.intervals = ivs; cfg.dir = dir; }
    if (type === 'scale' || type === 'arp') { const t = type === 'scale' ? sc : ar; if (!t.length) return toast('Pick at least one.'); cfg.types = t; cfg.shape = shape; }
    if (type === 'melody') cfg.len = Math.max(2, Math.min(10, len));
    onStart(cfg, 'Practice: ' + names[type]);
  };
  const shapeRow = (
    <div className="row"><label className="k">Direction</label>
      <select value={shape} onChange={e => setShape(e.target.value as any)}><option value="updown">Up and down</option><option value="up">Up</option><option value="down">Down</option></select></div>
  );

  return (
    <div className="screen"><div className="wrap">
      <h2>Practice</h2>
      <p className="sub">Build your own exercise.</p>
      <div className="card">
        <div className="row"><label className="k">Exercise</label>
          <select value={type} onChange={e => setType(e.target.value as any)}>
            {Object.entries(names).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        {type === 'interval' && <>
          <div className="row"><label className="k">Intervals</label><div className="chips">
            {IVN.map((n, i) => <label className="chip" key={i}><input type="checkbox" checked={ivs.includes(i)} onChange={() => toggle(ivs, i, setIvs)} /> {n}</label>)}
          </div></div>
          <div className="row"><label className="k">Direction</label>
            <select value={dir} onChange={e => setDir(e.target.value as any)}><option value="both">Up and down</option><option value="up">Ascending</option><option value="down">Descending</option></select></div>
        </>}
        {type === 'scale' && <><div className="row"><label className="k">Scales</label><div className="chips">
          {Object.entries(SCALES).map(([k, v]) => <label className="chip" key={k}><input type="checkbox" checked={sc.includes(k)} onChange={() => toggle(sc, k, setSc)} /> {v.n}</label>)}
        </div></div>{shapeRow}</>}
        {type === 'arp' && <><div className="row"><label className="k">Chords</label><div className="chips">
          {Object.entries(ARPS).map(([k, v]) => <label className="chip" key={k}><input type="checkbox" checked={ar.includes(k)} onChange={() => toggle(ar, k, setAr)} /> {v.n}</label>)}
        </div></div>{shapeRow}</>}
        {type === 'melody' && <div className="row"><label className="k">Notes per melody</label><input type="number" min={2} max={10} value={len} onChange={e => setLen(+e.target.value)} style={{ width: 80 }} /></div>}
        <div className="row"><label className="k">Rounds</label><input type="number" min={1} max={50} value={rounds} onChange={e => setRounds(+e.target.value)} style={{ width: 80 }} /></div>
      </div>
      <div className="card">
        <h3>Game options</h3>
        <div className="row"><label className="k">Mode</label><Sel k="mode" opts={MODE_OPTS} /></div>
        <div className="row"><label className="k">Tempo</label><Slider k="tempo" min={40} max={160} step={5} show suffix=" BPM" /></div>
        <div className="row"><label className="k">Wait for me</label><Check k="wait" label="Pause on each note until I hit it" /></div>
      </div>
      <button className="btn primary" onClick={start}>▶ Start</button>
    </div></div>
  );
}

/* ---------- Progress & AI report ---------- */
export function Progress() {
  const hist = useHistory();
  const [scope, setScope] = useState('last');
  const [detail, setDetail] = useState(true);
  const sessions = useMemo(() => {
    if (scope === 'last') return hist.slice(-1);
    if (scope === 'all') return hist.slice();
    if (scope === 'trainer' || scope === 'karaoke') return hist.filter(s => s.kind === scope);
    const cut = Date.now() - +scope * 864e5;
    return hist.filter(s => new Date(s.date).getTime() >= cut);
  }, [hist, scope]);
  const text = useMemo(() => buildReport(sessions, detail), [sessions, detail]);

  return (
    <div className="screen"><div className="wrap">
      <h2>Progress &amp; AI report</h2>
      <p className="sub">Every exercise session and karaoke song is measured note by note and saved in this browser. Copy the report and paste it into Claude, ChatGPT or Gemini for feedback on your singing. If the AI accepts audio, attach your recording too.</p>
      <div className="card">
        <div className="row"><label className="k">Include</label>
          <select value={scope} onChange={e => setScope(e.target.value)}>
            <option value="last">Last session</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
            <option value="trainer">All exercise sessions</option><option value="karaoke">All karaoke sessions</option><option value="all">Everything</option>
          </select>
          <label className="chip"><input type="checkbox" checked={detail} onChange={e => setDetail(e.target.checked)} /> Note-by-note detail</label>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => copyText(text)}>📋 Copy report for AI</button>
          <button className="btn" onClick={() => downloadReport(sessions, detail)}>⬇ Download report (.txt)</button>
          {hasRecording() && <button className="btn" onClick={saveRecording}>⬇ Latest recording (.wav)</button>}
          <span className="hint">{sessions.length} session{sessions.length === 1 ? '' : 's'} · {text.length.toLocaleString()} characters</span>
        </div>
        <textarea className="report" readOnly value={text} />
        <div className="hint">Recordings stay in memory only until you close or reload the page, so download any you want to keep. Use headphones so the recording contains just your voice.</div>
      </div>
      <div className="card"><h3>History</h3>
        {hist.length ? [...hist].reverse().map((s, i) => (
          <div className="hrow" key={i}>
            <span>{new Date(s.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span>{s.kind === 'karaoke' ? '🎤 ' : ''}{s.title}{s.partial && <span className="muted"> (stopped early)</span>}</span>
            <span>{s.rounds.length} {s.kind === 'karaoke' ? 'line' : 'round'}{s.rounds.length === 1 ? '' : 's'}</span>
            <b style={{ color: scoreColor(s.avg / 100) }}>{s.avg}%</b>
          </div>
        )) : <div className="muted">No sessions yet.</div>}
        <div className="row" style={{ marginTop: 12 }}><button className="btn sm" onClick={() => { if (confirm('Delete all saved session measurements?')) clearHistory(); }}>Clear history</button></div>
      </div>
    </div></div>
  );
}

/* ---------- Settings ---------- */
const PRESETS: [string, number, number][] = [['Bass', 40, 64], ['Baritone', 45, 69], ['Tenor', 48, 72], ['Alto', 53, 77], ['Mezzo', 57, 81], ['Soprano', 60, 84]];

export function SettingsScreen() {
  const S = useSettings();
  const [mic, setMic] = useState(false);
  const [liveNote, setLiveNote] = useState('–');
  const opts = useMemo(noteOpts, []);
  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const s = live.pitch != null ? `${SHARP[pc(Math.round(live.pitch))]}${octOf(Math.round(live.pitch))}` : '–';
      if (s !== last) { last = s; setLiveNote(s); }
    });
  }, []);
  const setFromVoice = (k: 'lo' | 'hi') => {
    const m = stableNote();
    if (m == null) return toast('Start the mic and hold a note first.');
    setS({ [k]: m, rangeSet: true } as any);
  };
  const play = async (m: number) => { await ensureAudio(false); playNote(m, 1.2); };

  return (
    <div className="screen"><div className="wrap">
      <h2>Settings</h2>
      <p className="sub">Saved automatically in this browser.</p>
      <div className="card">
        <h3>Your pitch range</h3>
        <div className="row"><label className="k">Lowest note</label>
          <select value={S.lo} onChange={e => setS({ lo: +e.target.value, rangeSet: true })}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="btn sm" onClick={() => play(S.lo)}>▶</button></div>
        <div className="row"><label className="k">Highest note</label>
          <select value={S.hi} onChange={e => setS({ hi: +e.target.value, rangeSet: true })}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="btn sm" onClick={() => play(S.hi)}>▶</button></div>
        <div className="row"><label className="k">Presets</label><div className="chips">
          {PRESETS.map(([n, a, b]) => <span key={n} className="chip" onClick={() => setS({ lo: a, hi: b, rangeSet: true })}>{n} <span className="muted">{SHARP[pc(a)]}{octOf(a)}–{SHARP[pc(b)]}{octOf(b)}</span></span>)}
        </div></div>
        <div className="row"><label className="k">Detect by singing</label>
          <button className="btn sm" onClick={async () => { try { await ensureAudio(true); setMic(true); } catch (e: any) { toast('Microphone unavailable: ' + (e.message || e)); } }}>{mic ? '🎤 Mic on' : '🎤 Start mic'}</button>
          <span className="live">{liveNote}</span>
          <button className="btn sm" onClick={() => setFromVoice('lo')}>Set as lowest</button>
          <button className="btn sm" onClick={() => setFromVoice('hi')}>Set as highest</button></div>
        <div className="hint">Sing your lowest comfortable note, hold it, and press "Set as lowest". Do the same for the top. Headphones help so the mic doesn't hear the reference tone.</div>
      </div>
      <div className="card">
        <h3>Note names</h3>
        <div className="row"><label className="k">Style</label><Sel k="naming" opts={[['letter', 'Letters (C D E)'], ['both', 'Letters + movable do (C4 · Do)'], ['fixed', 'Fixed do (Do Re Mi = C D E)'], ['movable', 'Movable do (Do = key note)']]} /></div>
        <div className="row"><label className="k">Accidentals</label><Sel k="accidental" opts={[['sharp', 'Sharps (C♯)'], ['flat', 'Flats (D♭)']]} /></div>
        <div className="row"><label className="k">Octave numbers</label><Check k="octave" label="Show (C4 vs C)" /></div>
      </div>
      <div className="card">
        <h3>Exercises</h3>
        <div className="row"><label className="k">Pitch tolerance</label><Slider k="tol" min={10} max={80} step={5} show suffix=" cents (±)" /></div>
        <div className="row"><label className="k">Slide allowance</label><Slider k="slideMs" min={0} max={400} step={10} show suffix=" ms" />
          <span className="hint">at the start and end of each note, sliding between notes isn't marked wrong (exercises &amp; karaoke)</span></div>
        <div className="row"><label className="k">Scoring</label><Sel k="scoring" opts={[['v2', 'v2 – forgiving (recommended)'], ['v1', 'v1 – strict (original)']]} />
          <span className="hint">v2 ignores moments with no voice (consonants, breaths), averages out vibrato, and gives partial credit when you're slightly off</span></div>
        <div className="row"><label className="k">Score display</label><Check k="scoreCurve" label="Karaoke-machine style (85% in tune shows as ~95)" /></div>
        <div className="row"><label className="k">Tempo</label><Slider k="tempo" min={40} max={160} step={5} show suffix=" BPM" /></div>
        <div className="row"><label className="k">Mode</label><Sel k="mode" opts={MODE_OPTS} /></div>
        <div className="row"><label className="k">Options</label><div className="chips">
          <Check k="wait" label="Wait for me on each note" /><Check k="countIn" label="Count-in clicks" />
          <Check k="anyOctave" label="Accept any octave" /><Check k="record" label="Record my voice" />
        </div></div>
      </div>
      <div className="card">
        <h3>Karaoke</h3>
        <div className="row"><label className="k">Mic latency</label><Slider k="kLatencyMs" min={0} max={400} step={10} show suffix=" ms" />
          <span className="hint">raise it if your pitch line lags behind the notes</span></div>
        <div className="row"><label className="k">Scroll speed</label><Slider k="kZoom" min={80} max={320} step={10} show suffix=" px/s" /></div>
        <div className="row"><label className="k">Options</label><div className="chips">
          <Check k="kAnyOctave" label="Accept any octave (recommended)" /><Check k="kVideo" label="Show music video behind notes" /><Check k="kPinyin" label="Show pinyin under Chinese lyrics" />
          <Check k="kStoreSongs" label="Keep added songs in this browser" />
        </div></div>
      </div>
      <div className="card">
        <h3>Sound &amp; microphone</h3>
        <div className="row"><label className="k">Reference tone</label><Sel k="tone" opts={[['piano', 'Piano'], ['soft', 'Soft (organ-like)'], ['bright', 'Bright'], ['sine', 'Pure sine']]} /></div>
        <div className="row"><label className="k">Volume</label><Slider k="volume" min={0} max={1} step={0.05} onChange={setMasterVolume} /></div>
        <div className="row"><label className="k">Pitch line smoothing</label><Slider k="traceSmoothMs" min={0} max={300} step={10} show suffix=" ms" />
          <span className="hint">steadies your pitch line, pitch dot and tuner (0 = raw; higher = steadier but slower to react). Doesn't change scoring</span></div>
        <div className="row"><label className="k">Mic noise gate</label><Slider k="gate" min={0.002} max={0.05} step={0.001} /><span className="hint">raise it if background noise shows up as pitch</span></div>
      </div>
      <button className="btn" onClick={() => { if (confirm('Reset all course stars?')) { lsSet('pt_progress', {}); toast('Course progress reset.'); } }}>Reset course progress</button>
    </div></div>
  );
}
