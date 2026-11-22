"""Add a test song to the scoreboard (engine/bench/<name>/).

  python -X utf8 -m kengine.add wurenzhidao --youtube https://www.youtube.com/watch?v=3AllSrBdZkw \
      --reference "C:/Users/hlawl/Downloads/无人之岛.mid" --artist 任然 --title 无人之岛 --language zh

  --reference   the correct answer: a hand-made UltraStar .txt, or a .mid (the melody is taken from the
                track with the highest notes, top voice). MIDI references are scored with key search on
                (--no-transpose to turn it off), since sheet-music MIDIs are often in another key.
  --youtube / --audio   where the audio comes from (YouTube is downloaded on the first run; --audio
                copies a local file, best when the reference was made for that exact recording).
  --holdout     only scored when named or with --holdout (keeps tuning honest).
  --lrclib-title  title to search LRCLIB with, if it differs (e.g. "unravel" for "Unravel (TV)").
  --lyrics      a text file with the correct lyrics, used instead of LRCLIB.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent / 'bench'


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('name')
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--youtube')
    src.add_argument('--audio')
    ap.add_argument('--reference', required=True)
    ap.add_argument('--artist', required=True)
    ap.add_argument('--title', required=True)
    ap.add_argument('--language', default='en')
    ap.add_argument('--holdout', action='store_true')
    ap.add_argument('--no-transpose', action='store_true')
    ap.add_argument('--lrclib-title')
    ap.add_argument('--lyrics')
    a = ap.parse_args(argv)
    d = BENCH / a.name
    (d / 'work').mkdir(parents=True, exist_ok=True)
    ref = Path(a.reference)
    ref_name = 'reference' + ref.suffix.lower()
    shutil.copy(ref, d / ref_name)
    cfg = {'artist': a.artist, 'title': a.title, 'language': a.language, 'reference': ref_name,
           'transpose': ref.suffix.lower() in ('.mid', '.midi', '.kar') and not a.no_transpose}
    if a.youtube:
        cfg['youtube'] = a.youtube
    else:
        shutil.copy(a.audio, d / ('audio' + Path(a.audio).suffix.lower()))
    if a.holdout:
        cfg['holdout'] = True
    if a.lrclib_title:
        cfg['lrclib_title'] = a.lrclib_title
    if a.lyrics:
        shutil.copy(a.lyrics, d / 'lyrics.txt'); cfg['lyrics'] = 'lyrics.txt'
    (d / 'song.json').write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'added {d}  ->  run: python -X utf8 -m kengine.bench {a.name}')
    if ref.suffix.lower() in ('.mid', '.midi', '.kar'):
        from . import score
        mel = score.read_midi(d / ref_name).notes
        print(f'  MIDI melody: {len(mel)} notes, {mel[0].start:.1f}–{mel[-1].end:.1f}s' if mel else '  MIDI melody: no notes found!')


if __name__ == '__main__':
    main()
