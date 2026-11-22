/**
 * Measures how far the audio that was actually played is from where the app's clock says it is.
 *
 * Input: audio captured from the <audio> element in chunks, each tagged with the element's currentTime
 * when it arrived. The notes' pitch classes are matched against a chroma (pitch-class energy) analysis
 * of that audio at a range of offsets; the best-fitting offset is the sync error.
 *   offset ≈ 0      → in sync
 *   offset > 0      → the audio is later than the clock (notes on screen run ahead of the music)
 *   offset < 0      → the audio is earlier than the clock (notes run behind the music)
 */
export interface Capture { sr: number; chunks: { ct: number; d: number[] }[] }
export interface NoteLike { start: number; end: number; midi: number }

export function measureOffset(cap: Capture, notes: NoteLike[], search = 1.5) {
  const { sr } = cap, CH = cap.chunks[0]?.d.length ?? 0;
  if (cap.chunks.length < 10) throw new Error(`too little audio captured (${cap.chunks.length} chunks)`);
  const x = new Float32Array(cap.chunks.length * CH);
  cap.chunks.forEach((c, i) => x.set(c.d, i * CH));

  // sample index -> clock time (least squares over chunk ends)
  const pts = cap.chunks.map((c, i) => [(i + 1) * CH, c.ct] as const);
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const icpt = my - slope * mx;
  const clock = (sample: number) => icpt + slope * sample;

  // chroma per frame, vocal band
  const N = 8192, HOP = Math.round(sr / 100);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let b = 1; b < N / 2; b++) { const f = (b * sr) / N; if (f >= 120 && f <= 1100) binPc[b] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12; }
  const frames = Math.max(0, Math.floor((x.length - N) / HOP));
  const chroma = new Float32Array(frames * 12);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = x[f * HOP + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let tot = 0;
    for (let b = 1; b < N / 2; b++) { const pc = binPc[b]; if (pc < 0) continue; const m = Math.hypot(re[b], im[b]); chroma[f * 12 + pc] += m; tot += m; }
    if (tot > 0) for (let k = 0; k < 12; k++) chroma[f * 12 + k] /= tot;
  }
  const mean = new Float64Array(12);
  for (let f = 0; f < frames; f++) for (let k = 0; k < 12; k++) mean[k] += chroma[f * 12 + k] / frames;
  const t0 = clock(N / 2), dtF = slope * HOP;
  const frameAt = (t: number) => Math.round((t - t0) / dtF);
  const tEnd = clock(x.length);

  const used = notes.filter(n => n.start > t0 + search && n.end < tEnd - search);
  const score = (o: number) => {
    let s = 0, w = 0;
    for (const n of used) {
      const pc = ((n.midi % 12) + 12) % 12;
      for (let f = frameAt(n.start + o); f <= frameAt(n.end + o); f++) if (f >= 0 && f < frames) { s += chroma[f * 12 + pc] - mean[pc]; w++; }
    }
    return w ? s / w : -Infinity;
  };
  let offset = 0, best = -Infinity;
  for (let o = -search; o <= search + 1e-9; o += 0.01) { const s = score(o); if (s > best) { best = s; offset = o; } }
  return { offset: Math.round(offset * 100) / 100, notes: used.length, from: t0, to: tEnd };
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const h = i + k + len / 2, ur = re[i + k], ui = im[i + k];
        const vr = re[h] * cr - im[h] * ci, vi = re[h] * ci + im[h] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[h] = ur - vr; im[h] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
