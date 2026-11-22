import { useEffect, useRef } from 'react';
import { live, onFrame } from '../audio/engine';
import { mtof, noteName } from '../lib/notes';
import { getS } from '../lib/settings';

export interface ReadoutTarget { midi: number; cents: number | null; root: number | null }

/** Bottom bar: the note you're singing, a ±50 cent tuner and the current target. */
export default function Readout({ getTarget, hint }: { getTarget: () => ReadoutTarget | null; hint?: React.ReactNode }) {
  const note = useRef<HTMLDivElement>(null), needle = useRef<HTMLDivElement>(null), zone = useRef<HTMLDivElement>(null);
  const hz = useRef<HTMLDivElement>(null), tgt = useRef<HTMLDivElement>(null);

  useEffect(() => onFrame(() => {
    // display uses the smoothed pitch (Settings → Pitch line smoothing); scoring uses the raw one
    const S = getS(), p = live.shown, t = getTarget();
    const root = t?.root ?? null;
    if (!note.current) return;
    if (p == null) {
      note.current.textContent = '–';
      hz.current!.textContent = '';
      needle.current!.style.opacity = '0.2';
      needle.current!.style.left = '50%';
    } else {
      note.current.textContent = noteName(p, root);
      const c = (p - Math.round(p)) * 100;
      needle.current!.style.opacity = '1';
      needle.current!.style.left = 50 + c + '%';
      needle.current!.style.background = Math.abs(c) <= S.tol ? '#46d18a' : '#f5b84a';
      hz.current!.textContent = mtof(p).toFixed(1) + ' Hz';
    }
    const tol = Math.min(50, S.tol);
    zone.current!.style.left = 50 - tol + '%';
    zone.current!.style.width = 2 * tol + '%';
    if (t) {
      // the target's cents come from the raw pitch; shift them by the smoothing so the number is as steady as the needle
      const c = t.cents != null && live.pitch != null && p != null ? t.cents + (p - live.pitch) * 100 : t.cents;
      const ok = c != null && Math.abs(c) <= S.tol;
      const col = c == null ? '' : ok ? '#46d18a' : Math.abs(c) <= 100 ? '#f5b84a' : '#ff6b6b';
      tgt.current!.innerHTML = `Target <b>${noteName(t.midi, root)}</b>` + (c != null
        ? ` <span style="color:${col}">${c > 0 ? '+' : ''}${Math.round(c)}¢ ${ok ? '✓' : c > 0 ? '(sharp ↓)' : '(flat ↑)'}</span>` : '');
    } else tgt.current!.textContent = '';
  }), [getTarget]);

  return (
    <div className="readout">
      <div><div className="hint">You're singing</div><div className="ro-note" ref={note}>–</div></div>
      <div className="meter">
        <div className="zone" ref={zone} /><div className="mid" /><div className="needle" ref={needle} style={{ left: '50%' }} />
        <span className="lab" style={{ left: 0 }}>-50¢</span><span className="lab" style={{ left: '50%' }}>0</span><span className="lab" style={{ left: '100%' }}>+50¢</span>
      </div>
      <div className="ro-hz" ref={hz} />
      <div className="ro-target" ref={tgt} />
      <span className="sp" />
      <div className="hint">{hint}</div>
    </div>
  );
}
