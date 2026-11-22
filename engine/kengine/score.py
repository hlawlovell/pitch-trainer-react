"""Score a generated UltraStar file against a correct one (hand-made UltraStar .txt, or a MIDI file).

Metrics (all measured where the reference has a note):
  exact     same note, same octave                          (share of time)
  pitch     same note, any octave
  semitone  within a semitone, any octave
  octave    right note but in another octave                (share of time)
  coverage  how much of the reference's singing has a generated note at all
  extra     seconds the generated file sings where the reference has nothing
  word_ms   median start-time error of matched words        (UltraStar references only)
  far       share of matched words more than 300 ms off
  wer       lyric word error rate                           (UltraStar references only)
  short     share of generated notes shorter than 120 ms

The two files can come from differently trimmed audio, so the time offset is searched first
(±20 s). References made from sheet music may be in another key: `transpose=True` also searches
the key (the metrics then use the best transposition).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

NOTE = re.compile(r'^([:*FRG]) (-?\d+) (\d+) (-?\d+) ?(.*)$')


@dataclass
class Note:
    start: float
    end: float
    midi: int
    text: str = ''
    line_start: bool = False


@dataclass
class Song:
    notes: list[Note]
    words: list[tuple[str, float]] = field(default_factory=list)  # (word, start)
    ignore: list[tuple[float, float]] = field(default_factory=list)  # rap/freestyle: pitch not judged


def read_ultrastar(path: Path | str) -> Song:
    raw = Path(path).read_bytes()
    try:
        txt = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        txt = raw.decode('cp1252')
    return read_ultrastar_text(txt)


def read_ultrastar_text(txt: str) -> Song:
    num =lambda tag: float(re.search(rf'^#{tag}:([\d.,]+)', txt, re.M | re.I).group(1).replace(',', '.'))
    bpm, gap = num('BPM'), num('GAP') / 1000
    spb = 60 / (bpm * 4)
    rel = bool(re.search(r'^#RELATIVE:\s*yes', txt, re.M | re.I))
    notes, base, line_start, ignore, lyric_notes = [], 0, True, [], []
    for l in txt.splitlines():
        if l.startswith('-'):
            line_start = True
            if rel:
                parts = l.split()
                base += int(parts[2] if len(parts) > 2 else parts[1])
            continue
        if l.startswith(('P2', 'P 2')):
            break  # duets: score the first singer
        m = NOTE.match(l)
        if not m:
            continue
        b = int(m[2]) + base
        n = Note(gap + b * spb, gap + (b + max(1, int(m[3]))) * spb, int(m[4]), m[5], line_start)
        line_start = False
        lyric_notes.append(n)
        if m[1] in 'FRG':  # freestyle and rap: no pitch to judge
            ignore.append((n.start, n.end))
        else:
            notes.append(n)
    # the app's normalisation: files that store absolute MIDI land in a vocal range
    ps = sorted(n.midi for n in notes)
    shift = 0
    if ps:
        while ps[len(ps) // 2] + shift > 12: shift -= 12
        while ps[len(ps) // 2] + shift < -24: shift += 12
    for n in notes:
        n.midi += 60 + shift
    return Song(notes, words_of(lyric_notes), ignore)


def words_of(notes: list[Note]) -> list[tuple[str, float]]:
    out, cur, t0 = [], '', 0.0
    for n in notes:
        txt = n.text.replace('~', '')
        if (n.text[:1].isspace() or n.line_start) and cur:
            out.append((cur, t0)); cur = ''
        if not cur:
            t0 = n.start
        if re.search(r'[㐀-鿿]', txt):  # Chinese: every character is a word
            for ch in txt.strip():
                if cur: out.append((cur, t0))
                cur, t0 = ch, n.start
            continue
        cur += txt.strip()
        if n.text.endswith(' ') and cur:
            out.append((cur, t0)); cur = ''
    if cur:
        out.append((cur, t0))
    clean = lambda w: re.sub(r"[^\w']", '', w.lower())
    return [(clean(w), t) for w, t in out if clean(w)]


HANGUL = re.compile(r'[가-힯]')


KANA = re.compile(r'[぀-ヿ]')
CJK = re.compile(r'[가-힯぀-ヿ㐀-鿿]')


def _roman_words(words, japanese: bool = False):
    """Romanise Korean (uroman) or Japanese (pykakasi) words, for comparing with references written
    in romanisation."""
    if japanese:
        import pykakasi
        k = pykakasi.kakasi()
        roman = lambda w: ''.join(i['hepburn'] for i in k.convert(w))
    else:
        import uroman
        u = uroman.Uroman()
        roman = u.romanize_string
    return [(re.sub(r"[^a-z']", '', roman(w).lower()) if CJK.search(w) else w, t) for w, t in words]


def read_midi(path: Path | str) -> Song:
    """Melody from a MIDI file: the track with the highest notes (the right hand / melody), and of
    that, the top note sounding at each moment."""
    import mido
    mf = mido.MidiFile(str(path))
    # absolute times with the file's tempo map (tempo changes can sit in any track)
    events = []
    for i, tr in enumerate(mf.tracks):
        tick = 0
        for msg in tr:
            tick += msg.time
            events.append((tick, i, msg))
    events.sort(key=lambda e: e[0])
    tempo, last_tick, now = 500000, 0, 0.0
    on, per_track = {}, {}
    for tick, i, msg in events:
        now += mido.tick2second(tick - last_tick, mf.ticks_per_beat, tempo)
        last_tick = tick
        if msg.type == 'set_tempo':
            tempo = msg.tempo
        elif msg.type == 'note_on' and msg.velocity > 0 and getattr(msg, 'channel', 0) != 9:
            on[(i, msg.note)] = now
        elif msg.type in ('note_off', 'note_on') and (i, getattr(msg, 'note', -1)) in on:
            a = on.pop((i, msg.note))
            if now - a > 0.03:
                per_track.setdefault(i, []).append(Note(a, now, msg.note))
    if not per_track:
        return Song([])
    best = max(per_track.values(), key=lambda ns: sorted(n.midi for n in ns)[int(len(ns) * 0.75)])
    best.sort(key=lambda n: (n.start, -n.midi))
    skyline = []  # top voice: a note is cut where a higher one starts
    for n in best:
        while skyline and skyline[-1].end > n.start and skyline[-1].midi < n.midi:
            prev = skyline[-1]
            if n.start - prev.start < 0.05:
                skyline.pop()
            else:
                prev.end = n.start
                break
        if skyline and skyline[-1].end > n.start and skyline[-1].midi >= n.midi:
            prev = skyline[-1]
            if prev.end - n.start < 0.06 and n.start - prev.start > 0.05 and n.end > prev.end:
                prev.end = n.start  # legato: the higher note only just overlaps this one
            else:
                continue  # under a higher sounding note: accompaniment
        skyline.append(Note(n.start, n.end, n.midi))
    return Song(skyline)


def read(path: Path | str) -> Song:
    p = Path(path)
    return read_midi(p) if p.suffix.lower() in ('.mid', '.midi', '.kar') else read_ultrastar(p)


def grid(notes: list[Note], dt: float, end: float):
    """The note sounding at each step of a time grid (-1000 = none)."""
    import numpy as np
    g = np.full(int(end / dt) + 2, -1000, dtype=np.int32)
    for n in notes:
        a, b = int(round(n.start / dt)), int(round(n.end / dt))
        if b > a >= 0:
            g[a:b] = n.midi
    return g


def _agree(G, R, k: int, key: int):
    """Grid steps where gen (shifted later by k steps) and ref share a pitch class (after `key`)."""
    import numpy as np
    if k >= 0:
        a, b = G[: len(G) - k] if k else G, R[k:]
    else:
        a, b = G[-k:], R[: len(R) + k]
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    ok = (a > -1000) & (b > -1000)
    return int(np.count_nonzero(ok & ((a - b - key) % 12 == 0)))


def seq_match(gen: list, ref: list, shift: int) -> float:
    """Timing-free check: the two note sequences lined up by edit distance on pitch; F1 of notes that
    match in order (100 = the same notes in the same order). Fair for references whose rhythm is not
    the singer's (piano covers, sheet music), and it punishes split or missing notes."""
    a = [n.midi + shift for n in ref]
    b = [n.midi for n in gen]
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    # longest common subsequence (only matches count; gaps are free)
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    m = prev[-1]
    return round(100 * 2 * m / (len(a) + len(b)), 1)


