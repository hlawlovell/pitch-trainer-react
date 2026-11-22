"""Word/character timing by forced alignment: place known lyrics on the vocals.

Uses Meta's MMS forced-alignment model (torchaudio's MMS_FA bundle, 1100+ languages, works on
romanised text). Each lyric line is aligned inside its own time window (from synced lyrics or a
rough first pass), which keeps it fast and stops one bad line from pulling the rest off.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

HAN = re.compile(r'[㐀-鿿豈-﫿]')


KANA = re.compile(r'[぀-ヿ]')


@dataclass
class Token:
    text: str            # what's shown (a word, or one Chinese character)
    start: float = -1.0  # seconds; -1 = couldn't place it
    end: float = -1.0
    score: float = 0.0   # alignment confidence 0..1
    roman: str | None = None  # reading, when the text alone doesn't give it (Japanese)


_kks = None


def tokens_of(line: str, lang: str | None = None) -> list[Token]:
    """Chinese: one token per character; Japanese: one per word with its reading (pykakasi);
    otherwise one per word. Japanese is recognised by kana, or by lang='ja' (an all-kanji line)."""
    global _kks
    if KANA.search(line) or (lang == 'ja' and HAN.search(line)):
        if _kks is None:
            import pykakasi
            _kks = pykakasi.kakasi()
        return [Token(i['orig'], roman=re.sub(r"[^a-z']", '', i['hepburn'].lower()))
                for i in _kks.convert(line) if i['orig'].strip()]
    out = []
    for w in line.split():
        if HAN.search(w):
            for ch in re.findall(r'[㐀-鿿豈-﫿]|[^㐀-鿿豈-﫿]+', w):
                out.append(Token(ch))
        else:
            out.append(Token(w))
    return out


_uroman = None


def romanise(text: str) -> str:
    """Lowercase a–z and apostrophes only (the aligner's alphabet)."""
    global _uroman
    if HAN.search(text):
        from pypinyin import lazy_pinyin
        r = ''.join(lazy_pinyin(text))
    else:
        if _uroman is None:
            import uroman
            _uroman = uroman.Uroman()
        r = _uroman.romanize_string(text)
    return re.sub(r"[^a-z']", '', r.lower())


_bundle = None


def _model(gpu: bool):
    global _bundle
    if _bundle is None:
        from torchaudio.pipelines import MMS_FA
        from .devices import torch_device
        dev = torch_device(gpu)
        model = MMS_FA.get_model(with_star=False).eval()
        try:
            model = model.to(dev)
        except Exception:
            import torch
            dev = torch.device('cpu')
        _bundle = (model, MMS_FA.get_dict(star=None), dev)
    return _bundle


@dataclass
class Emissions:
    """The aligner network's output for a whole recording (log-probabilities per 20 ms frame), so
    any line can then be aligned at any offset without running the network again."""
    lp: np.ndarray      # (frames, vocab)
    fps: float          # frames per second


def emissions(audio16k: np.ndarray, gpu: bool = True, chunk_s: float = 20.0, ctx_s: float = 2.0) -> Emissions:
    import torch
    model, vocab, dev = _model(gpu)
    chunk, ctx = int(chunk_s * 16000), int(ctx_s * 16000)
    parts, fps = [], None
    with torch.inference_mode():
        for a in range(0, len(audio16k), chunk):
            lo, hi = max(0, a - ctx), min(len(audio16k), a + chunk + ctx)
            wav = torch.from_numpy(audio16k[lo:hi].astype(np.float32))[None]
            try:
                em, _ = model(wav.to(dev))
            except Exception:
                global _bundle
                _bundle = (model.cpu(), vocab, torch.device('cpu')); model = _bundle[0]; dev = _bundle[2]
                em, _ = model(wav)
            em = torch.log_softmax(em.float().cpu(), dim=-1)[0].numpy()
            fps = em.shape[0] / ((hi - lo) / 16000)
            s = int(round((a - lo) / 16000 * fps))
            n = int(round(min(chunk, len(audio16k) - a) / 16000 * fps))
            parts.append(em[s:s + n])
    return Emissions(np.concatenate(parts), fps)


def align_em(E: Emissions, t0: float, t1: float, tokens: list[Token]) -> None:
    """Like align_line, but on precomputed emissions (fast: no network run)."""
    import torch
    import torchaudio.functional as F
    _, vocab, _ = _model(False)
    roman = [t.roman if t.roman is not None else romanise(t.text) for t in tokens]
    idx = [k for k, r in enumerate(roman) if r]
    if not idx:
        return
    a, b = max(0, int(t0 * E.fps)), min(len(E.lp), int(t1 * E.fps))
    targets = [vocab[c] for k in idx for c in roman[k]]
    if b - a < len(targets) + 2:
        return
    em = torch.from_numpy(E.lp[a:b])[None]
    ali, scores = F.forced_align(em, torch.tensor([targets], dtype=torch.int32), blank=0)
    spans = F.merge_tokens(ali[0], scores[0].exp())
    pos = 0
    for k in idx:
        n = len(roman[k])
        part = spans[pos:pos + n]; pos += n
        tokens[k].start = (a + part[0].start) / E.fps
        tokens[k].end = (a + part[-1].end) / E.fps
        tokens[k].score = float(np.mean([s.score for s in part]))


def align_line(audio16k: np.ndarray, t0: float, t1: float, tokens: list[Token], gpu: bool = True) -> None:
    """Align `tokens` inside audio[t0:t1] (seconds); fills each token's start/end/score in place."""
    import torch
    import torchaudio.functional as F
    model, vocab, dev = _model(gpu)
    roman = [t.roman if t.roman is not None else romanise(t.text) for t in tokens]
    idx = [k for k, r in enumerate(roman) if r]
    if not idx:
        return
    a, b = max(0, int(t0 * 16000)), min(len(audio16k), int(t1 * 16000))
    if b - a < 1600:
        return
    wav = torch.from_numpy(audio16k[a:b].astype(np.float32))[None]
    with torch.inference_mode():
        try:
            em, _ = model(wav.to(dev))
        except Exception:  # an op the GPU backend lacks: fall back to the CPU for good
            global _bundle
            _bundle = (model.cpu(), vocab, torch.device('cpu'))
            em, _ = model(wav)
        em = torch.log_softmax(em.float().cpu(), dim=-1)
    targets = [vocab[c] for k in idx for c in roman[k]]
    if em.shape[1] < len(targets):
        return
    ali, scores = F.forced_align(em, torch.tensor([targets], dtype=torch.int32), blank=0)
    spans = F.merge_tokens(ali[0], scores[0].exp())
    sec = (b - a) / 16000 / em.shape[1]  # seconds per emission frame
    pos = 0
    for k in idx:
        n = len(roman[k])
        part = spans[pos:pos + n]; pos += n
        tokens[k].start = t0 + part[0].start * sec
        tokens[k].end = t0 + part[-1].end * sec
        tokens[k].score = float(np.mean([s.score for s in part]))
