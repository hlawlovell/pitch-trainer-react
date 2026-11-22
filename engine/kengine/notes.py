"""Notes from the sung pitch, and syllables placed on them.

1. pitch_notes: clean the pitch track (confident frames, median-smoothed, octave glitches folded
   back) and cut it into notes wherever the voice settles on a new pitch, or stops.
2. place: fit the syllables onto those notes in order (dynamic programming on their aligned start
   times); notes between two syllables continue the earlier one ("~", a syllable over several notes).
3. ultrastar: write the UltraStar file.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

HAN = re.compile(r'[㐀-鿿豈-﫿]')

DEFAULTS = dict(conf=0.5, fold=8, fold_win=1.0, stop=0.05, settle=0.05, jump=0.7, min_note=0.08,
                skip=0.04, share=0.25, share_zh=1.0, cap=2.0, low_score_weight=0.3, melisma_gap=1.0,
                align_bias=0.09, approach_max=0.0, approach_ratio=1.5, approach_span=3,
                scoop_max=0.18, scoop_gap=0.05, tune_min=0.15, glide_max=0.0, glide_min=3, pitch_of=1, key_prior=0.2, chroma_max=0.25, chroma_rare=0.15,
                fit_coarse=0, fit_fine=0)
# pitch_of: 0 median of frames, 1 most common semitone, 2 median of steady frames; tune_min: correct
# tuning beyond 15 cents; approach_max: scoop rule before placing syllables (try 1); scoop_max: after
# (try 2); fit_coarse/fit_fine: lyric lines used to find the lyrics' time shift (0 = all; sampling a
# few lines let a repeated chorus win at the wrong shift: I Need U, Eyes Nose Lips)


@dataclass
class Syl:
    t: float            # start (s), from forced alignment
    text: str           # as shown, incl. a leading space for a new word
    line: bool = False  # starts a lyric line
    weight: float = 1.0 # how much to trust t


def _med(v):
    v = sorted(v); n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def tuning(hz, conf, min_conf=0.5) -> float:
    """How far (in semitones, -0.5..0.5) the recording sits from standard A=440 tuning: the circular
    mean of where sung pitches fall between semitones. (The Scientist: +0.33, so rounding to the
    nearest semitone flipped between neighbours; most recordings are within ±0.05.)"""
    hz, conf = np.asarray(hz), np.asarray(conf)
    m = 69 + 12 * np.log2(hz[(hz > 0) & (conf >= min_conf)] / 440)
    if len(m) < 100:
        return 0.0
    v = np.mean(np.exp(2j * np.pi * (m % 1)))
    return float(np.angle(v) / (2 * np.pi))


def note_pitch(f: list, how: int) -> int:
    """A note's semitone from its frames. Short notes in fast passages carry the glide into the next
    note in their frames, which pulls the median a semitone off; the most common semitone (1) or the
    median of the steady frames (2) ignore it."""
    if how == 1 and len(f) >= 3:
        r = [round(v) for v in f]
        cnt = {}
        for v in r:
            cnt[v] = cnt.get(v, 0) + 1
        top = max(cnt.values())
        best = [v for v, c in cnt.items() if c == top]
        return min(best, key=lambda v: abs(v - _med(f)))
    if how == 2 and len(f) >= 5:
        steady = [f[i] for i in range(1, len(f) - 1) if abs(f[i + 1] - f[i - 1]) < 0.3]
        if len(steady) >= 3:
            return round(_med(steady))
    return round(_med(f))


def pitch_notes(times, hz, conf, o) -> list[dict]:
    T = list(map(float, times))
    tune = tuning(hz, conf, o['conf'])
    if abs(tune) < o['tune_min']:
        tune = 0.0
    x = [69 + 12 * math.log2(f / 440) - tune if f > 0 and c >= o['conf'] else None for f, c in zip(hz, conf)]
    if len(T) < 10:
        return []
    hop = (T[-1] - T[0]) / (len(T) - 1)
    sm = []
    for i in range(len(x)):  # median of 5 frames: removes one-frame spikes
        w = [v for v in x[max(0, i - 2):i + 3] if v is not None]
        sm.append(_med(w) if x[i] is not None and w else None)
    W = max(1, int(o['fold_win'] / hop))
    voiced = [(i, v) for i, v in enumerate(sm) if v is not None]
    vals = np.array([v for _, v in voiced])
    for k, (i, v) in enumerate(voiced):  # fold octave glitches towards the surrounding second
        c = float(np.median(vals[max(0, k - W):k + W + 1]))
        while v - c > o['fold']: v -= 12
        while c - v > o['fold']: v += 12
        sm[i] = v
    STOP, SETTLE = max(2, round(o['stop'] / hop)), max(2, round(o['settle'] / hop))
    notes, cur, silent = [], [], 0

    def close():
        if cur:
            notes.append({'a': T[cur[0]], 'b': T[cur[-1]] + hop, 'f': [sm[i] for i in cur]})
    i = 0
    while i < len(sm):
        v = sm[i]
        if v is None:
            silent += 1
            if silent >= STOP and cur:
                close(); cur = []
            i += 1; continue
        silent = 0
        if cur:
            centre = _med([sm[k] for k in cur[-12:]])
            if abs(v - centre) > o['jump']:
                ahead = [sm[k] for k in range(i, min(len(sm), i + SETTLE))]
                if len(ahead) == SETTLE and all(a is not None and abs(a - v) < o['jump'] and abs(a - centre) > o['jump'] - 0.1 for a in ahead):
                    close(); cur = []
        cur.append(i); i += 1
    close()
    for n in notes:
        n['p'] = note_pitch(n['f'], o['pitch_of'])
    changed = True  # very short notes are slides or glitches: join the neighbour closest in pitch
    while changed:
        changed = False
        for k, n in enumerate(notes):
            if n['b'] - n['a'] >= o['min_note']:
                continue
            nb = [(j, notes[j]) for j in (k - 1, k + 1) if 0 <= j < len(notes)
                  and (notes[j]['a'] - n['b'] < 0.05 if j > k else n['a'] - notes[j]['b'] < 0.05)]
            if nb:
                j, other = min(nb, key=lambda q: abs(q[1]['p'] - n['p']))
                other['a'], other['b'], other['f'] = min(other['a'], n['a']), max(other['b'], n['b']), other['f'] + n['f']
            del notes[k]; changed = True
            break
    if o['glide_max'] > 0:
        notes = _glides(notes, o)
    if o['approach_max'] > 0:
        notes = _absorb_slides(notes, o)
    merged = []
    for n in notes:
        if merged and merged[-1]['p'] == n['p'] and n['a'] - merged[-1]['b'] < 0.06:
            merged[-1]['b'] = n['b']; merged[-1]['f'] += n['f']
        else:
            merged.append(n)
    for n in merged:
        n['p'] = note_pitch(n['f'], o['pitch_of'])
    if o['key_prior'] > 0:
        _key_prior(merged, o['key_prior'])
    if o['chroma_max'] > 0:
        merged = _out_of_key(merged, o)
    return merged


def _out_of_key(notes: list[dict], o) -> list[dict]:
    """Short notes on a pitch the song hardly uses (less than chroma_rare of its most used pitch
    class), touching a neighbour 1-2 semitones away on a common pitch, are the voice passing
    through on the way into or out of that note (无人之岛, F major: D4 → D#4 → B4 → C5). They join
    that neighbour, preferring the next note (a scoop). Quick notes on the song's own scale are
    never touched."""
    h = [0.0] * 12
    for n in notes:
        h[n['p'] % 12] += n['b'] - n['a']
    top = max(h) or 1.0
    rare = lambda p: h[p % 12] < o['chroma_rare'] * top
    out = list(notes)
    changed = True
    while changed:
        changed = False
        for k, n in enumerate(out):
            if n['b'] - n['a'] >= o['chroma_max'] or not rare(n['p']):
                continue
            nxt = out[k + 1] if k + 1 < len(out) else None
            prv = out[k - 1] if k else None
            if nxt and nxt['a'] - n['b'] < 0.05 and 0 < abs(nxt['p'] - n['p']) <= 2 and not rare(nxt['p']):
                nxt['a'] = n['a']; del out[k]; changed = True; break
            if prv and n['a'] - prv['b'] < 0.05 and 0 < abs(prv['p'] - n['p']) <= 2 and not rare(prv['p']):
                prv['b'] = n['b']; del out[k]; changed = True; break
    return out


def _key_prior(notes: list[dict], width: float):
    """A note whose pitch sits near the middle between two semitones (within ±width of the half)
    takes the one the song uses more (pitch-class time over the whole song: a soft key, nothing
    is snapped unless it is ambiguous). 无人之岛: 的 sung 60 cents sharp of F came out F#."""
    h = [0.0] * 12
    for n in notes:
        h[n['p'] % 12] += n['b'] - n['a']
    for n in notes:
        m = _med(n['f'])
        lo = math.floor(m)
        if abs(m - (lo + 0.5)) < width:
            n['p'] = max((lo, lo + 1), key=lambda q: h[q % 12])


def _glides(notes: list[dict], o) -> list[dict]:
    """Leaps: between two notes far apart (glide_min+ semitones), short touching notes whose pitch
    lies between them are the voice travelling (无人之岛: C4 → C#4 → B4 → C5 came out as four notes).
    Each joins the end it is closer to in pitch; the two real notes keep their pitches."""
    dur = lambda n: n['b'] - n['a']
    out = list(notes)
    k = 0
    while k < len(out) - 2:
        a = out[k]
        j = k + 1
        mids = []
        while j < len(out) and dur(out[j]) < o['glide_max'] and out[j]['a'] - out[j - 1]['b'] < 0.05:
            mids.append(out[j]); j += 1
        if not mids or j >= len(out) or out[j]['a'] - out[j - 1]['b'] >= 0.05:
            k += 1; continue
        c = out[j]
        lo, hi = sorted((a['p'], c['p']))
        if hi - lo < o['glide_min'] or dur(c) < o['glide_max'] or not all(lo < m['p'] < hi for m in mids):
            k += 1; continue
        ps = [m['p'] for m in mids]
        if any((y - x) * (c['p'] - a['p']) < 0 for x, y in zip(ps, ps[1:])):
            k += 1; continue  # not moving one way
        for m in mids:
            if abs(m['p'] - a['p']) < abs(m['p'] - c['p']):
                a['b'] = m['b']
            else:
                c['a'] = min(c['a'], m['a'])
        del out[k + 1:j]
        k += 1
    return out


def _absorb_slides(notes: list[dict], o) -> list[dict]:
    """Scoops into a note and quick fall-offs after one are part of that note, not notes of their
    own (The Reason: a sung E4 scooped from C#4 came out as C#4 D#4 E4). A short note joins a
    touching note that is clearly longer when it rises into it (scoop) or falls away after it,
    within a few semitones. The longer note keeps its pitch."""
    dur = lambda n: n['b'] - n['a']
    out = list(notes)
    changed = True
    while changed:
        changed = False
        for k, n in enumerate(out):
            if dur(n) >= o['approach_max']:
                continue
            nxt = out[k + 1] if k + 1 < len(out) else None
            prv = out[k - 1] if k > 0 else None
            if nxt and nxt['a'] - n['b'] < 0.05 and dur(nxt) >= o['approach_ratio'] * dur(n) \
                    and 0 < nxt['p'] - n['p'] <= o['approach_span']:
                nxt['a'] = n['a']; del out[k]; changed = True; break      # scoop up into the next note
            if prv and n['a'] - prv['b'] < 0.05 and dur(prv) >= o['approach_ratio'] * dur(n) \
                    and 0 < prv['p'] - n['p'] <= o['approach_span'] and (nxt is None or nxt['a'] - n['b'] >= 0.05):
                prv['b'] = n['b']; del out[k]; changed = True; break      # falls away at the end of a phrase
    return out


def place(syl: list[Syl], notes: list[dict], o) -> list[list]:
    """-> [start, end, midi, text, starts_line] per output note."""
    S, M = len(syl), len(notes)
    if not S or not M:
        return []
    zh = bool(HAN.search(''.join(s.text for s in syl)))
    SKIP, SHARE, CAP = o['skip'], (o['share_zh'] if zh else o['share']), o['cap']
    t = [s.t + o['align_bias'] for s in syl]
    cost = lambda i, j: syl[i].weight * min(abs(t[i] - notes[j]['a']), CAP)
    INF = float('inf')
    D = [[INF] * M for _ in range(S)]
    P = [[None] * M for _ in range(S)]
    for j in range(M):
        D[0][j] = cost(0, j) + SKIP * j * 0.25
    for i in range(1, S):
        best, bj = INF, None
        for j in range(M):
            if j > 0:
                if D[i - 1][j - 1] < best + SKIP:
                    best, bj = D[i - 1][j - 1], j - 1
                else:
                    best += SKIP
            opts = [(best, bj)] if bj is not None else []
            opts.append((D[i - 1][j] + SHARE, j))
            v, pj = min(opts, key=lambda q: q[0])
            D[i][j], P[i][j] = v + cost(i, j), pj
    j = min(range(M), key=lambda q: D[S - 1][q])
    at = [0] * S
    for i in range(S - 1, -1, -1):
        at[i] = j
        if i: j = P[i][j]
    out = []
    for j, n in enumerate(notes):
        mine = [i for i in range(S) if at[i] == j]
        if mine:
            step = (n['b'] - n['a']) / len(mine)
            for q, i in enumerate(mine):
                out.append([n['a'] + q * step, n['a'] + (q + 1) * step, n['p'], syl[i].text, syl[i].line])
        elif out and j > at[0] and n['a'] - out[-1][1] < o['melisma_gap']:
            out.append([n['a'], n['b'], n['p'], '~', False])
    return _scoops(out, o) if o['scoop_max'] > 0 else out


def _scoops(out: list[list], o) -> list[list]:
    """Scoops and fall-offs, decided with the lyrics: a short note that rises into a longer note
    carrying no new syllable ("~", the same syllable continues) is the singer sliding into that
    note, so they become one note at the longer note's pitch. A short "~" note falling away right
    after a longer note is a fall-off. A short note followed by a new syllable is a real quick note
    and is kept (the rule before placing syllables couldn't tell these apart)."""
    dur = lambda e: e[1] - e[0]
    res = list(out)
    k = 0
    while k < len(res) - 1:
        e, nx = res[k], res[k + 1]
        if dur(e) < o['scoop_max'] and nx[3].strip() == '~' and nx[0] - e[1] < 0.05 \
                and dur(nx) >= o['approach_ratio'] * dur(e) and 0 < nx[2] - e[2] <= o['approach_span']:
            res[k] = [e[0], nx[1], nx[2], e[3], e[4]]
            del res[k + 1]
            continue
        # a short "~" cut off from the note before it is no continuation of that syllable: it's the
        # scoop at the start of the next one (try 3)
        detached = k == 0 or e[0] - res[k - 1][1] >= o['scoop_gap']
        if o['scoop_gap'] > 0 and e[3].strip() == '~' and detached and dur(e) < o['scoop_max'] \
                and nx[3].strip() != '~' and nx[0] - e[1] < 0.05 and dur(nx) >= o['approach_ratio'] * dur(e) \
                and 0 < nx[2] - e[2] <= o['approach_span']:
            res[k] = [e[0], nx[1], nx[2], nx[3], nx[4]]
            del res[k + 1]
            continue
        if nx[3].strip() == '~' and dur(nx) < o['scoop_max'] and nx[0] - e[1] < 0.05 \
                and dur(e) >= o['approach_ratio'] * dur(nx) and 0 < e[2] - nx[2] <= o['approach_span'] \
                and (k + 2 >= len(res) or res[k + 2][0] - nx[1] >= 0.05):
            e[1] = nx[1]
            del res[k + 1]
            continue
        k += 1
    return res


def ultrastar(meta: dict, out: list[list], bpm: float = 400.0) -> str:
    """UltraStar text. Times are stored in beats of 60/(bpm*4) s after #GAP (the first note)."""
    spb = 60 / (bpm * 4)
    gap = out[0][0] if out else 0.0
    head = [f'#{k.upper()}:{v}' for k, v in meta.items() if v not in (None, '')]
    head += [f'#BPM:{bpm:g}', f'#GAP:{round(gap * 1000)}']
    body, end_b = [], None
    for k, (a, b, p, text, line) in enumerate(out):
        ba = round((a - gap) / spb)
        if end_b is not None:
            ba = max(ba, end_b)
        bb = max(ba + 1, round((b - gap) / spb))
        if line and k:
            body.append(f'- {end_b}')
        body.append(f': {ba} {bb - ba} {p - 60} {text}')
        end_b = bb
    return '\n'.join(head + body + ['E', ''])
