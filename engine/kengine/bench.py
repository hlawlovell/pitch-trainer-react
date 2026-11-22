"""The scoreboard: run the engine on every test song and score it against the correct answer.

Test songs live in engine/bench/<name>/song.json:
  {"youtube": "https://…", "artist": "…", "title": "…", "language": "zh",
   "reference": "reference.txt",        # hand-made UltraStar .txt, or a .mid
   "transpose": false,                   # true for sheet-music references in another key
   "lyrics": "lyrics.txt",               # optional: correct lyrics to use instead of LRCLIB
   "holdout": false}                     # true: only scored with --holdout (keeps tuning honest)

  python -m kengine.bench                    # all songs (downloads audio and runs every step once)
  python -m kengine.bench --from notes       # re-run only the notes step (seconds)
  python -m kengine.bench --set jump=0.5     # try a setting
  python -m kengine.bench reason wurenzhidao # only these songs
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import notes, pipeline, score

BENCH = Path(__file__).resolve().parent.parent / 'bench'
COLS = ['exact', 'pitch', 'semitone', 'octave', 'coverage', 'extra', 'short', 'seq', 'wer', 'word_ms', 'far']


def audio_for(d: Path, cfg: dict) -> Path:
    for ext in ('mp3', 'm4a', 'wav', 'webm', 'opus'):
        if (d / f'audio.{ext}').exists():
            return d / f'audio.{ext}'
    print(f'  downloading {cfg["youtube"]}', flush=True)
    subprocess.run([sys.executable, '-m', 'yt_dlp', '-q', '--no-playlist', '-f', 'bestaudio[protocol^=m3u8]/bestaudio',
                    '-x', '--audio-format', 'mp3', '-o', str(d / 'audio.%(ext)s'), cfg['youtube']], check=True)
    return d / 'audio.mp3'


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('songs', nargs='*')
    ap.add_argument('--from', dest='redo_from', choices=pipeline.STEPS)
    ap.add_argument('--set', action='append', default=[], help='notes setting, e.g. jump=0.5')
    ap.add_argument('--holdout', action='store_true', help='include held-out songs')
    ap.add_argument('--cpu', action='store_true')
    a = ap.parse_args(argv)
    opt = {k: float(v) for k, v in (s.split('=', 1) for s in a.set)}
    dirs = sorted(p.parent for p in BENCH.glob('*/song.json'))
    if a.songs:
        dirs = [d for d in dirs if d.name in a.songs]
    rows = []
    for d in dirs:
        cfg = json.loads((d / 'song.json').read_text(encoding='utf-8'))
        if cfg.get('holdout') and not a.holdout and not a.songs:
            continue
        if not (d / cfg['reference']).exists():
            print(f'== {d.name}: waiting for its reference ({cfg["reference"]}), skipped', flush=True)
            continue
        print(f'== {d.name}', flush=True)
        try:
            lyr = (d / cfg['lyrics']).read_text(encoding='utf-8') if cfg.get('lyrics') else None
            txt = pipeline.run(d / 'work', audio_for(d, cfg), cfg, lyr, a.redo_from, opt, gpu=not a.cpu)
            res = score.score(score.read_ultrastar_text(txt), score.read(d / cfg['reference']), cfg.get('transpose', False))
            rows.append((d.name, res))
            base = d / 'baseline.txt'  # e.g. UltraSinger's output, for comparison
            if base.exists():
                rows.append((d.name + ' (baseline)', score.score(score.read(base), score.read(d / cfg['reference']), cfg.get('transpose', False))))
        except Exception as e:
            print(f'  FAILED: {e}', flush=True)
            rows.append((d.name, None))
    print()
    print(f'{"song":28}' + ''.join(f'{c:>9}' for c in COLS))
    for name, r in rows:
        if r is None:
            print(f'{name:28}  failed'); continue
        print(f'{name:28}' + ''.join(f'{("" if r.get(c) is None else r[c]):>9}' for c in COLS))
    ok = [r for n, r in rows if r and not n.endswith('(baseline)')]
    if len(ok) > 1:
        avg = {c: round(sum(r.get(c) or 0 for r in ok) / len(ok), 1) for c in COLS}
        print(f'{"AVERAGE":28}' + ''.join(f'{avg[c]:>9}' for c in COLS))


if __name__ == '__main__':
    main()
