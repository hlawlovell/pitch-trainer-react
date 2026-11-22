import { useEffect, useMemo, useRef, useState } from 'react';
import { ensureAudio, lastPlayed, live, onFrame, onNotePlayed, playNote } from '../audio/engine';
import { isBlack, noteName, pc } from '../lib/notes';
import { useSettings } from '../lib/settings';

/** Shared "what should the singer hit right now" so the piano can mark it. */
export const pianoTarget = { midi: null as number | null };
(window as any).__ptTarget = pianoTarget; // read by tests

const LOW = 36, HIGH = 96; // C2–C7

/**
 * Piano keyboard across the top of the app.
 * Green = the note the app just played (also shown in the green button), blue = the note you're singing.
 */
export default function TopPiano() {
  const S = useSettings();
  const keyEls = useRef<Record<number, HTMLDivElement | null>>({});
  const playedPill = useRef<HTMLButtonElement>(null);
  const sungPill = useRef<HTMLDivElement>(null);
  const [lastNote, setLastNote] = useState<number | null>(null);

  const layout = useMemo(() => {
    const whites: number[] = [];
    for (let m = LOW; m <= HIGH; m++) if (!isBlack(m)) whites.push(m);
    const ww = 100 / whites.length;
    const pos: Record<number, { left: number; width: number; black: boolean }> = {};
    whites.forEach((m, i) => (pos[m] = { left: i * ww, width: ww, black: false }));
    for (let m = LOW; m <= HIGH; m++) if (isBlack(m)) pos[m] = { left: pos[m - 1].left + ww * 0.68, width: ww * 0.64, black: true };
    return pos;
  }, []);

  useEffect(() => onNotePlayed(n => setLastNote(n.midi)), []);

  useEffect(() => {
    let prevPlayed = -1, prevSung = -1, prevTarget = -1;
    return onFrame(() => {
      const now = performance.now() / 1000;
      const played = lastPlayed && lastPlayed.until > now ? lastPlayed.midi : -1;
      const sung = live.shown != null ? Math.round(live.shown) : -1;
      const target = pianoTarget.midi ?? -1;
      if (played !== prevPlayed) {
        keyEls.current[prevPlayed]?.classList.remove('played');
        keyEls.current[played]?.classList.add('played');
        playedPill.current?.classList.toggle('on', played >= 0);
        prevPlayed = played;
      }
      if (sung !== prevSung) {
        keyEls.current[prevSung]?.classList.remove('sung');
        keyEls.current[sung]?.classList.add('sung');
        if (sungPill.current) {
          sungPill.current.classList.toggle('on', sung >= 0);
          sungPill.current.firstChild!.textContent = sung >= 0 ? noteName(sung) : '–';
        }
        prevSung = sung;
      }
      if (target !== prevTarget) {
        keyEls.current[prevTarget]?.classList.remove('target');
        keyEls.current[target]?.classList.add('target');
        prevTarget = target;
      }
    });
  }, []);

  const press = async (m: number) => {
    await ensureAudio(false);
    playNote(m, 1.0);
  };

  return (
    <div className="toppiano">
      <div className="tp-pills">
        <button ref={playedPill} className={'pill played' + (lastNote != null ? ' has' : '')} title="Last note played, click to hear it again"
          onClick={() => lastNote != null && press(lastNote)}>
          <span>{lastNote != null ? noteName(lastNote) : '–'}</span><small>♪ played</small>
        </button>
        <div ref={sungPill} className="pill sung" title="The note you're singing"><span>–</span><small>🎤 you</small></div>
      </div>
      <div className="keys">
        {Object.entries(layout).map(([k, p]) => {
          const m = +k;
          const inRange = m >= S.lo && m <= S.hi;
          const label = p.black ? noteName(m).replace(/\d+$/, '') : pc(m) === 0 || S.naming !== 'letter' ? noteName(m) : noteName(m).replace(/\d+$/, '');
          return (
            <div key={m} ref={el => { keyEls.current[m] = el; }}
              className={`key ${p.black ? 'b' : 'w'}${inRange ? ' inrange' : ''}${pc(m) === 0 ? ' c' : ''}`}
              style={{ left: p.left + '%', width: p.width + '%' }}
              title={noteName(m)} onMouseDown={() => press(m)}>
              {label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
