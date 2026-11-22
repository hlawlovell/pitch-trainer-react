"""Read the notes out of a Synthesia-style piano video (falling notes onto an 88-key keyboard).

  python -X utf8 -m kengine.synthesia video.mkv out.mid [--png roll.png]

How: a thin strip just above the keyboard is cut from every frame ("slit scan"). The notes scroll at
a constant speed, so stacking the strips gives a piano roll with one pixel per 1/speed seconds.
For every key's column the roll is classified as background / blue / green,
light colours for white keys and dark colours for black keys. Notes are split where the darker
outline between two notes shows. Output: a MIDI with track 0 = blue notes, track 1 = green notes (usually right/left hand, but videos differ; the scorer takes the higher track), at
the video's own timing (the moment each note reaches the keyboard).

Assumes the whole 88-key keyboard fills the video width (Synthesia's default) and Synthesia's default
colours; check one frame first.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

WHITE_STEPS = [2, 1, 2, 2, 1, 2, 2]  # A→B→C→D→E→F→G→A


def probe(video: Path) -> tuple[int, int, float]:
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,r_frame_rate', '-of', 'json', str(video)],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    a, b = s['r_frame_rate'].split('/')
    return s['width'], s['height'], float(a) / float(b)


def frame(video: Path, t: float, n: int = 1) -> np.ndarray:
    w, h, _ = probe(video)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(video), '-frames:v', str(n),
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(n, h, w, 3).astype(np.int16)


def keyboard_top(f: np.ndarray) -> int:
    """First row of the keyboard: Synthesia draws a red line on top of it."""
    col = f[:, :, :].astype(int)
    red = (col[:, :, 0] > 120) & (col[:, :, 1] < 80) & (col[:, :, 2] < 80)
    rows = np.where(red.mean(1) > 0.5)[0]
    return int(rows[0])


def keys(f: np.ndarray, top: int) -> list[tuple[int, float, bool]]:
    """(midi, x centre, is_black) for all 88 keys."""
    w = f.shape[1]
    ww = w / 52
    white_midi = [21]
    for i in range(51):
        white_midi.append(white_midi[-1] + WHITE_STEPS[i % 7])
    out = [(m, (i + 0.5) * ww, False) for i, m in enumerate(white_midi)]
    # black keys: dark runs on a row through the black keys
    row = f[top + 50, :, :].mean(1)
    dark = row < 70
    x = 0
    while x < w:
        if dark[x]:
            x2 = x
            while x2 < w and dark[x2]:
                x2 += 1
            c = (x + x2 - 1) / 2
            i = int(round(c / ww)) - 1  # boundary between white i and i+1
            if 0 <= i < 51 and white_midi[i + 1] - white_midi[i] == 2 and 6 <= x2 - x <= ww:
                out.append((white_midi[i] + 1, c, True))
            x = x2
        else:
            x += 1
    out.sort()
    return out


def speed(video: Path, t: float, top: int) -> float:
    """Scroll speed in px/s, from two frames 2 s apart."""
    _, _, fps = probe(video)
    n = int(round(2 * fps)) + 1
    f = frame(video, t, n)
    a, b = f[0, 20:top - 20].mean(2), f[-1, 20:top - 20].mean(2)
    h = a.shape[0]
    errs = [np.abs(a[:h - s] - b[s:]).mean() for s in range(1, h - 60)]
    s = 1 + int(np.argmin(errs))
    return s * fps / (n - 1)


def strips(video: Path, y0: int, k: int, w: int):
    """Rows y0-k … y0-1 of every frame."""
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', str(video), '-vf', f'crop={w}:{k}:0:{y0 - k}',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    size = w * k * 3
    while True:
        b = p.stdout.read(size)
        if len(b) < size:
            break
        yield np.frombuffer(b, np.uint8).reshape(k, w, 3)
    p.wait()


def roll(video: Path, y0: int, v: float):
    """Piano-roll image: row i = the picture crossing line y0 at time i / v seconds."""
    w, _, fps = probe(video)
    k = int(np.ceil(v / fps)) + 2
    rows = {}
    for n, s in enumerate(strips(video, y0, k, w)):
        base = n / fps * v
        for j in range(k):  # strip row j is (k - j) px above the line → crosses it (k - j)/v s later
            rows[int(round(base + (k - j)))] = s[j]
    m = max(rows)
    img = np.zeros((m + 1, w, 3), np.uint8)
    for i, r in rows.items():
        img[i] = r
    # fill the odd missing row
    missing = [i for i in range(m + 1) if i not in rows]
    for i in missing:
        img[i] = img[i - 1]
    return img


def classify(px: np.ndarray, black: bool) -> np.ndarray:
    """px: (T, n, 3) pixels across a key column → per row 0 none, 1 blue note, 2 green note.
    White keys: a row is a note when it is mostly not background (labels and their outlines
    included); notes are separated by the dark gap Synthesia leaves between them. Black keys:
    their columns are also covered by the neighbouring white keys' notes, so only the dark note
    colours count."""
    p = px.astype(int)
    r, g, b = p[..., 0], p[..., 1], p[..., 2]
    lum, sat = p.mean(-1), p.max(-1) - p.min(-1)
    blue = (b > r + 35) & (b > g + 15) & (sat > 50)
    green = (g > b + 40) & (g > r + 30) & (sat > 50)
    n = px.shape[1]
    bg = (sat < 20) & (lum < 80)  # background and grid lines (labels' grey edges are not)
    note = bg.sum(1) < 0.35 * n
    # bridge 1-4 px holes (label edges); real gaps between notes are cut by brightness later
    T = len(note)
    i = 0
    while i < T:
        if not note[i]:
            j = i
            while j < T and not note[j]:
                j += 1
            if 0 < i and j < T and j - i <= 4:
                note[i:j] = True
            i = j
        else:
            i += 1
    if black:
        dark = (blue & (r < 85)) | (green & (r < 110) & (b < 50))
        light = ((blue & (r >= 85)) | (green & (r >= 110))) & ~dark
        nb, ng = (blue & dark).sum(1), (green & dark).sum(1)
        # rows clearly showing a neighbouring white key's note body; labels (white text with pale
        # edges) are short, so short light stretches inside a dark note are kept
        lt = light.sum(1) >= 0.6 * n
        T, i = len(lt), 0
        own = note & ~lt
        while i < T:
            if note[i] and lt[i]:
                j = i
                while j < T and note[j] and lt[j]:
                    j += 1
                before = i > 0 and own[max(0, i - 3):i].any() and (nb + ng)[max(0, i - 8):i].sum() > 0
                after = j < T and own[j:j + 3].any() and (nb + ng)[j:j + 8].sum() > 0
                if j - i < 12 and before and after:
                    own[i:j] = True
                i = j
            else:
                i += 1
        # a run must really be a dark note somewhere
        note = own
    else:
        nb, ng = blue.sum(1), green.sum(1)
    return np.where(note, np.where(nb >= ng, 1, 2), 0), nb, ng


def notes_from(img: np.ndarray, kb: list, v: float, delay: float, min_px: int = 9):
    out = []  # (start, end, midi, colour)
    for midi, x, black in kb:
        c = int(round(x))
        half = 4 if black else 9
        xs = np.clip(np.arange(c - half, c + half + 1), 0, img.shape[1] - 1)
        cls, nb, ng = classify(img[:, xs], black)
        T = len(cls)
        i = 0
        while i < T:
            if cls[i] == 0:
                i += 1; continue
            j = i
            while j < T and cls[j] != 0:
                j += 1
            # repeated notes touch: the only sign is the 1-2 px dark gap, a row far darker than the
            # note body (labels dip much less)
            lum = img[i:j, xs].astype(float).mean((1, 2))
            body = np.median(lum)
            cuts, y = [i], 1
            while y < j - i - 1:
                if lum[y] < 0.5 * body:
                    y2 = y
                    while y2 < j - i - 1 and lum[y2] < 0.5 * body:
                        y2 += 1
                    cuts.append(i + (y + y2) // 2)
                    y = y2
                y += 1
            cuts.append(j)
            for a, b in zip(cuts, cuts[1:]):
                if black and np.mean((nb + ng)[a:b] >= 0.5 * len(xs)) < 0.4:
                    continue  # not a black-key note: edges/labels of the neighbouring white keys' notes
                if b - a >= min_px:
                    hand = 1 if nb[a:b].sum() >= ng[a:b].sum() else 2
                    out.append((a / v + delay, b / v + delay, midi, hand))
            i = j
    out.sort()
    return out


def write_midi(notes, path: Path):
    import mido
    mf = mido.MidiFile(ticks_per_beat=480)
    tempo = 500000  # 120 bpm: 1 s = 960 ticks
    for hand in (1, 2):
        tr = mido.MidiTrack()
        tr.name = 'blue' if hand == 1 else 'green'
        if hand == 1:
            tr.append(mido.MetaMessage('set_tempo', tempo=tempo, time=0))
        ev = []
        for s, e, m, h in notes:
            if h == hand:
                ev.append((round(s * 960), 1, m))
                ev.append((round(e * 960) - 1, 0, m))
        ev.sort()
        now = 0
        for t, on, m in ev:
            tr.append(mido.Message('note_on' if on else 'note_off', note=m, velocity=80 if on else 0, time=t - now))
            now = t
        mf.tracks.append(tr)
    mf.save(str(path))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('out')
    ap.add_argument('--png', help='also save the piano-roll image (for checking)')
    ap.add_argument('--at', type=float, default=30.0, help='a time with notes on screen (for speed)')
    a = ap.parse_args(argv)
    video = Path(a.video)
    f = frame(video, a.at)[0]
    top = keyboard_top(f)
    kb = keys(f, top)
    v = speed(video, a.at, top)
    y0 = top - 30  # stay clear of the glow just above the keyboard
    print(f'keyboard at y={top}, {len(kb)} keys ({sum(b for *_, b in kb)} black), speed {v:.1f} px/s', flush=True)
    img = roll(video, y0, v)
    notes = notes_from(img, kb, v, delay=(top - y0) / v)
    rh = [n for n in notes if n[3] == 1]
    lh = [n for n in notes if n[3] == 2]
    print(f'{len(rh)} blue notes, {len(lh)} green notes, {notes[0][0]:.1f}–{notes[-1][1]:.1f}s')
    write_midi(notes, Path(a.out))
    if a.png:
        from PIL import Image
        Image.fromarray(img[::-1]).save(a.png)


if __name__ == '__main__':
    main()
