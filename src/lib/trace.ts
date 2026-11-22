/** Display smoothing for the sung pitch (the pitch line, the live pitch dot and the tuner needle). */

export interface TracePt { t: number; m: number | null }

/** Pitch changes bigger than this between frames are treated as a new note (or a glitch), never smoothed over. */
export const JUMP = 1.5;

/** Whether two consecutive trace points are drawn connected (no gap in voice, time or a big pitch jump). */
export const traceJoins = (a: TracePt, b: TracePt) =>
  a.m != null && b.m != null && b.t >= a.t && b.t - a.t <= 0.2 && Math.abs(a.m - b.m) <= JUMP;

/**
 * One step of the display smoothing: an exponential moving average with time constant `tau` seconds.
 * It only looks backwards, so the newest point is as steady as the rest and nothing moves after it's
 * drawn. Restarts (no smoothing) after silence or a jump, so note changes stay sharp.
 */
export function smoothStep(prev: number | null, m: number | null, dt: number, tau: number): number | null {
  if (m == null) return null;
  if (prev == null || tau <= 0 || dt <= 0 || dt > 0.2 || Math.abs(m - prev) > JUMP) return m;
  return prev + (m - prev) * (1 - Math.exp(-dt / tau));
}

/** Smoothed y value (fractional MIDI, NaN where silent) for every point of the pitch line. Display only. */
export function smoothTrace(tr: TracePt[], tau: number): number[] {
  const ys: number[] = new Array(tr.length);
  let prev: number | null = null;
  for (let i = 0; i < tr.length; i++) {
    const p = tr[i];
    const joined = i > 0 && traceJoins(tr[i - 1], p);
    prev = smoothStep(joined ? prev : null, p.m, joined ? p.t - tr[i - 1].t : 0, tau);
    ys[i] = prev ?? NaN;
  }
  return ys;
}