def score(gen: Song, ref: Song, transpose: bool = False, step: float = 0.01) -> dict:
    import numpy as np
    end = max(gen.notes[-1].end if gen.notes else 0, ref.notes[-1].end if ref.notes else 0) + 25
    keys = range(12) if transpose else [0]
    # coarse search on a 50 ms grid over ±20 s, then fine on 10 ms
    G, R = grid(gen.notes, 0.05, end), grid(ref.notes, 0.05, end)
    k0, key = max(((k, key) for k in range(-400, 401) for key in keys), key=lambda kk: _agree(G, R, kk[0], kk[1]))
    G, R = grid(gen.notes, step, end), grid(ref.notes, step, end)
    base = k0 * 5
    k = max(range(base - 8, base + 9), key=lambda kk: _agree(G, R, kk, key))
    best_s = k * step

    if k >= 0:
        a, b = G[: len(G) - k] if k else G, R[k:]
    else:
        a, b = G[-k:], R[: len(R) + k]
    n = min(len(a), len(b)); a, b = a[:n], b[:n]
    hg, hr = a > -1000, b > -1000
    if ref.ignore:  # where the reference has rap/freestyle, generated notes are neither right nor extra
        dc = np.zeros(len(R), bool)
        for s, e in ref.ignore:
            dc[max(0, int(round(s / step))):max(0, int(round(e / step)))] = True
        dc = dc[k:][:n] if k >= 0 else dc[:n]  # same indexing as b (the reference side)
        hg = hg & ~dc
    both = np.count_nonzero(hg & hr)
    d = (a - b - key)[hg & hr]
    # some hand-made files write a whole song an octave off (often male singers): allow one fixed
    # octave shift for the song, like the app's "accept any octave" does
    ref_oct = max((-24, -12, 0, 12, 24), key=lambda s: (np.count_nonzero(d == s), -abs(s))) if len(d) else 0
    d = d - ref_oct
    pc = d % 12
    pct = lambda x: round(100 * int(x) / both, 1) if both else 0.0
    res = dict(offset=round(best_s, 2), key=key, ref_octave=ref_oct // 12, exact=pct(np.count_nonzero(d == 0)), pitch=pct(np.count_nonzero(pc == 0)),
               semitone=pct(np.count_nonzero(np.minimum(pc, 12 - pc) <= 1)),
               octave=pct(np.count_nonzero((pc == 0) & (d != 0))),
               coverage=round(100 * both / max(1, np.count_nonzero(hr)), 1),
               extra=round(np.count_nonzero(hg & ~hr) * step, 1),
               short=round(100 * sum(1 for n in gen.notes if n.end - n.start < 0.12) / max(1, len(gen.notes)), 1))
    res['seq'] = seq_match(gen.notes, ref.notes, key + ref_oct)

    if ref.words and gen.words:
        gwords = gen.words
        if not any(CJK.search(w) for w, _ in ref.words) and any(CJK.search(w) for w, _ in gen.words):
            gwords = _roman_words(gen.words, japanese=any(KANA.search(w) for w, _ in gen.words))
        gen = Song(gen.notes, gwords)
        gw, rw = [w for w, _ in gen.words], [w for w, _ in ref.words]
        D = [[0] * (len(rw) + 1) for _ in range(len(gw) + 1)]
        for i in range(len(gw) + 1): D[i][0] = i
        for j in range(len(rw) + 1): D[0][j] = j
        for i in range(1, len(gw) + 1):
            for j in range(1, len(rw) + 1):
                D[i][j] = min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (gw[i - 1] != rw[j - 1]))
        pairs, i, j = [], len(gw), len(rw)
        while i and j:
            if D[i][j] == D[i - 1][j - 1] + (gw[i - 1] != rw[j - 1]):
                if gw[i - 1] == rw[j - 1]: pairs.append((i - 1, j - 1))
                i -= 1; j -= 1
            elif D[i][j] == D[i - 1][j] + 1: i -= 1
            else: j -= 1
        errs = sorted(abs(gen.words[a][1] + best_s - ref.words[b][1]) * 1000 for a, b in pairs)
        res['wer'] = round(100 * D[-1][-1] / len(rw), 1)
        res['word_ms'] = round(errs[len(errs) // 2]) if errs else None
        res['far'] = round(100 * sum(1 for e in errs if e > 300) / len(errs), 1) if errs else None
    return res


if __name__ == '__main__':
    import json, sys
    a, b = sys.argv[1], sys.argv[2]
    print(json.dumps(score(read(a), read(b), transpose='--transpose' in sys.argv), indent=1))
