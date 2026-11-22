"""What went wrong: break a song's score down so the next change can target it.

  python -m kengine.diagnose spring-day [--lines 6]

Prints: pitch errors by size and direction, what the missing singing looks like (whole lines vs
gaps inside lines), extra notes, and the worst lyric lines with generated vs correct notes.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np

from . import score

BENCH = Path(__file__).resolve().parent.parent / 'bench'
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
nm = lambda m: f'{NAMES[m % 12]}{m // 12 - 1}'


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('song')
    ap.add_argument('--lines', type=int, default=5)
    a = ap.parse_args(argv)
    d = BENCH / a.song
    cfg = json.loads((d / 'song.json').read_text(encoding='utf-8'))
    gen = score.read(d / 'work' / 'song.txt')
    ref = score.read(d / cfg['reference'])
    res = score.score(gen, ref, cfg.get('transpose', False))
    off, key = res['offset'], res['key']
    print(json.dumps(res))
    step = 0.01
    end = max(gen.notes[-1].end, ref.notes[-1].end) + 25
    G, R = score.grid(gen.notes, step, end), score.grid(ref.notes, step, end)
    k = int(round(off / step))
    a_, b_ = (G[: len(G) - k] if k else G, R[k:]) if k >= 0 else (G[-k:], R[: len(R) + k])
    n = min(len(a_), len(b_)); g, r = a_[:n], b_[:n]   # g[i]: generated at reference time i*step
    both = (g > -1000) & (r > -1000)
    d_ = (g - r - key)[both]
    sizes = Counter(int(x) for x in d_ if x != 0)
    tot = len(d_)
    print('\npitch errors (share of time where both sing):')
    for sz, c in sorted(sizes.items(), key=lambda kv: -kv[1])[:8]:
        print(f'  {sz:+3d} semitones: {100 * c / tot:5.1f}%')
    # missing singing: runs where the reference sings and we have nothing
    miss = (r > -1000) & (g <= -1000)
    runs, i = [], 0
    while i < n:
        if miss[i]:
            j = i
            while j < n and miss[j]: j += 1
            runs.append((i * step, (j - i) * step)); i = j
        else:
            i += 1
    long_ = [x for x in runs if x[1] >= 1.0]
    print(f'\nmissing singing: {sum(x[1] for x in runs):.1f}s in {len(runs)} gaps; '
          f'{sum(x[1] for x in long_):.1f}s in {len(long_)} gaps of 1s+ at ' + ', '.join(f'{t:.0f}s' for t, _ in long_[:10]))
    extra = (g > -1000) & (r <= -1000)
    print(f'extra singing: {extra.sum() * step:.1f}s')
    # worst lines
    lines, cur = [], []
    for nt in ref.notes:
        if nt.line_start and cur: lines.append(cur); cur = []
        cur.append(nt)
    if cur: lines.append(cur)
    scored = []
    for ln in lines:
        i0, i1 = int(ln[0].start / step), int(ln[-1].end / step)
        bb = both[i0:i1]; dd = (g[i0:i1] - r[i0:i1] - key)
        ok = np.count_nonzero(bb & (dd == 0)); sung = np.count_nonzero(r[i0:i1] > -1000)
        scored.append((ok / max(1, sung), ln))
    scored.sort(key=lambda x: x[0])
    print(f'\nworst {a.lines} lines (reference time; generated notes shifted onto it):')
    for acc, ln in scored[: a.lines]:
        t0, t1 = ln[0].start, ln[-1].end
        words = ''.join(x.text for x in ln).replace('~', '').strip()
        print(f'  {t0:6.1f}s {100 * acc:3.0f}% "{words[:60]}"')
        print('     correct:   ' + ' '.join(f'{nm(x.midi)}' for x in ln))
        gl = [x for x in gen.notes if t0 - 0.2 <= x.start + off <= t1 + 0.2]
        print('     generated: ' + ' '.join(f'{nm(x.midi - key)}' for x in gl))


if __name__ == '__main__':
    main()
