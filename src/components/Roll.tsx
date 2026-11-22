import { useEffect, useRef } from 'react';
import { ensureAudio, live, onFrame, playNote } from '../audio/engine';
import { isBlack, noteName, pc } from '../lib/notes';
import { scoreColor, starCount } from '../lib/exercises';
import { getS } from '../lib/settings';
import { smoothTrace, traceJoins } from '../lib/trace';

export type TraceClass = 'good' | 'warn' | 'bad' | 'none' | 'listen';
export interface TracePoint { t: number; m: number | null; c: TraceClass }
export interface RollNote {
  start: number; end: number; midi: number;
  kind: 'listen' | 'sing' | 'golden' | 'free' | 'rap';
  text?: string;               // lyric syllable (karaoke)
  score?: number | null;       // 0..1 once finished
  active?: boolean;
  /** UltraStar-style progress: stretches sung in tune fill the bar; off-pitch stretches draw a small bar at the sung note. */
  hits?: [number, number][];
  misses?: [number, number, number][];
}
export interface Scene {
  t: number;                   // current time on the roll (seconds)
  notes: RollNote[];
  trace: TracePoint[];
  viewLo: number; viewHi: number;   // may be fractional for smooth scrolling
  pps: number;                 // pixels per second
  playhead?: number;           // 0..1 of the plot width
  inputLag?: number;           // seconds the mic lags the music: live pitch marker is drawn this far behind the playhead
  hideTrace?: boolean;         // don't draw the sung-pitch line (karaoke Perform mode)
  subtleMarker?: boolean;      // smaller, fainter live pitch dot
  clearRows?: boolean;         // no row stripes, so a background video shows through
  /** where to draw the live pitch dot instead of the measured pitch (e.g. snapped to the note bar); null = hide */
  markerMidi?: number | null;
  root: number | null;
  title: string;
  phase?: string;
  activeMidi: number | null;
  currentClass?: TraceClass;
  paused?: boolean;
  result?: number | null;      // big round score overlay
  waiting?: boolean;
}

const KW = 82, TOP = 38, BOT = 10;
/** Opacity of the grey part of the pitch line (sung while there's no note to sing). */
const NONE_ALPHA = 0.3;
const TC: Record<TraceClass, string> ={ good: '#46d18a', warn: '#f5b84a', bad: '#ff6b6b', none: '#c9cfdd', listen: '#5d6478' };

function rr(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}

/** Scrolling piano-roll: target note boxes (with note names), your pitch trace, and a note-name strip. */
export type ScrubPhase = 'start' | 'move' | 'end';

export default function Roll({ getScene, onScrub, children }: {
  getScene: () => Scene | null;
  /** drag on the note area: `dt` is seconds moved since the drag started (drag left = later);
   *  a plain click ends with `dt` = offset of the clicked spot from the playhead */
  onScrub?: (dt: number, phase: ScrubPhase) => void;
  children?: React.ReactNode;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const sceneRef = useRef<Scene | null>(null);
  const drag = useRef<{ x: number; pps: number; id: number; moved: boolean } | null>(null);

  useEffect(() => {
    const cv = cvRef.current!;
    const ro = new ResizeObserver(() => {
      const r = cv.parentElement!.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      cv.width = Math.round(r.width * d);
      cv.height = Math.round(r.height * d);
    });
    ro.observe(cv.parentElement!);
    const off = onFrame(() => {
      const sc = getScene();
      sceneRef.current = sc;
      draw(cv, sc, size.current.w, size.current.h);
    });
    return () => { ro.disconnect(); off(); };
  }, [getScene]);

  const onDown = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sc = sceneRef.current;
    if (!sc || e.button !== 0) return;
    const b = cvRef.current!.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    if (x > KW) {
      if (!onScrub || !sc.pps) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, pps: sc.pps, id: e.pointerId, moved: false };
      onScrub(0, 'start');
      return;
    }
    const rowH = (size.current.h - TOP - BOT) / (sc.viewHi - sc.viewLo + 1);
    const m = Math.round(sc.viewHi + 0.5 - (y - TOP) / rowH - 0.5);
    await ensureAudio(false);
    playNote(m, 0.9);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
    if (d.moved) onScrub?.((d.x - e.clientX) / d.pps, 'move');
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved && e.type === 'pointerup') {
      // a click (no drag): jump so the clicked spot is under the playhead
      const sc = sceneRef.current, b = cvRef.current!.getBoundingClientRect(), W = size.current.w;
      const ph = KW + (W - KW) * (sc?.playhead ?? 0.3);
      onScrub?.((e.clientX - b.left - ph) / d.pps, 'end');
    } else onScrub?.((d.x - e.clientX) / d.pps, 'end');
  };

  return (
    <div className="cwrap">
      {children}
      <canvas ref={cvRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={onScrub ? { cursor: 'grab', touchAction: 'none' } : undefined} />
    </div>
  );
}

