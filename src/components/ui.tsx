import { useEffect, useState } from 'react';
import { scoreColor, starCount } from '../lib/exercises';
import { buildReport } from '../lib/report';
import type { Session } from '../lib/history';
import { download, downloadRecording, stamp } from '../audio/recorder';

/* ---------- toast ---------- */
let pushToast: (m: string) => void = () => {};
export const toast = (m: string) => pushToast(m);
export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let t: any;
    pushToast = m => { setMsg(m); clearTimeout(t); t = setTimeout(() => setMsg(null), 3200); };
    return () => { pushToast = () => {}; };
  }, []);
  return msg ? <div className="toast">{msg}</div> : null;
}

export const Stars = ({ n }: { n: number }) => (
  <div className="stars">{'★'.repeat(n)}<span className="off">{'★'.repeat(3 - n)}</span></div>
);

export async function copyText(t: string) {
  let ok = false;
  try { await navigator.clipboard.writeText(t); ok = true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(ok ? 'Report copied. Paste it into Claude, ChatGPT or Gemini.' : 'Couldn\'t copy automatically. Use "Download" instead.');
}

export function downloadReport(sessions: Session[], detail: boolean) {
  const se = sessions[sessions.length - 1];
  download(`pitch-report-${se ? stamp(new Date(se.date)) : 'empty'}.txt`, new Blob([buildReport(sessions, detail)], { type: 'text/plain' }));
}

export async function saveRecording() {
  toast('Preparing recording…');
  toast(await downloadRecording());
}

/** End-of-session results card. */
export function Results({ title, scores, session, onBack, onAgain, extra, unit = 'round' }: {
  title: string; scores: number[]; session: Session | null; onBack: () => void; onAgain?: () => void;
  extra?: React.ReactNode; unit?: string;
}) {
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return (
    <div className="overlay">
      <div className="card">
        <div className="muted">{title}</div>
        <div className="big">{Math.round(avg * 100)}%</div>
        <Stars n={starCount(avg)} />
        <div className="bars">
          {scores.map((s, i) => <div key={i} title={`${unit} ${i + 1}: ${Math.round(s * 100)}%`} style={{ height: Math.max(4, s * 60), background: scoreColor(s) }} />)}
        </div>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn" onClick={onBack}>Back</button>
          {onAgain && <button className="btn" onClick={onAgain}>Again</button>}
          {extra}
        </div>
        {session && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
            <button className="btn sm" onClick={() => copyText(buildReport([session], true))}>📋 Copy report for AI</button>
            <button className="btn sm" onClick={() => downloadReport([session], true)}>⬇ Report</button>
            {session.rec && <button className="btn sm" onClick={saveRecording}>⬇ Recording</button>}
          </div>
        )}
      </div>
    </div>
  );
}
