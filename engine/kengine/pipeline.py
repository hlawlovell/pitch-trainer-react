"""Audio -> UltraStar, one step at a time, each step's result saved in the work folder so later steps
can be re-run (and tuned) in seconds:

  vocals.wav    separated vocals                      (MDX-Net Kim_Vocal_2, GPU via DirectML)
  pitch.json    sung pitch every 10 ms                (RMVPE)
  lyrics.json   lyric lines with start times          (pasted lyrics or LRCLIB synced lyrics)
  align.json    each word / Chinese character's time  (MMS forced alignment, per line)
  song.txt      notes from the pitch, syllables placed on them
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import numpy as np

from . import align, lyrics, notes, pitch

MODELS = Path(__file__).resolve().parent.parent / 'models'
STEPS = ['vocals', 'pitch', 'lyrics', 'align', 'notes']


def log(msg):
    print(f'  [{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def _load_16k(path: Path) -> np.ndarray:
    import librosa
    import soundfile as sf
    y, sr = sf.read(str(path), dtype='float32')
    if y.ndim > 1:
        y = y.mean(axis=1)
    return librosa.resample(y, orig_sr=sr, target_sr=16000) if sr != 16000 else y


def run(work: Path, audio: Path, meta: dict, lyrics_text: str | None = None, redo_from: str | None = None,
        opt: dict | None = None, gpu: bool = True, progress=None) -> str:
    """progress: optional callback, called with a short description as each step starts."""
    say = progress or (lambda _: None)
    work.mkdir(parents=True, exist_ok=True)
    o = {**notes.DEFAULTS, **(opt or {})}
    redo = set(STEPS[STEPS.index(redo_from):]) if redo_from else set()

    # 1. vocals
    voc = work / 'vocals.wav'
    if 'vocals' in redo or not voc.exists():
        from audio_separator.separator import Separator
        say('Separating vocals from the music')
        t = time.time()
        sep = Separator(log_level=logging.ERROR, model_file_dir=str(MODELS), output_dir=str(work),
                        use_directml=gpu, output_single_stem='Vocals')
        sep.load_model(model_filename='Kim_Vocal_2.onnx')
        out = sep.separate(str(audio))[0]
        os.replace(work / out, voc)
        log(f'vocals separated in {time.time() - t:.0f}s')

    # 2. pitch
    pj = work / 'pitch.json'
    if 'pitch' in redo or not pj.exists():
        import soundfile as sf
        say('Detecting the sung notes')
        t = time.time()
        y, sr = sf.read(str(voc), dtype='float32')
        tr = pitch.track(y, sr, MODELS / 'rmvpe.onnx', gpu=False)  # CPU is as fast here
        pj.write_text(json.dumps(tr.to_json()))
        log(f'pitch tracked in {time.time() - t:.0f}s')
    P = json.loads(pj.read_text())
    times, hz, conf = np.array(P['times']), np.array(P['frequencies']), np.array(P['confidence'])

    # 3. lyrics with line times
    # the aligner network's output over the whole song (computed once; aligning is then instant)
    ej = work / 'emissions.npz'
    if 'vocals' in redo or not ej.exists():
        say('Listening for the words')
        t = time.time()
        E = align.emissions(_load_16k(voc), gpu=gpu)
        np.savez_compressed(ej, lp=E.lp.astype(np.float16), fps=E.fps)
        log(f'aligner features computed in {time.time() - t:.0f}s')
    z = np.load(ej)
    E = align.Emissions(z['lp'].astype(np.float32), float(z['fps']))

    lj = work / 'lyrics.json'
    if 'lyrics' in redo or not lj.exists():
        say('Finding the lyrics')
        dur = float(times[-1]) if len(times) else None
        diff = 0.0
        if lyrics_text:
            lines, source = lyrics.plain(lyrics_text), 'pasted'
        else:
            found = lyrics.lrclib(meta.get('artist', ''), meta.get('lrclib_title') or meta.get('title', ''), dur)
            lines, diff = found if found else (None, 0.0)
            source = 'lrclib'
        t = time.time()
        if not lines:  # nowhere to get them: listen for them (rough lines; aligned precisely below)
            say('Transcribing the lyrics (no lyrics found online)')
            from . import transcribe
            lines, lang = transcribe.lines_from_speech(_load_16k(voc), meta.get('language'))
            if not lines:
                raise RuntimeError('No lyrics found online, and none could be heard in the singing: paste the lyrics.')
            meta['language'] = meta.get('language') or lang
            source = f'speech recognition ({lang})'
            off, fits = 0.0, [(0.0, 1.0)]
        elif any(l.start < 0 for l in lines):  # pasted without timings: align the whole text to the whole song
            off, fits = 0.0, [(0.0, _whole_song(lines, E, meta))]
            source += ', timed by aligning the whole text'
            lines = [l for l in lines if l.start >= 0]
            if not lines:
                raise RuntimeError('The pasted lyrics could not be matched to the singing.')
        else:
            if diff < -40:  # a shortened edit: it starts like the full version, so keep the search narrow
                span = 20.0
                lines = [l for l in lines if l.start < dur + 20]
            else:
                span = max(20.0, abs(diff) + 10)
            off, fits = _fit_offset(lines, E, span=span, meta=meta, n_coarse=int(o['fit_coarse']), n_fine=int(o['fit_fine']))
            for l in lines:
                l.start += off
        lines = [l for l in lines if l.start < dur - 0.5]  # past the end of our audio
        lj.write_text(json.dumps({'source': source, 'language': meta.get('language'), 'offset': off, 'length_diff': diff, 'candidates': fits, 'lines': [l.__dict__ for l in lines]},
                                 ensure_ascii=False), encoding='utf-8')
        log(f'{len(lines)} lyric lines from {source}, offset {off:+.2f}s in {time.time() - t:.0f}s '
            f'(best: {", ".join(f"{c:+.2f}s={s:.2f}" for c, s in fits[:3])})')
    LJ = json.loads(lj.read_text(encoding='utf-8'))
    L = [lyrics.Line(**d) for d in LJ['lines']]
    meta['language'] = meta.get('language') or LJ.get('language')  # e.g. detected by speech recognition

    # 4. forced alignment, line by line
    aj = work / 'align.json'
    if 'align' in redo or not aj.exists():
        say('Timing the lyrics')
        t = time.time()
        rows = []
        for i, l in enumerate(L):
            nxt = L[i + 1].start if i + 1 < len(L) else l.start + 8
            toks = align.tokens_of(l.text, meta.get('language'))
            align.align_em(E, l.start - 0.5, min(nxt, l.start + 12) + 0.5, toks)
            rows += [dict(line=i, text=tk.text, start=tk.start, end=tk.end, score=tk.score) for tk in toks]
        aj.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
        log(f'{len(rows)} words aligned in {time.time() - t:.0f}s')
    rows = json.loads(aj.read_text(encoding='utf-8'))

    # 5. notes
    say('Writing the notes')
    syl = _syllables(rows, L)
    found = notes.pitch_notes(times, hz, conf, o)
    out = notes.place(syl, found, o)
    txt = notes.ultrastar({'artist': meta.get('artist'), 'title': meta.get('title'), 'language': meta.get('language'),
                           'creator': 'kengine'}, out)
    if notes.HAN.search(txt) and not align.KANA.search(txt) and meta.get('language') != 'ja':  # Chinese, not Japanese kanji
        try:
            from opencc import OpenCC
            txt = OpenCC('t2s').convert(txt)
        except ImportError:
            pass
    (work / 'song.txt').write_text(txt, encoding='utf-8')
    return txt


def _fit_offset(lines, E, span: float, meta: dict | None = None, n_coarse: int = 4, n_fine: int = 8):
    meta = meta or {}
    """The shift under which the lyrics actually match the singing: align sample lines at every
    shift (1 s steps over ±span, then 0.25 s around the best three) and keep the one the aligner
    is most confident about. Synced lyrics often follow another version of the song (a music video
    with an intro), and evenly spaced phrases fool simpler timing-based guesses."""
    cand_lines = [i for i, l in enumerate(lines) if len(align.tokens_of(l.text, meta.get('language'))) >= 3]

    def pick(n):
        if n <= 0 or len(cand_lines) <= n:
            return cand_lines
        return [cand_lines[round(k * (len(cand_lines) - 1) / (n - 1))] for k in range(n)]

    def fit(c, idx):
        sc = []
        for i in idx:
            l = lines[i]
            nxt = lines[i + 1].start if i + 1 < len(lines) else l.start + 8
            toks = align.tokens_of(l.text, meta.get('language'))
            align.align_em(E, l.start + c - 0.5, min(nxt, l.start + 12) + c + 0.5, toks)
            sc += [tk.score if tk.start >= 0 else 0.0 for tk in toks]
        return float(np.mean(sc)) if sc else 0.0

    coarse = sorted(((c, fit(c, pick(n_coarse))) for c in np.arange(-span, span + 0.01, 1.0)), key=lambda f: -f[1])
    fine = {}
    for c0, _ in coarse[:3]:
        for c in np.arange(c0 - 1.0, c0 + 1.01, 0.25):
            fine[round(float(c), 2)] = fit(c, pick(n_fine))
    fits = sorted(((c, round(s, 3)) for c, s in fine.items()), key=lambda f: -f[1])
    return fits[0][0], fits


def _whole_song(lines, E, meta: dict) -> float:
    """Lyrics without timings: align every word of the text, in order, over the whole song, and
    give each line the time of its first placed word (lines that can't be placed keep -1).
    Instrumental parts are absorbed by the aligner's blank symbol. Returns the mean word score."""
    toks = [align.tokens_of(l.text, meta.get('language')) for l in lines]
    flat = [t for ts in toks for t in ts]
    align.align_em(E, 0.0, len(E.lp) / E.fps, flat)
    for l, ts in zip(lines, toks):
        placed = [t.start for t in ts if t.start >= 0]
        l.start = min(placed) if placed else -1.0
    # a line whose time runs backwards was squeezed in: drop its time
    last = -1.0
    for l in lines:
        if l.start >= 0 and l.start < last:
            l.start = -1.0
        elif l.start >= 0:
            last = l.start
    sc = [t.score for t in flat if t.start >= 0]
    return round(float(np.mean(sc)), 3) if sc else 0.0


def _syllables(rows: list[dict], L: list[lyrics.Line]) -> list[notes.Syl]:
    """Aligned words -> syllables to place; words the aligner couldn't place get a time between
    their neighbours and little weight."""
    syl, prev_line = [], -1
    for r in rows:
        zh = bool(notes.HAN.search(r['text']))
        first = r['line'] != prev_line
        text = r['text'] if (zh or first) else ' ' + r['text']
        w = 1.0 if r['score'] >= 0.3 else notes.DEFAULTS['low_score_weight']
        syl.append(notes.Syl(r['start'], text, first, w if r['start'] >= 0 else 0.05))
        prev_line = r['line']
    # fill unplaced times by interpolation
    known = [i for i, s in enumerate(syl) if s.t >= 0]
    for i, s in enumerate(syl):
        if s.t < 0:
            lo = max((k for k in known if k < i), default=None)
            hi = min((k for k in known if k > i), default=None)
            if lo is not None and hi is not None:
                s.t = syl[lo].t + (syl[hi].t - syl[lo].t) * (i - lo) / (hi - lo)
            else:
                s.t = L[rows[i]['line']].start
    return syl