function draw(cv: HTMLCanvasElement, sc: Scene | null, W: number, H: number) {
  const cx = cv.getContext('2d')!;
  const d = window.devicePixelRatio || 1;
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.clearRect(0, 0, W, H);
  if (!sc || !W) return;
  const pitch = live.shown; // smoothed for display (Settings → Pitch line smoothing)
  const lo = sc.viewLo, hi = sc.viewHi;
  const rowH = (H - TOP - BOT) / (hi - lo + 1);
  const Y = (m: number) => TOP + (hi - m + 0.5) * rowH;
  const ph = KW + (W - KW) * (sc.playhead ?? 0.3);
  const X = (t: number) => ph + (t - sc.t) * sc.pps;
  const mLo = Math.floor(lo - 1), mHi = Math.ceil(hi + 1);

  // rows
  cx.save();
  cx.beginPath(); cx.rect(KW, TOP - 2, W - KW, H - TOP - BOT + 4); cx.clip();
  for (let m = mLo; m <= mHi; m++) {
    const y = Y(m) - rowH / 2;
    if (!sc.clearRows) {
      cx.fillStyle = isBlack(m) ? 'rgba(18,21,29,0.82)' : 'rgba(22,26,36,0.82)';
      cx.fillRect(KW, y, W - KW, rowH);
    }
    if (pc(m) === 0) { cx.fillStyle = '#2b3042'; cx.fillRect(KW, y + rowH - 1, W - KW, 1); }
  }
  if (sc.activeMidi != null) { cx.fillStyle = 'rgba(110,168,255,0.08)'; cx.fillRect(KW, Y(sc.activeMidi) - rowH / 2, W - KW, rowH); }

  // notes
  const fs = Math.max(10, Math.min(15, rowH * 0.62));
  for (const n of sc.notes) {
    const x1 = X(n.start), x2 = X(n.end);
    if (x2 < KW || x1 > W) continue;
    const y = Y(n.midi) - rowH * 0.46, h = rowH * 0.92, w = Math.max(3, x2 - x1);
    let fill: string, stroke: string, dash: number[] = [];
    const done = n.score != null;
    if (n.kind === 'listen') { fill = 'rgba(110,168,255,0.16)'; stroke = '#6ea8ff'; dash = [5, 4]; }
    else if (n.kind === 'free') { fill = 'rgba(255,255,255,0.05)'; stroke = '#6b7286'; dash = [3, 3]; }
    else if (done) { const c = scoreColor(n.score!); fill = c + '55'; stroke = c; }
    else if (n.active) { fill = n.kind === 'golden' ? 'rgba(255,209,102,0.45)' : 'rgba(110,168,255,0.38)'; stroke = n.kind === 'golden' ? '#ffd166' : '#9cc4ff'; }
    else { fill = n.kind === 'golden' ? 'rgba(255,209,102,0.18)' : 'rgba(255,255,255,0.10)'; stroke = n.kind === 'golden' ? '#ffd166' : '#aab2c5'; }
    rr(cx, x1, y, w, h, Math.min(6, h / 2));
    cx.fillStyle = fill; cx.fill();
    if (n.hits?.length) {
      // fill the bar wherever it was sung in tune (clipped to the bar's rounded shape)
      cx.save(); cx.clip();
      cx.fillStyle = n.kind === 'golden' ? '#ffd166' : '#46d18a';
      for (const [a, b] of n.hits) { const fa = X(a), fb = X(b); cx.fillRect(fa, y, Math.max(1, fb - fa), h); }
      cx.restore();
      rr(cx, x1, y, w, h, Math.min(6, h / 2));
    }
    cx.setLineDash(dash); cx.lineWidth = n.active ? 2 : 1.2; cx.strokeStyle = stroke; cx.stroke(); cx.setLineDash([]);
    if (n.misses?.length) {
      // off-pitch singing: small bars at the note actually sung
      const mh = h * 0.5;
      for (const [a, b, m] of n.misses) {
        const fa = X(a), fb = X(b);
        if (fb - fa < 1) continue;
        cx.fillStyle = Math.abs(m - n.midi) <= 1 ? 'rgba(245,184,74,0.75)' : 'rgba(255,107,107,0.75)';
        rr(cx, fa, Y(m) - mh / 2, fb - fa, mh, mh / 2); cx.fill();
      }
    }
    if (n.kind !== 'listen') {
      cx.strokeStyle = 'rgba(255,255,255,0.18)';
      cx.beginPath(); cx.moveTo(x1 + 2, Y(n.midi)); cx.lineTo(x2 - 2, Y(n.midi)); cx.stroke();
    }
  }

  // pitch trace
  cx.lineWidth = 3; cx.lineCap = 'round'; cx.lineJoin = 'round';
  const tr = sc.trace;
  const ys = smoothTrace(tr, getS().traceSmoothMs / 1000);
  // Each run of same-coloured, connected points is stroked as ONE path: stroking every tiny segment
  // separately overlaps their round ends, which shows up as darker blotches on translucent lines.
  let open: TraceClass | null = null;
  const flush = () => {
    if (open == null) return;
    cx.strokeStyle = TC[open] || TC.none;
    cx.globalAlpha = open === 'none' || !TC[open] ? NONE_ALPHA : 1; // grey (no target note) stays in the background
    cx.stroke();
    open = null;
  };
  for (let i = 1; i < (sc.hideTrace ? 0 : tr.length); i++) {
    const a = tr[i - 1], b = tr[i];
    const xa = X(a.t), xb = X(b.t);
    if (!traceJoins(a, b) || xb < KW - 5 || xa > W) { flush(); continue; }
    if (open !== b.c) { flush(); cx.beginPath(); cx.moveTo(xa, Y(ys[i - 1])); open = b.c; }
    cx.lineTo(xb, Y(ys[i]));
  }
  flush();
  cx.globalAlpha = 1;

  // note labels go on top of the pitch line (boxes are drawn underneath it); a thin dark outline
  // keeps them readable where the line crosses
  const label = (s: string, x: number, y: number, max: number, color: string) => {
    cx.lineWidth = 3; cx.lineJoin = 'round'; cx.strokeStyle = 'rgba(15,17,23,0.75)';
    cx.strokeText(s, x, y, max);
    cx.fillStyle = color; cx.fillText(s, x, y, max);
  };
  for (const n of sc.notes) {
    const x1 = X(n.start), x2 = X(n.end);
    if (x2 < KW || x1 > W) continue;
    const y = Y(n.midi) - rowH * 0.46, h = rowH * 0.92, w = Math.max(3, x2 - x1);
    if (w > 14) {
      cx.font = `600 ${fs}px system-ui,sans-serif`; cx.textBaseline = 'middle';
      label(noteName(n.midi, sc.root), x1 + 6, Y(n.midi), Math.max(8, w - 9), '#fff');
    }
    if (n.text && n.text.trim() && n.text.trim() !== '~') {
      cx.font = '500 12px system-ui,sans-serif'; cx.textBaseline = 'top';
      label(n.text.trim(), x1 + 2, y + h + 2, Math.max(30, w + 30), n.kind === 'golden' ? '#ffd166' : '#c9cfdd');
    }
    if (n.score != null && n.kind !== 'listen' && n.kind !== 'free' && w > 18) {
      cx.font = '600 11px system-ui'; cx.textBaseline = 'middle';
      label(Math.round(n.score * 100) + '%', x1 + 3, y - 7, 1000, scoreColor(n.score));
    }
  }
  cx.globalAlpha = 1;
  cx.restore();

  // playhead
  cx.fillStyle = 'rgba(255,255,255,0.35)';
  cx.fillRect(ph - 1, TOP - 6, 2, H - TOP - BOT + 6);

  // note-name strip
  cx.save();
  cx.beginPath(); cx.rect(0, TOP, KW, H - TOP - BOT); cx.clip();
  for (let m = mLo; m <= mHi; m++) {
    const y = Y(m) - rowH / 2, bl = isBlack(m);
    const sung = pitch != null && Math.round(pitch) === m, tgt = sc.activeMidi === m;
    cx.fillStyle = sung ? '#6ea8ff' : tgt ? '#34405e' : bl ? '#232838' : '#d9dde7';
    cx.fillRect(0, y, KW - 2, rowH - 1);
    cx.fillStyle = sung ? '#0b1020' : bl || tgt ? '#c9cfdd' : '#1a1f2b';
    cx.font = `${pc(m) === 0 || sung || tgt ? '700' : '500'} ${Math.max(9, Math.min(13, rowH * 0.6))}px system-ui,sans-serif`;
    cx.textBaseline = 'middle';
    if (rowH >= 9 || pc(m) === 0) cx.fillText(noteName(m, sc.root), 6, y + rowH / 2, KW - 12);
  }
  cx.restore();

  // current pitch marker (at the time the sound was actually sung)
  const mk = sc.markerMidi !== undefined ? sc.markerMidi : pitch;
  if (mk != null) {
    const px = Math.max(KW + 8, ph - (sc.inputLag ?? 0) * sc.pps);
    const col = sc.activeMidi != null ? TC[sc.currentClass ?? 'none'] : '#6ea8ff';
    let y = Y(mk);
    const off = y < TOP ? -1 : y > H - BOT ? 1 : 0;
    y = Math.max(TOP, Math.min(H - BOT, y));
    cx.fillStyle = col;
    if (sc.subtleMarker) {
      // small, translucent dot with no label: enough to see where you are without drawing the eye
      cx.globalAlpha = 0.5;
      if (off) { cx.beginPath(); cx.moveTo(px - 5, y - off * 2); cx.lineTo(px + 5, y - off * 2); cx.lineTo(px, y - off * 10); cx.closePath(); cx.fill(); }
      else { cx.beginPath(); cx.arc(px, y, 4, 0, 7); cx.fill(); }
      cx.globalAlpha = 1;
    } else {
      if (off) { cx.beginPath(); cx.moveTo(px - 8, y - off * 2); cx.lineTo(px + 8, y - off * 2); cx.lineTo(px, y - off * 14); cx.closePath(); cx.fill(); }
      else { cx.beginPath(); cx.arc(px, y, 7, 0, 7); cx.fill(); }
      const lab = noteName(mk, sc.root);
      cx.font = '700 13px system-ui';
      const tw = cx.measureText(lab).width;
      rr(cx, px + 12, y - 11, tw + 12, 22, 6);
      cx.fillStyle = 'rgba(15,17,23,0.85)'; cx.fill();
      cx.fillStyle = col; cx.textBaseline = 'middle'; cx.fillText(lab, px + 18, y);
    }
  }

  // header
  cx.textBaseline = 'middle'; cx.font = '600 14px system-ui'; cx.fillStyle = '#8d93a6';
  cx.fillText(sc.title, KW + 12, 19, W - KW - 220);
  if (sc.phase) {
    cx.font = '700 16px system-ui'; cx.fillStyle = '#e8eaf0'; cx.textAlign = 'right';
    cx.fillText(sc.phase, W - 14, 19); cx.textAlign = 'left';
  }
  if (sc.paused) {
    cx.fillStyle = 'rgba(0,0,0,0.45)'; cx.fillRect(KW, TOP, W - KW, H - TOP);
    cx.fillStyle = '#fff'; cx.font = '700 26px system-ui'; cx.textAlign = 'center';
    cx.fillText('Paused', (W + KW) / 2, H / 2); cx.textAlign = 'left';
  }
  if (sc.result != null) {
    const s = sc.result, mx = (W + KW) / 2;
    cx.fillStyle = 'rgba(15,17,23,0.78)'; rr(cx, mx - 110, H / 2 - 55, 220, 110, 14); cx.fill();
    cx.textAlign = 'center'; cx.fillStyle = scoreColor(s); cx.font = '800 40px system-ui';
    cx.fillText(Math.round(s * 100) + '%', mx, H / 2 - 12);
    const st = starCount(s);
    cx.font = '24px system-ui'; cx.fillStyle = '#f5b84a';
    cx.fillText('★'.repeat(st) + '☆'.repeat(3 - st), mx, H / 2 + 28);
    cx.textAlign = 'left';
  }
}
