"""Lyrics with line timings.

Sources, best first: lyrics the user pastes (no timings), LRCLIB synced lyrics (free, open, line
timings for a huge catalogue in many languages), and later a speech-recognition fallback.
Synced lyrics usually follow the album version, which can start at a different moment than a
YouTube video, so `fit_offset` slides the lines over the detected singing to line them up.
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass

import numpy as np

UA = 'kengine/0.1 (karaoke song converter)'
LRC_TIME = re.compile(r'\[(\d+):(\d+(?:\.\d+)?)\]')


@dataclass
class Line:
    start: float   # seconds (-1 = unknown)
    text: str


def _search(params: dict) -> list[dict]:
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(f'https://lrclib.net/api/search?{q}', headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return [x for x in json.load(r) if x.get('syncedLyrics') and not x.get('instrumental')]


def lrclib(artist: str, title: str, duration: float | None = None) -> tuple[list[Line], float] | None:
    """Synced lyrics from LRCLIB: (lines, how much longer our audio is than that version).
    Tries artist + title, then free text; picks the version closest in length. A music-video
    version can be much longer (an intro), so a big difference is allowed and left to the offset fit."""
    results = _search({'artist_name': artist, 'track_name': title}) or _search({'q': f'{artist} {title}'})
    if not results:
        return None
    diff = 0.0
    if duration:
        results.sort(key=lambda x: abs((x.get('duration') or 0) - duration))
        diff = duration - (results[0].get('duration') or duration)
        if diff > 60:
            return None  # ours is much longer: a different version (live, extended mix…)
        # much shorter is fine: a TV-size / radio edit sings the start of the same lyrics
    return parse_lrc(results[0]['syncedLyrics']), diff


def parse_lrc(lrc: str) -> list[Line]:
    out = []
    for raw in lrc.splitlines():
        times = LRC_TIME.findall(raw)
        text = LRC_TIME.sub('', raw).strip()
        if not times or not text:
            continue
        for m, s in times:  # a line can carry several timestamps (repeated choruses)
            out.append(Line(int(m) * 60 + float(s), text))
    out.sort(key=lambda l: l.start)
    return out


HEADER = re.compile(r'^\s*[\[(（【]?\s*(verse|chorus|pre-?chorus|hook|bridge|intro|outro|refrain|rap|repeat|x\s*\d+|\d+\s*x|'
                    r'후렴|브릿지|副歌|主歌|间奏|間奏)[^\])）】]*[\])）】]?\s*:?\s*$', re.I)
REPEAT = re.compile(r'\s*[\[(（]\s*(x\s*\d+|\d+\s*x|repeat)\s*[\])）]\s*$', re.I)


def plain(text: str) -> list[Line]:
    """Lyrics pasted by the user, one lyric line per line. Synced lyrics ([mm:ss.xx] stamps) keep
    their times; otherwise the times are unknown (-1) and found by aligning the whole text to the
    song. Section headers ("[Chorus]", "Verse 2:") and repeat marks ("(x2)") are dropped."""
    if sum(1 for l in text.splitlines() if LRC_TIME.search(l)) >= 3:
        return parse_lrc(text)
    out = []
    for l in text.splitlines():
        l = REPEAT.sub('', l).strip()
        if l and not HEADER.match(l) and not re.fullmatch(r'\[[^\]]*\]', l):
            out.append(Line(-1.0, l))
    return out


def offset_candidates(lines: list[Line], voiced_times: np.ndarray, span: float = 20.0, n: int = 5) -> list[float]:
    """The best few shifts by how well lyric lines cover the singing (local maxima, 1 s apart).
    Songs with evenly spaced phrases fit several shifts almost equally, so the caller checks these
    candidates by actually aligning some words."""
    if not len(voiced_times) or not lines:
        return [0.0]
    dt = 0.05
    end = max(voiced_times.max(), lines[-1].start + 10) + span + 1
    sing = np.zeros(int(end / dt) + 1)
    np.add.at(sing, np.clip((voiced_times / dt).astype(int), 0, len(sing) - 1), 1)
    sing = np.minimum(sing, 1)
    ks = list(range(int(-span / dt), int(span / dt) + 1))
    vals = []
    for k in ks:
        win = np.full(len(sing), -0.5)
        for i, l in enumerate(lines):
            nxt = lines[i + 1].start if i + 1 < len(lines) else l.start + 6
            a, b = int((l.start + k * dt) / dt), int((min(nxt, l.start + 8) + k * dt) / dt)
            a, b = max(0, a), min(len(win), b)
            if b > a:
                win[a:b] = 1.0
        vals.append(float((win * sing).sum()))
    order = np.argsort(vals)[::-1]
    picked = []
    for i in order:
        s = ks[i] * dt
        if all(abs(s - p) >= 1.0 for p in picked):
            picked.append(s)
        if len(picked) == n:
            break
    return picked


def fit_offset(lines: list[Line], voiced_times: np.ndarray, span: float = 20.0) -> float:
    """Shift (s) that best lines up the lyric lines with the singing: maximises singing inside line
    windows (start .. next start, at most 8 s) minus singing outside them."""
    if not len(voiced_times) or not lines:
        return 0.0
    dt = 0.05
    end = max(voiced_times.max(), lines[-1].start + 10) + span + 1
    sing = np.zeros(int(end / dt) + 1)
    np.add.at(sing, np.clip((voiced_times / dt).astype(int), 0, len(sing) - 1), 1)
    sing = np.minimum(sing, 1)
    best, best_v = 0.0, -1e18
    for k in range(int(-span / dt), int(span / dt) + 1):
        win = np.full(len(sing), -0.5)  # singing where the lyrics say nothing counts against
        for i, l in enumerate(lines):
            nxt = lines[i + 1].start if i + 1 < len(lines) else l.start + 6
            a, b = int((l.start + k * dt) / dt), int((min(nxt, l.start + 8) + k * dt) / dt)
            a, b = max(0, a), min(len(win), b)
            if b > a:
                win[a:b] = 1.0
        v = float((win * sing).sum())
        if v > best_v:
            best, best_v = k * dt, v
    return best
