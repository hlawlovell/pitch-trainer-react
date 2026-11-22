"""Fit a reference melody played at another tempo (a piano cover, a Synthesia video) onto the
recording's timeline.

  python -X utf8 -m kengine.warp bench/wurenzhidao/synthesia.mid bench/wurenzhidao/work/pitch.json \
      bench/wurenzhidao/reference.mid [--csv check.csv]

How: both are turned into pitch-class sequences every 50 ms (the melody's notes; the singer's pitch
track from the separated vocals) and lined up with dynamic time warping (DTW). Each reference note's
start and end are moved through that map. Notes that land where nobody sings (piano intro,
interludes, endings) are dropped. Pitches are kept exactly as the arranger wrote them.

Caveat: the timing then comes from the singer's pitch track, which the engine also uses, so a
reference made this way checks pitch and note splitting independently but timing only loosely.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import score

HOP = 0.05


def melody_chroma(notes, n: int) -> np.ndarray:
    c = np.zeros((n, 13))
    c[:, 12] = 1  # silence
    for nt in notes:
        a, b = int(nt.start / HOP), max(int(nt.start / HOP) + 1, int(nt.end / HOP))
        c[a:b, :] = 0
        c[a:b, nt.midi % 12] = 1
    return c


def vocal_chroma(pitch: dict, n: int, shift: int, conf_min: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    t = np.asarray(pitch['times'])
    f = np.asarray(pitch['frequencies'], float)
    cf = np.asarray(pitch['confidence'], float)
    voiced = (f > 0) & (cf >= conf_min)
    midi = np.where(voiced, 69 + 12 * np.log2(np.maximum(f, 1e-6) / 440), np.nan)
    c = np.zeros((n, 13))
    v = np.zeros(n)
    idx = np.minimum((t / HOP).astype(int), n - 1)
    for i in range(n):
        sel = midi[idx == i]
        sel = sel[~np.isnan(sel)]
        if len(sel) < 2:
            c[i, 12] = 1
            continue
        v[i] = 1
        m = np.median(sel) + shift
        pc = m % 12
        lo = int(np.floor(pc)) % 12
        w = pc - np.floor(pc)
        c[i, lo] += 1 - w
        c[i, (lo + 1) % 12] += w
    return c, v


def key_shift(notes, pitch: dict) -> int:
    """Semitones to add to the singer's pitch to reach the reference's key (pitch-class histograms)."""
    h_ref = np.zeros(12)
    for nt in notes:
        h_ref[nt.midi % 12] += nt.end - nt.start
    f = np.asarray(pitch['frequencies'], float)
    cf = np.asarray(pitch['confidence'], float)
    m = 69 + 12 * np.log2(f[(f > 0) & (cf >= 0.5)] / 440)
    h_voc = np.bincount(np.round(m).astype(int) % 12, minlength=12).astype(float)
    best = max(range(12), key=lambda s: float(np.dot(np.roll(h_voc, s), h_ref)))
    return best if best <= 6 else best - 12


def fit(ref_notes, pitch: dict):
    shift = key_shift(ref_notes, pitch)
    n_ref = int(max(nt.end for nt in ref_notes) / HOP) + 2
    n_voc = int(pitch['times'][-1] / HOP) + 2
    A = melody_chroma(ref_notes, n_ref)
    B, voiced = vocal_chroma(pitch, n_voc, shift)
    # cost: 1 - cosine similarity
    An = A / np.linalg.norm(A, axis=1, keepdims=True)
    Bn = B / np.maximum(np.linalg.norm(B, axis=1, keepdims=True), 1e-9)
    C = 1 - An @ Bn.T
    import librosa
    _, wp = librosa.sequence.dtw(C=C, step_sizes_sigma=np.array([[1, 1], [1, 2], [2, 1], [1, 0], [0, 1]]),
                                 weights_add=np.array([0, 0, 0, 0.3, 0.3]), backtrack=True)
    wp = wp[::-1]
    # reference frame → recording frame (mean over the path), monotone
    m = np.full(n_ref, np.nan)
    for i in range(n_ref):
        js = wp[wp[:, 0] == i, 1]
        if len(js):
            m[i] = js.mean()
    ok = ~np.isnan(m)
    m = np.interp(np.arange(n_ref), np.where(ok)[0], m[ok])
    m = np.maximum.accumulate(m)
    # Smooth: DTW wobbles note by note, which would snap reference notes onto the singer's notes.
    # Keep one tempo for the whole song and only let each phrase (notes separated by a rest)
    # take its own offset from the map.
    x = np.arange(n_ref)
    has = A[:, 12] == 0
    slope = np.polyfit(x[has], m[has], 1)[0]
    phrases, cur = [], [ref_notes[0]]
    for nt in ref_notes[1:]:
        # a new phrase after a rest, or after a long held note (pickups before a chorus otherwise
        # drag the whole chorus with them)
        if nt.start - cur[-1].end > 0.45 or (cur[-1].end - cur[-1].start >= 0.8 and len(cur) > 1):
            phrases.append(cur); cur = []
        cur.append(nt)
    phrases.append(cur)
    # the singer's pitch every 10 ms, folded to one octave, for the fine search
    f = np.asarray(pitch['frequencies'], float)
    cf = np.asarray(pitch['confidence'], float)
    sung = np.where((f > 0) & (cf >= 0.5), 69 + 12 * np.log2(np.maximum(f, 1e-6) / 440) + shift, np.nan)
    pt = np.asarray(pitch['times'], float)

    def agree(ph, off):
        hit = tot = 0.0
        for nt in ph:
            s, e = slope * nt.start / HOP * HOP + off, slope * nt.end / HOP * HOP + off
            i0, i1 = np.searchsorted(pt, s), np.searchsorted(pt, e)
            seg = sung[i0:i1]
            tot += len(seg)
            d = np.abs(((seg - nt.midi) + 6) % 12 - 6)
            hit += np.count_nonzero(d[~np.isnan(d)] < 0.5)
        return hit / tot if tot else 0.0

    knots = []  # (reference s, offset s)
    for ph in phrases:
        a, b = int(ph[0].start / HOP), int(ph[-1].end / HOP) + 1
        off = float(np.median(m[a:b] - slope * x[a:b])) * HOP
        cands = off + np.arange(-1.0, 1.0001, 0.02)
        scores = [agree(ph, c) for c in cands]
        best = max(scores)
        # prefer the DTW offset unless the search finds clearly better agreement
        if best > agree(ph, off) + 0.05:
            off = float(cands[int(np.argmax(scores))])
        knots.append((ph[0].start, off))
    starts = np.array([k[0] for k in knots])
    offs = np.array([k[1] for k in knots])

    def to_rec(t):
        i = max(0, int(np.searchsorted(starts, t + 1e-6)) - 1)
        return float(slope * t + offs[i])

    out, dropped = [], 0
    for nt in ref_notes:
        s, e = to_rec(nt.start), to_rec(nt.end)
        a, b = int(s / HOP), max(int(s / HOP) + 1, int(e / HOP))
        if e - s < 0.03 or voiced[a:b].mean() < 0.3:
            dropped += 1
            continue
        out.append(score.Note(s, e, nt.midi))
    return out, shift, dropped, (lambda t: to_rec(t))


def write_midi(notes, path: Path):
    import mido
    mf = mido.MidiFile(ticks_per_beat=480)
    tr = mido.MidiTrack()
    tr.append(mido.MetaMessage('set_tempo', tempo=500000, time=0))
    ev = []
    for n in notes:
        ev.append((round(n.start * 960), 1, n.midi))
        ev.append((max(round(n.end * 960) - 1, round(n.start * 960) + 1), 0, n.midi))
    ev.sort(key=lambda e: (e[0], e[1]))
    now = 0
    for t, on, m in ev:
        tr.append(mido.Message('note_on' if on else 'note_off', note=m, velocity=80 if on else 0, time=t - now))
        now = t
    mf.tracks.append(tr)
    mf.save(str(path))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('melody', help='MIDI played at another tempo (melody = highest track, top voice)')
    ap.add_argument('pitch', help="the recording's pitch.json (from the engine's work folder)")
    ap.add_argument('out')
    ap.add_argument('--csv', help='write the time map (reference s → recording s) for checking')
    a = ap.parse_args(argv)
    ref = score.read_midi(a.melody).notes
    pitch = json.loads(Path(a.pitch).read_text(encoding='utf-8'))
    out, shift, dropped, to_rec = fit(ref, pitch)
    write_midi(out, Path(a.out))
    print(f'key shift {shift:+d} semitones; {len(out)} notes kept, {dropped} dropped (no singing there); '
          f'{out[0].start:.1f}–{out[-1].end:.1f}s')
    if a.csv:
        with open(a.csv, 'w', encoding='utf-8') as f:
            f.write('reference_s,recording_s\n')
            for t in np.arange(0, ref[-1].end, 1.0):
                f.write(f'{t:.1f},{to_rec(t):.2f}\n')


if __name__ == '__main__':
    main()
