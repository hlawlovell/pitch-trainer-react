"""Lyrics by speech recognition, for songs with no lyrics anywhere (not on LRCLIB, none pasted).

Whisper (faster-whisper, CPU, int8) on the separated vocals gives the words and rough times; the
lines it produces then go through the same forced alignment as any other lyrics, which does the
precise timing. Whisper mishears sung words, so this is the last resort: LRCLIB or pasted lyrics
are always preferred.

Model: KENGINE_WHISPER (default "medium", ~1.5 GB, downloaded to engine/models/whisper on first use).
"""
from __future__ import annotations

import os
from pathlib import Path

from .lyrics import Line

MODELS = Path(__file__).resolve().parent.parent / 'models' / 'whisper'
MAX_WORDS = 12     # a lyric line is rarely longer
PAUSE = 0.45       # a pause this long between words starts a new line (s)


def lines_from_speech(audio16k, language: str | None = None) -> tuple[list[Line], str]:
    """audio16k: the vocals as 16 kHz mono float32 samples (passed as samples: faster-whisper's own
    file reader breaks with PyAV 19). -> (lines with start times, detected language code)."""
    from faster_whisper import WhisperModel
    size = os.environ.get('KENGINE_WHISPER', 'medium')
    model = WhisperModel(size, device='cpu', compute_type='int8', download_root=str(MODELS))
    segments, info = model.transcribe(audio16k, language=language or None, beam_size=5, vad_filter=False,
                                      word_timestamps=True, condition_on_previous_text=False)
    lines: list[Line] = []
    for seg in segments:
        words = [w for w in (seg.words or []) if w.word.strip()]
        if not words:
            if seg.text.strip():
                lines.append(Line(float(seg.start), seg.text.strip()))
            continue
        cur, start, last_end = [], None, None
        for w in words:
            if cur and (w.start - last_end >= PAUSE or len(cur) >= MAX_WORDS):
                lines.append(Line(float(start), ''.join(cur).strip()))
                cur, start = [], None
            if start is None:
                start = w.start
            cur.append(w.word)
            last_end = w.end
        if cur:
            lines.append(Line(float(start), ''.join(cur).strip()))
    # Whisper sometimes repeats a line in a loop over silence: drop immediate exact repeats past 2
    out: list[Line] = []
    for l in lines:
        if not any(ch.isalpha() for ch in l.text):  # "-", "♪", "..."
            continue
        if len(out) >= 2 and out[-1].text == l.text == out[-2].text:
            continue
        out.append(l)
    return out, info.language
