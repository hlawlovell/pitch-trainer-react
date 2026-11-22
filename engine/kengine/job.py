"""One song through kengine, in a process of its own (the service runs every song like this, so the
GPU models and buffers are freed afterwards, and a cancelled song can simply be killed).

  python -X utf8 -m kengine.job <work dir> <audio file> <job.json>

job.json: {"meta": {"artist", "title", "language"}, "lyrics": "..." or null}
Prints "STAGE: ..." as each step starts; the result is <work dir>/song.txt (+ lyrics.json etc.).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from . import pipeline


def main():
    work, audio, spec = sys.argv[1:4]
    a = json.loads(Path(spec).read_text(encoding='utf-8'))
    pipeline.run(Path(work), Path(audio), a['meta'], a.get('lyrics'),
                 progress=lambda s: print(f'STAGE: {s}', flush=True))


if __name__ == '__main__':
    main()
