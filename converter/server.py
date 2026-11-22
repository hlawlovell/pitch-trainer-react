"""
YouTube -> UltraStar converter service.

  POST /api/convert            {"url": "...", "language"?, "lyrics"?, "artist"?, "title"?} -> {"id": ...}
  GET  /api/jobs                                     -> [job, ...]   (newest first)
  GET  /api/jobs/<id>                                -> job
  GET  /api/jobs/<id>/files/<name>                   -> a file of the finished song
  DELETE /api/jobs/<id>                              -> forget a finished job (its folder stays on disk)

Jobs run one at a time (each one uses every CPU core). Steps:
  1. yt-dlp: metadata, MP3 audio, H.264 video (re-encoded if YouTube only offers VP9/AV1), thumbnail
  2. UltraSinger on the MP3: vocal separation, lyrics + timing, pitch -> UltraStar .txt
  3. tidy the folder: <Artist> - <Title>/{.txt,.mp3,.mp4,.jpg}, with #VIDEO/#COVER pointing at them
"""
import json, os, re, shutil, subprocess, sys, threading, time, uuid, glob
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote

SONGS = os.environ.get('SONGS_DIR', '/songs')          # finished folders (mounted from the host)
WORK = os.environ.get('WORK_DIR', '/work')             # scratch, per job
MODEL = os.environ.get('WHISPER_MODEL', 'medium')
MAX_MIN = float(os.environ.get('MAX_MINUTES', '12'))
US = '/opt/UltraSinger/src'
YT_URL = re.compile(r'^https://(www\.|m\.|music\.)?(youtube\.com/(watch\?|shorts/|live/)|youtu\.be/)\S+$')

jobs: dict[str, dict] = {}
queue: list[str] = []
lock = threading.Lock()
wake = threading.Event()

# UltraSinger log lines -> what the user sees
STAGES = [
    ('separat', 'Separating vocals from the music'),
    ('demucs', 'Separating vocals from the music'),
    ('whisper', 'Transcribing lyrics'),
    ('transcrib', 'Transcribing lyrics'),
    ('align', 'Timing the lyrics'),
    ('hyphen', 'Splitting words into syllables'),
    ('pitch', 'Detecting the sung notes'),
    ('swiftf0', 'Detecting the sung notes'),
    ('bpm', 'Working out the tempo'),
    ('ultrastar', 'Writing the song file'),
    ('midi', 'Writing the song file'),
]


def public(j):
    out = {k: j[k] for k in ('id', 'url', 'language', 'state', 'stage', 'name', 'error', 'files', 'log', 'created', 'started', 'finished')}
    out['hasLyrics'] = bool(j.get('lyrics'))
    return out


ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')


NOISE = re.compile(r'^\s*warnings\.warn\(|Warning:|Lightning automatically upgraded|upgrade_checkpoint')


def log(j, line):
    line = ANSI.sub('', line).rstrip()
    if not line or NOISE.search(line):  # library deprecation notices: harmless, and confusing as a progress line
        return
    j['log'] = (j['log'] + [line])[-12:]
    low = line.lower()
    for key, stage in STAGES:
        if key in low:
            j['stage'] = stage
            break


def run(j, cmd, cwd=None):
    """Run a command, streaming its output into the job log. Raises on failure."""
    p = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL, env={**os.environ, 'PYTHONWARNINGS': 'ignore'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, errors='replace', bufsize=1)
    j['_proc'] = p
    tail = []
    buf = ''
    while True:
        ch = p.stdout.read(1)
        if not ch:
            break
        if ch in '\r\n':  # progress bars use \r
            if buf.strip():
                log(j, buf)
                tail = (tail + [buf])[-30:]
            buf = ''
        else:
            buf += ch
    if buf.strip():
        log(j, buf); tail.append(buf)
    rc = p.wait()
    j['_proc'] = None
    if j.get('cancel'):
        raise RuntimeError('Cancelled')
    if rc != 0:
        raise RuntimeError(f'{os.path.basename(cmd[0]) if cmd[0] != sys.executable else cmd[1]} failed:\n' + '\n'.join(tail[-8:]))


def safe(s):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '', s).strip(' .')
    return re.sub(r'\s+', ' ', s)[:120] or 'Song'


JUNK = re.compile(r'\s*[\(\[][^)\]]*(official|video|audio|lyric|visuali[sz]er|hd|hq|4k|remaster|mv|m/v)[^)\]]*[\)\]]', re.I)


def song_name(info):
    artist, track = info.get('artist') or info.get('creator'), info.get('track')
    if artist and track:
        artist = artist.split(',')[0]
        return safe(f'{artist} - {JUNK.sub("", track)}')
    title = JUNK.sub('', info.get('title') or 'Song')
    title = re.sub(r'\s*(ft\.?|feat\.?)\s.*$', '', title, flags=re.I)
    if ' - ' in title:
        return safe(title)
    up = re.sub(r'\s*(VEVO|- Topic|Official)$', '', info.get('uploader') or info.get('channel') or '', flags=re.I).strip()
    return safe(f'{up} - {title}' if up else title)


def probe_codec(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return r.stdout.strip()


def set_tag(txt, tag, value):
    """Set (or add, after the last header line) an UltraStar #TAG."""
    lines = txt.split('\n')
    for i, l in enumerate(lines):
        if l.upper().startswith(f'#{tag}:'):
            lines[i] = f'#{tag}:{value}'
            return '\n'.join(lines)
    last = max((i for i, l in enumerate(lines) if l.startswith('#')), default=-1)
    lines.insert(last + 1, f'#{tag}:{value}')
    return '\n'.join(lines)


def work_dir(url):
    """Scratch folder per video, kept when a job fails, so a retry reuses UltraSinger's cache
    (vocal separation and lyrics are the slow parts)."""
    vid = re.search(r'(?:v=|youtu\.be/|shorts/|live/)([\w-]{6,})', url)
    return os.path.join(WORK, vid.group(1) if vid else uuid.uuid5(uuid.NAMESPACE_URL, url).hex[:12])


NOTE_LINE = re.compile(r'^([:*FRG]) (-?\d+) (\d+) (-?\d+) ?(.*)$')


def tidy_notes(txt):
    """Clean up UltraSinger's notes (checked against a hand-made file for The Reason: right octave for
    every note instead of 51%, ~45 fewer fragment notes):
      1. UltraSinger writes pitch = MIDI - 48 (0 = C3); UltraStar files use 0 = C4.
      2. A note more than 9 semitones from its neighbours' median is an octave glitch: fold it back.
      3. A short "~" continuation within 2 semitones of the note before it (vibrato, a slide, detector
         wobble), or any "~" at the same pitch, is merged into that note.
    Returns the new text and a summary."""
    m = re.search(r'^#BPM:([\d.,]+)', txt, re.M)
    if not m:
        return txt, 'no BPM'
    bpm = float(m.group(1).replace(',', '.'))
    sec = lambda beats: beats * 60 / (bpm * 4)
    lines = txt.split('\n')
    notes = []  # [line index, type, beat, length, pitch, text]
    for i, l in enumerate(lines):
        nm = NOTE_LINE.match(l)
        if nm:
            notes.append([i, nm[1], int(nm[2]), int(nm[3]), int(nm[4]) - 12, nm[5]])
    orig = [n[4] for n in notes]  # judge against the original pitches, or one fix shifts the next
    folded = 0
    for k, n in enumerate(notes):
        near = orig[max(0, k - 10):k] + orig[k + 1:k + 11]
        if not near:
            continue
        near.sort()
        med = near[len(near) // 2]
        p = n[4]
        while p - med > 9: p -= 12
        while med - p > 9: p += 12
        if p != n[4]:
            n[4] = p; folded += 1
    keep, merged = [], 0
    for n in notes:
        prev = keep[-1] if keep else None
        same_line = prev is not None and all(not (lines[i] or '').startswith(('-', '#', 'E', 'P')) for i in range(prev[0] + 1, n[0]))
        touching = same_line and n[2] - (prev[2] + prev[3]) <= 1
        if touching and n[5].strip() == '~' and (n[4] == prev[4] or (sec(n[3]) < 0.15 and abs(n[4] - prev[4]) <= 2)):
            prev[3] = n[2] + n[3] - prev[2]
            if n[5].endswith(' ') and not prev[5].endswith(' '):
                prev[5] += ' '
            lines[n[0]] = None
            merged += 1
            continue
        keep.append(n)
    for n in keep:
        lines[n[0]] = f'{n[1]} {n[2]} {n[3]} {n[4]} {n[5]}'
    return '\n'.join(l for l in lines if l is not None), f'{folded} octave glitches fixed, {merged} fragments merged ({len(notes)} -> {len(keep)} notes)'


RENOTE = dict(conf=0.6, fold=8, fold_win=1.0, stop=0.05, settle=0.05, jump=0.7, min_note=0.08,
              skip=0.04, share=0.25, share_zh=1.0, cap=2.0, squeezed_weight=0.3, melisma_gap=1.0)


def renote(txt, pitch, opt=None):
    """Rebuild the notes from the sung pitch itself, keeping UltraSinger's lyrics.

    UltraSinger cuts notes at Whisper's syllable times and gives each the most common pitch in its
    slice. When Whisper's timing is off (often, for Chinese: syllables squeezed into no time while the
    notes they were sung on are left unnamed), the slices cover the wrong stretch of singing and the
    melody flattens (无人之岛: 如果云层… came out G F F F F G… for A G A F F A…). Instead:
      1. clean the pitch track (confident frames, median-smoothed, octave glitches folded back);
      2. cut it into notes wherever the voice settles on a new pitch for ~50 ms, or stops;
      3. fit the syllables to those notes in order (dynamic programming on Whisper's start times, used
         only as rough positions); notes between syllables become "~" (one syllable over several notes).
    `pitch` is UltraSinger's SwiftF0 data {times, frequencies, confidence}. Output pitches use the
    UltraStar convention (0 = C4). Returns (text, summary)."""
    import math
    o = {**RENOTE, **(opt or {})}
    m = re.search(r'^#BPM:([\d.,]+)', txt, re.M)
    g = re.search(r'^#GAP:([\d.,]+)', txt, re.M)
    if not m or not g:
        return None, 'no BPM/GAP'
    spb = 60 / (float(m.group(1).replace(',', '.')) * 4)
    gap = float(g.group(1).replace(',', '.')) / 1000
    beat_t = lambda b: gap + b * spb

    # syllables from UltraSinger's file: text, start time, starts a lyric line?
    syl, line_start = [], True
    head = []
    for l in txt.split('\n'):
        if l.startswith('-'):
            line_start = True; continue
        nm = NOTE_LINE.match(l)
        if nm:
            t = nm[5]
            if t.strip() not in ('', '~'):
                syl.append({'t': beat_t(int(nm[2])), 'd': int(nm[3]) * spb, 'text': t, 'line': line_start})
                line_start = False
            elif t.endswith(' ') and syl:  # a "~ " ends the word: keep that word end
                syl[-1]['text'] = syl[-1]['text'].rstrip() + ' '
        elif l.strip() and l.strip() != 'E':
            head.append(l)
    if not syl:
        return None, 'no syllables'

    # 1. pitch track -> fractional MIDI per frame (None = not singing)
    T = pitch['times']
    x = [69 + 12 * math.log2(f / 440) if f > 0 and c >= o['conf'] else None
         for f, c in zip(pitch['frequencies'], pitch['confidence'])]
    if len(T) < 10:
        return None, 'no pitch data'
    hop = (T[-1] - T[0]) / (len(T) - 1)
    def med(v):
        v = sorted(v); n = len(v)
        return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2
    sm = []
    for i in range(len(x)):  # median of 5 frames: removes one-frame spikes
        w = [v for v in x[max(0, i - 2):i + 3] if v is not None]
        sm.append(med(w) if x[i] is not None and w else None)
    W = max(1, int(o['fold_win'] / hop))
    voiced = [(i, v) for i, v in enumerate(sm) if v is not None]
    for k, (i, v) in enumerate(voiced):  # fold octave glitches towards the surrounding second
        around = [u for _, u in voiced[max(0, k - W):k + W + 1]]
        c = med(around)
        while v - c > o['fold']: v -= 12
        while c - v > o['fold']: v += 12
        sm[i] = v

    # 2. cut into notes
    STOP = max(2, round(o['stop'] / hop))       # this many unvoiced frames end a note
    SETTLE = max(2, round(o['settle'] / hop))     # a new pitch must hold this long to start a note
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
            centre = med([sm[k] for k in cur[-12:]])
            if abs(v - centre) > o['jump']:
                ahead = [sm[k] for k in range(i, min(len(sm), i + SETTLE))]
                if len(ahead) == SETTLE and all(a is not None and abs(a - v) < o['jump'] and abs(a - centre) > o['jump'] - 0.1 for a in ahead):
                    close(); cur = []
        cur.append(i); i += 1
    close()
    for n in notes:
        n['p'] = round(med(n['f']))
    # very short notes are slides or glitches: join them to the neighbour closest in pitch (or drop)
    MIN = o['min_note']
    changed = True
    while changed:
        changed = False
        for k, n in enumerate(notes):
            if n['b'] - n['a'] >= MIN:
                continue
            nb = [(j, notes[j]) for j in (k - 1, k + 1) if 0 <= j < len(notes)
                  and (notes[j]['a'] - n['b'] < 0.05 if j > k else n['a'] - notes[j]['b'] < 0.05)]
            if nb:
                j, o = min(nb, key=lambda q: abs(q[1]['p'] - n['p']))
                o['a'], o['b'], o['f'] = min(o['a'], n['a']), max(o['b'], n['b']), o['f'] + n['f']
            del notes[k]; changed = True
            break
    merged = []  # same pitch, touching: one note
    for n in notes:
        if merged and merged[-1]['p'] == n['p'] and n['a'] - merged[-1]['b'] < 0.06:
            merged[-1]['b'] = n['b']; merged[-1]['f'] += n['f']
        else:
            merged.append(n)
    notes = merged
    for n in notes:
        n['p'] = round(med(n['f']))
    if not notes:
        return None, 'no notes found'

    # 3. syllables -> notes, in order (each syllable gets a note; a note may be shared if it must)
    S, M = len(syl), len(notes)
    INF = float('inf')
    # Chinese is sung one character per note, so sharing a note is a last resort there; elsewhere two
    # syllables on one long note is normal. A syllable Whisper squeezed into (almost) no time has an
    # unreliable time, so it pulls only weakly towards it.
    zh = is_chinese(''.join(s['text'] for s in syl))
    SKIP, SHARE, CAP = o['skip'], (o['share_zh'] if zh else o['share']), o['cap']
    weight = [o['squeezed_weight'] if s['d'] < 0.08 else 1.0 for s in syl]
    cost = lambda i, j: weight[i] * min(abs(syl[i]['t'] - notes[j]['a']), CAP)
    D = [[INF] * M for _ in range(S)]
    P = [[None] * M for _ in range(S)]
    for j in range(M):
        D[0][j] = cost(0, j) + SKIP * j * 0.25
    for i in range(1, S):
        best, bj = INF, None
        for j in range(M):
            if j > 0:  # come from an earlier note (notes in between become melisma)
                if D[i - 1][j - 1] < best + SKIP:
                    best, bj = D[i - 1][j - 1], j - 1
                else:
                    best += SKIP
            opts = [(best, bj)] if bj is not None else []
            opts.append((D[i - 1][j] + SHARE, j))  # share the same note
            v, pj = min(opts, key=lambda o: o[0])
            D[i][j], P[i][j] = v + cost(i, j), pj
    j = min(range(M), key=lambda q: D[S - 1][q])
    at = [0] * S
    for i in range(S - 1, -1, -1):
        at[i] = j
        if i: j = P[i][j]

    # 4. write the notes: a note shared by several syllables is split between them; notes after a
    #    syllable continue it ("~") unless a long pause says they're something else (dropped)
    out_notes = []  # (start s, end s, pitch, text, starts line)
    for j, n in enumerate(notes):
        mine = [i for i in range(S) if at[i] == j]
        if mine:
            step = (n['b'] - n['a']) / len(mine)
            for q, i in enumerate(mine):
                out_notes.append([n['a'] + q * step, n['a'] + (q + 1) * step, n['p'], syl[i]['text'].rstrip(' '), syl[i]['line'], i])
        elif out_notes and j > at[0] and n['a'] - out_notes[-1][1] < o['melisma_gap']:
            out_notes.append([n['a'], n['b'], n['p'], '~', False, out_notes[-1][5]])
    for k, o in enumerate(out_notes):  # the word's trailing space goes on its last note
        last_of_syl = k + 1 == len(out_notes) or out_notes[k + 1][5] != o[5]
        if last_of_syl and syl[o[5]]['text'].endswith(' '):
            o[3] += ' '
    body, end_b = [], None
    for k, (a, b, p, text, ls, _) in enumerate(out_notes):
        ba = max(round((a - gap) / spb), end_b if end_b is not None else -10**9)
        bb = max(ba + 1, round((b - gap) / spb))
        if ls and k:
            body.append(f'- {end_b}')
        body.append(f': {ba} {bb - ba} {p - 60} {text}')
        end_b = bb
    shared = sum(1 for j in range(M) if sum(1 for i in range(S) if at[i] == j) > 1)
    melisma = sum(1 for o in out_notes if o[3].strip() == '~')
    return '\n'.join(head + body + ['E', '']), f'{len(notes)} notes from the pitch, {S} syllables placed ({melisma} held over several notes, {shared} notes shared)'


def spread_squeezed(txt):
    """Whisper sometimes fails to time a run of syllables and squeezes them into (almost) no time, e.g.
    醒时间它 all at 29.95–29.99 s, while the notes they were really sung on sit just before them as
    unnamed "~" continuations at the start of the line. Move the squeezed syllables onto those notes;
    if there are none, share the next note's time between them."""
    m = re.search(r'^#BPM:([\d.,]+)', txt, re.M)
    if not m:
        return txt, 'no BPM'
    spb = 60 / (float(m.group(1).replace(',', '.')) * 4)
    lines = txt.split('\n')
    groups, cur = [], []  # notes per lyric line: [line index, type, beat, len, pitch, text]
    for i, l in enumerate(lines):
        if l.startswith('-') or l.strip() == 'E':
            if cur: groups.append(cur); cur = []
            continue
        nm = NOTE_LINE.match(l)
        if nm and nm[1] != 'F':
            cur.append([i, nm[1], int(nm[2]), int(nm[3]), int(nm[4]), nm[5]])
    if cur: groups.append(cur)
    is_syl = lambda n: n[5] is None or n[5].strip() not in ('', '~')  # None: split into syllables already
    moved = spread = 0
    for g in groups:
        k = 0
        while k < len(g):
            if not (is_syl(g[k]) and g[k][3] * spb < 0.08):
                k += 1; continue
            e = k
            while e < len(g) and is_syl(g[e]) and g[e][3] * spb < 0.08:
                e += 1
            run = g[k:e]
            orphans = [n for n in g[:k] if not is_syl(n)] if not any(is_syl(n) for n in g[:k]) else []
            if orphans:
                # sung on the unnamed notes before them: hand the syllables out in order
                texts = [n[5] for n in run]
                for n, t in zip(orphans, texts):
                    n[5] = t; moved += 1
                if len(texts) > len(orphans):  # more syllables than notes: split the last note between the rest
                    last = orphans[-1]
                    rest = texts[len(orphans) - 1:]
                    parts = min(len(rest), last[3])
                    if parts > 1:
                        step = last[3] / parts
                        segs = []
                        for j in range(parts):
                            b = last[2] + round(j * step)
                            ln = max(1, last[2] + round((j + 1) * step) - b)
                            t = rest[j] if j < parts - 1 else ''.join(x.strip() for x in rest[j:])
                            segs.append(f'{last[1]} {b} {ln} {last[4]} {t}')
                        lines[last[0]] = '\n'.join(segs)
                        last[5] = None  # written already
                    else:
                        last[5] = last[5].rstrip() + ''.join(t.strip() for t in texts[len(orphans):])
                for n in run:
                    lines[n[0]] = None
                g[k:e] = []
                k = 0
                continue
            # share a neighbouring note: the one the squeezed syllables' own pitch matches (their pitch
            # was measured at the moment they were placed, e.g. 是 at F4 next to 后 F4 and 春 C4),
            # as long as it's long enough to give each syllable at least 0.1 s
            prv = g[k - 1] if k > 0 and g[k - 1][5] is not None else None
            nxt = g[e] if e < len(g) and g[e][5] is not None else None
            parts = len(run) + 1
            ps = sorted(n[4] for n in run)
            pitch = ps[len(ps) // 2]
            def fits(n, side):
                if n is None: return False
                near = (run[0][2] - (n[2] + n[3])) if side == 'prev' else (n[2] - (run[-1][2] + run[-1][3]))
                return near * spb < 0.3 and n[3] * spb / parts >= 0.1
            cands = [(n, side) for n, side in ((prv, 'prev'), (nxt, 'next')) if fits(n, side)]
            if cands:
                host, side = min(cands, key=lambda c: (abs(c[0][4] - pitch), -c[0][3]))
                order = [host] + run if side == 'prev' else run + [host]
                first, step = host[2], host[3] / parts
                hp = host[4]
                for j, n in enumerate(order):
                    b = first + round(j * step)
                    n[2], n[3], n[4] = b, max(1, first + round((j + 1) * step) - b), hp
                spread += len(run)
            k = e + 1
        for n in g:
            if lines[n[0]] is not None and n[5] is not None:
                lines[n[0]] = f'{n[1]} {n[2]} {n[3]} {n[4]} {n[5]}'
    return '\n'.join(l for l in lines if l is not None), f'{moved} squeezed syllables moved onto their notes, {spread} spread out'


def apply_lyrics(txt, lyrics):
    """Replace the transcribed words with the user's lyrics, keeping every note's timing and pitch.

    The generated notes are grouped into words (a word starts at a note with a leading space, at the
    start of a line, or after a note ending in a space). The two word sequences are matched with an
    edit-distance alignment that prefers pairing similar words, so misheard words get replaced,
    a word Whisper missed is added to its neighbour's note, and a word Whisper invented becomes a
    continuation ("~") of the word before it. UltraStar line breaks are kept."""
    import difflib
    lines = txt.split('\n')
    # Chinese is sung one character per note, with or without spaces between them
    zh = is_chinese(''.join(nm[5] for nm in map(NOTE_LINE.match, lines) if nm))
    words, cur, line_start = [], None, True  # word = list of line indexes of its notes
    for i, l in enumerate(lines):
        if l.startswith('-'):
            line_start = True
            continue
        nm = NOTE_LINE.match(l)
        if not nm or nm[1] == 'F':
            continue
        text = nm[5]
        if cur is None or line_start or text.startswith(' ') or (cur and lines[cur[-1]].endswith(' ')) \
                or (zh and text.strip() not in ('', '~')):
            cur = [i]; words.append(cur)
        else:
            cur.append(i)
        line_start = False
    if is_chinese(lyrics):  # Chinese is sung (and transcribed) one character per word
        user = re.findall(r'[㐀-鿿豈-﫿]|[^\s㐀-鿿豈-﫿]+', lyrics)
    else:
        user = lyrics.split()
    if not words or not user:
        return txt, 'no words to match'

    norm = lambda s: re.sub(r'[^\w]', '', s.lower())
    gen = [norm(''.join(NOTE_LINE.match(lines[i])[5] for i in w).replace('~', '')) for w in words]
    us = [norm(u) for u in user]
    G, U = len(gen), len(us)
    GAP = 0.7
    sub = lambda a, b: 1 - difflib.SequenceMatcher(None, a, b).ratio() if a or b else 0
    D = [[0.0] * (U + 1) for _ in range(G + 1)]
    for a in range(1, G + 1): D[a][0] = a * GAP
    for b in range(1, U + 1): D[0][b] = b * GAP
    for a in range(1, G + 1):
        for b in range(1, U + 1):
            D[a][b] = min(D[a - 1][b - 1] + sub(gen[a - 1], us[b - 1]), D[a - 1][b] + GAP, D[a][b - 1] + GAP)
    assign = [[] for _ in range(G)]   # user words for each generated word
    pending = []                      # user words before the first matched generated word
    a, b = G, U
    ops = []
    while a > 0 or b > 0:
        if a > 0 and b > 0 and abs(D[a][b] - (D[a - 1][b - 1] + sub(gen[a - 1], us[b - 1]))) < 1e-9:
            ops.append(('pair', a - 1, b - 1)); a -= 1; b -= 1
        elif a > 0 and abs(D[a][b] - (D[a - 1][b] + GAP)) < 1e-9:
            ops.append(('extra', a - 1, None)); a -= 1
        else:
            ops.append(('missing', None, b - 1)); b -= 1
    ops.reverse()
    last = None
    for op, ga, ub in ops:
        if op == 'pair':
            assign[ga].append(user[ub]); last = ga
        elif op == 'missing':
            if last is None: pending.append(user[ub])
            else: assign[last].append(user[ub])
    if pending:
        first = next((k for k in range(G) if assign[k]), 0)
        assign[first] = pending + assign[first]

    def rewrite(i, text):
        nm = NOTE_LINE.match(lines[i])
        lines[i] = f'{nm[1]} {nm[2]} {nm[3]} {nm[4]} {text}'

    replaced = sum(1 for k in range(G) if assign[k])
    for k, w in enumerate(words):
        if assign[k]:
            sep = '' if is_chinese(''.join(assign[k])) else ' '
            rewrite(w[0], sep.join(assign[k]) + (' ' if len(w) == 1 else ''))
            for i in w[1:-1]: rewrite(i, '~')
            if len(w) > 1: rewrite(w[-1], '~ ')
        else:  # a word the user's lyrics don't have: hold the previous word through it
            for i in w[:-1]: rewrite(i, '~')
            rewrite(w[-1], '~ ')
    return '\n'.join(lines), f'{U} words from your lyrics placed on {replaced} of {G} sung words'


HAN = re.compile(r'[㐀-鿿豈-﫿]')
KANA_HANGUL = re.compile(r'[぀-ヿ가-힯]')


def is_chinese(text):
    """Chinese characters and no Japanese kana or Korean hangul (Japanese also uses Chinese characters)."""
    return bool(HAN.search(text)) and not KANA_HANGUL.search(text)


def chinese_lyrics(txt):
    """For Chinese songs:
      - convert to simplified characters (Whisper mixes simplified and traditional: 后/後, 云/雲);
      - drop the spaces Whisper puts between characters;
      - re-split the lines at pauses in the singing. Chinese has no spaces or punctuation for
        UltraSinger to split on, so its lines can run to 30+ characters."""
    from opencc import OpenCC
    t2s = OpenCC('t2s')
    m = re.search(r'^#BPM:([\d.,]+)', txt, re.M)
    sec = lambda beats: beats * 60 / (float(m.group(1).replace(',', '.')) * 4)
    head, notes = [], []
    for l in txt.split('\n'):
        nm = NOTE_LINE.match(l)
        if nm:
            # characters run together, so no spaces at all (a "~ " continuation's space would show too)
            notes.append([nm[1], int(nm[2]), int(nm[3]), nm[4], t2s.convert(nm[5]).replace(' ', '')])
        elif l.startswith('-') or l.strip() == 'E' or not l.strip():
            continue
        else:
            head.append(t2s.convert(l) if l.startswith(('#TITLE', '#ARTIST')) else l)
    if not notes:
        return txt, 'no notes'
    size = [len(HAN.findall(n[4])) or (1 if n[4].strip('~') else 0) for n in notes]  # characters shown
    gap = [0.0] + [sec(notes[k][1] - (notes[k - 1][1] + notes[k - 1][2])) for k in range(1, len(notes))]
    # how long each character is held, counting the "~" continuation notes that follow it
    held = [0.0] * len(notes)
    for k in range(len(notes)):
        e = k + 1
        while e < len(notes) and notes[e][4].strip() in ('', '~') and gap[e] < 0.1:
            e += 1
        held[k] = sec(notes[e - 1][1] + notes[e - 1][2] - notes[k][1])

    # word boundaries (Chinese has no spaces): a line may only break between words
    import jieba, logging
    jieba.setLogLevel(logging.WARNING)
    text = ''.join(n[4].replace('~', '') for n in notes)
    bounds, pos = set(), 0
    for w in jieba.cut(text):
        pos += len(w); bounds.add(pos)
    at, offs = 0, []
    for n in notes:  # character offset where each note starts
        offs.append(at); at += len(n[4].replace('~', ''))
    word_start = [offs[k] in bounds or offs[k] == 0 for k in range(len(notes))]

    # phrases: split at breaths (pauses of 0.45 s or more), between words unless the pause is long
    phrases, start = [], 0
    for k in range(1, len(notes)):
        if gap[k] >= 0.45 and sum(size[start:k]) >= 3 and (word_start[k] or gap[k] >= 1.0):
            phrases.append((start, k)); start = k
    phrases.append((start, len(notes)))

    # a phrase too long to read in one line is split at its longest pause, repeatedly
    MAX = 14
    def split(a, b):
        if sum(size[a:b]) <= MAX:
            return [(a, b)]
        cands = [k for k in range(a + 1, b) if sum(size[a:k]) >= 4 and sum(size[k:b]) >= 4]
        cands = [k for k in cands if word_start[k] and size[k]] or cands  # a character starting a word
        if not cands:
            return [(a, b)]
        # a phrase ends where the singer pauses, and its last syllable is usually held
        k = max(cands, key=lambda k: gap[k] + 0.6 * held[k - 1] - 0.02 * abs(sum(size[a:k]) - sum(size[k:b])))
        return split(a, k) + split(k, b)
    breaks = [k for a, b in phrases for (k, _) in split(a, b)][1:]

    out = []
    for k, n in enumerate(notes):
        if k in breaks:
            p = notes[k - 1]
            out.append(f'- {p[1] + p[2]}')
        out.append(f'{n[0]} {n[1]} {n[2]} {n[3]} {n[4]}')
    lines_before = sum(1 for l in txt.split('\n') if l.startswith('-')) + 1
    lines_after = len(breaks) + 1
    return '\n'.join(head + out + ['E', '']), f'simplified, {lines_before} -> {lines_after} lines'


def finish_notes(j, txt, pitch_path):
    """UltraSinger's raw file -> the final notes and lyrics."""
    rebuilt = None
    if pitch_path:
        try:
            with open(pitch_path, encoding='utf-8') as f:
                rebuilt, summary = renote(txt, json.load(f))
            log(j, f'Notes: {summary}' if rebuilt else f'Notes: kept UltraSinger\'s ({summary})')
        except Exception as e:  # never lose a song over this step: fall back to UltraSinger's notes
            log(j, f'Notes: kept UltraSinger\'s ({e})')
    if rebuilt:
        txt = rebuilt
    else:
        txt, summary = spread_squeezed(txt)
        log(j, f'Timing: {summary}')
    if j.get('lyrics'):
        txt, summary = apply_lyrics(txt, j['lyrics'])
        log(j, f'Your lyrics: {summary}')
    if not rebuilt:
        txt, summary = tidy_notes(txt)  # (renote already writes clean notes in the right octave)
        log(j, f'Tidied notes: {summary}')
    if is_chinese('\n'.join(l for l in txt.split('\n') if NOTE_LINE.match(l))):
        txt, summary = chinese_lyrics(txt)
        log(j, f'Chinese lyrics: {summary}')
    return txt


def download(j):
    """yt-dlp: details, MP3 audio, H.264 video, thumbnail -> dict(work, name, mp3, video, info).
    Shared with the kengine service (engine/kengine/service.py)."""
    work = work_dir(j['url'])
    shutil.rmtree(os.path.join(work, 'in'), ignore_errors=True)
    for f in glob.glob(os.path.join(work, 'video.*')) + glob.glob(os.path.join(work, 'thumb.*')):
        os.remove(f)
    os.makedirs(work, exist_ok=True)
    yt = [sys.executable, '-m', 'yt_dlp', '--no-playlist', '--no-progress', '--newline']

    j['stage'] = 'Reading the video details'
    r = subprocess.run(yt + ['-J', j['url']], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('Could not read that video: ' + (r.stderr.strip().splitlines() or ['unknown error'])[-1])
    info = json.loads(r.stdout)
    if (info.get('duration') or 0) > MAX_MIN * 60:
        raise RuntimeError(f'That video is {info["duration"] / 60:.0f} minutes long; the limit is {MAX_MIN:.0f}.')
    name = song_name(info)
    j['name'] = name

    # YouTube often refuses the direct (DASH) streams with 403 while the HLS (m3u8) ones download fine,
    # so try HLS first and fall back format by format.
    def fetch(selectors, extra):
        err = None
        for sel in selectors:
            try:
                return run(j, yt + ['-f', sel] + extra)
            except RuntimeError as e:
                if j.get('cancel'):
                    raise
                err = e
                log(j, f'(format "{sel}" failed, trying the next one)')
        raise err

    j['stage'] = 'Downloading audio'
    fetch(['bestaudio[protocol^=m3u8]', 'bestaudio', 'best[protocol^=m3u8]', 'best'],
          ['-x', '--audio-format', 'mp3', '--audio-quality', '2', '-o', os.path.join(work, 'in', f'{name}.%(ext)s'), j['url']])
    mp3 = os.path.join(work, 'in', f'{name}.mp3')

    j['stage'] = 'Downloading video'
    vid = os.path.join(work, 'video')
    try:
        fetch(['bv*[vcodec^=avc1][height<=720][protocol^=m3u8]', 'bv*[vcodec^=avc1][height<=720]',
               'bv*[height<=720][protocol^=m3u8]', 'bv*[height<=720]', 'b[height<=720]'],
              ['-o', vid + '.%(ext)s', j['url']])
        got = glob.glob(vid + '.*')[0]
        if probe_codec(got) != 'h264':  # browsers can't rely on anything else inside .mp4
            j['stage'] = 'Converting video for the browser'
            run(j, ['ffmpeg', '-v', 'error', '-y', '-i', got, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
                    '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', vid + '.h264.mp4'])
            got = vid + '.h264.mp4'
        else:
            run(j, ['ffmpeg', '-v', 'error', '-y', '-i', got, '-c', 'copy', '-an', '-movflags', '+faststart', vid + '.final.mp4'])
            got = vid + '.final.mp4'
        video = got
    except Exception as e:  # a song without its video is still useful
        log(j, f'(video skipped: {e})')
        video = None
    subprocess.run(yt + ['--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg',
                         '-o', os.path.join(work, 'thumb.%(ext)s'), j['url']], capture_output=True)
    return dict(work=work, name=name, mp3=mp3, video=video, info=info)


def new_song_dir(name):
    """converted-songs/<name>, or <name> (2), (3)... if taken."""
    dest = os.path.join(SONGS, name)
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(SONGS, f'{name} ({n})'); n += 1
    os.makedirs(dest)
    return dest


def convert(j):
    d = download(j)
    work, name, mp3, video = d['work'], d['name'], d['mp3'], d['video']

    j['stage'] = 'Starting UltraSinger (first run downloads its AI models)'
    out = os.path.join(work, 'out')
    for d in glob.glob(os.path.join(out, '*')):  # song folders from a failed attempt; keep its cache
        if os.path.basename(d) != 'cache':
            shutil.rmtree(d, ignore_errors=True)
    run(j, [sys.executable, 'UltraSinger.py', '-i', mp3, '-o', out, '--whisper', MODEL,
            '--whisper_compute_type', 'int8', '--force_cpu', '--format_version', '1.1.0', '--keep_cache']
        + (['--language', j['language']] if j.get('language') else []), cwd=US)

    txts = [t for t in glob.glob(os.path.join(out, '**', '*.txt'), recursive=True) if '/cache/' not in t]
    if not txts:
        raise RuntimeError('UltraSinger finished without writing a song file.')
    src_dir = os.path.dirname(txts[0])
    with open(txts[0], encoding='utf-8', errors='replace') as f:
        txt = f.read()
    title = re.search(r'^#TITLE:(.*)$', txt, re.M)
    artist = re.search(r'^#ARTIST:(.*)$', txt, re.M)
    final_name = safe(f'{artist.group(1).strip()} - {title.group(1).strip()}') if title and artist else name
    if j.get('artist') and j.get('title'):  # given by the caller (kengine's parse of the video title):
        final_name = safe(f'{j["artist"]} - {j["title"]}')  # better than UltraSinger's online guess
        txt = set_tag(set_tag(txt, 'ARTIST', j['artist']), 'TITLE', j['title'])

    dest = new_song_dir(final_name)
    base = os.path.basename(dest)
    audio_tag = re.search(r'^#(?:AUDIO|MP3):(.*)$', txt, re.M)
    audio_src = os.path.join(src_dir, audio_tag.group(1).strip()) if audio_tag else mp3
    if not os.path.exists(audio_src):
        audio_src = mp3
    shutil.copy(audio_src, os.path.join(dest, f'{base}.mp3'))
    txt = set_tag(txt, 'MP3', f'{base}.mp3')
    if '#AUDIO:' in txt.upper():
        txt = set_tag(txt, 'AUDIO', f'{base}.mp3')
    covers = [c for c in glob.glob(os.path.join(src_dir, '*.jp*g')) + glob.glob(os.path.join(src_dir, '*.png'))] \
        or glob.glob(os.path.join(work, 'thumb.jpg'))
    if covers:
        shutil.copy(covers[0], os.path.join(dest, f'{base}.jpg'))
        txt = set_tag(txt, 'COVER', f'{base}.jpg')
    # the separated vocals/instrumental aren't copied, so don't point at them
    txt = '\n'.join(l for l in txt.split('\n') if not re.match(r'#(VOCALS|INSTRUMENTAL):', l, re.I))
    # keep UltraSinger's output and pitch track, so the notes can be rebuilt later without re-converting
    keep = os.path.join(WORK, '_keep', os.path.basename(work))
    os.makedirs(keep, exist_ok=True)
    with open(os.path.join(keep, 'ultrasinger.txt'), 'w', encoding='utf-8') as f:
        f.write(txt)
    # UltraSinger keeps its cache inside the song's own folder: out/<song>/cache/
    pitch_files = glob.glob(os.path.join(out, '**', 'cache', 'swiftf0_*.json'), recursive=True)
    if pitch_files:
        shutil.copy(pitch_files[0], os.path.join(keep, 'pitch.json'))
    with open(os.path.join(keep, 'song.json'), 'w', encoding='utf-8') as f:
        json.dump({'url': j['url'], 'folder': os.path.basename(dest)}, f, ensure_ascii=False)
    txt = finish_notes(j, txt, pitch_files[0] if pitch_files else None)
    if video:
        shutil.move(video, os.path.join(dest, f'{base}.mp4'))
        txt = set_tag(txt, 'VIDEO', f'{base}.mp4')
        txt = set_tag(txt, 'VIDEOGAP', '0')
    with open(os.path.join(dest, f'{base}.txt'), 'w', encoding='utf-8') as f:
        f.write(txt)
    j['name'] = base
    j['dir'] = dest
    j['files'] = sorted(os.listdir(dest))
    shutil.rmtree(work, ignore_errors=True)


def worker():
    while True:
        wake.wait()
        with lock:
            jid = queue.pop(0) if queue else None
            if not queue:
                wake.clear()
        if not jid:
            continue
        j = jobs[jid]
        if j.get('cancel'):
            continue
        j['state'], j['started'] = 'running', time.time()
        save_jobs()
        try:
            convert(j)
            j['state'], j['stage'] = 'done', 'Done'
        except Exception as e:
            j['state'], j['error'] = 'error', str(e)  # work dir kept: a retry resumes from its cache
        j['finished'] = time.time()
        save_jobs()


JOBS_FILE = os.path.join(WORK, 'jobs.json')


def save_jobs():
    """Keep the job list on disk, so a restart (e.g. rebuilding the converter) doesn't lose the queue."""
    try:
        data = [{k: v for k, v in j.items() if not k.startswith('_')} for j in jobs.values()]
        tmp = JOBS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, JOBS_FILE)
    except OSError as e:
        print('could not save jobs:', e, flush=True)


def load_jobs():
    """Restore saved jobs; anything queued or cut off mid-conversion goes back in the queue, oldest first
    (an interrupted one resumes from its cached vocals and lyrics)."""
    try:
        with open(JOBS_FILE, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    for j in sorted(data, key=lambda j: j.get('created', 0)):
        j['_proc'] = None
        if j.get('state') in ('queued', 'running') and not j.get('cancel'):
            j['state'], j['stage'] = 'queued', 'Waiting for the previous song to finish'
            queue.append(j['id'])
        jobs[j['id']] = j
    if queue:
        wake.set()
        print(f'resuming {len(queue)} queued job(s)', flush=True)


class H(BaseHTTPRequestHandler):
    def send(self, code, body=None, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass

    def do_GET(self):
        parts = [unquote(p) for p in self.path.split('?')[0].strip('/').split('/')]
        if parts[:2] != ['api', 'jobs']:
            return self.send(404, {'error': 'not found'})
        if len(parts) == 2:
            return self.send(200, [public(j) for j in sorted(jobs.values(), key=lambda j: -j['created'])])
        j = jobs.get(parts[2])
        if not j:
            return self.send(404, {'error': 'no such job'})
        if len(parts) == 3:
            return self.send(200, public(j))
        if len(parts) == 5 and parts[3] == 'files' and j['state'] == 'done' and parts[4] in j['files']:
            path = os.path.join(j['dir'], parts[4])
            ext = parts[4].rsplit('.', 1)[-1].lower()
            ctype = {'mp3': 'audio/mpeg', 'mp4': 'video/mp4', 'jpg': 'image/jpeg', 'txt': 'text/plain; charset=utf-8'}.get(ext, 'application/octet-stream')
            with open(path, 'rb') as f:
                return self.send(200, f.read(), ctype)
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path.rstrip('/') != '/api/convert':
            return self.send(404, {'error': 'not found'})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        except ValueError:
            return self.send(400, {'error': 'bad request'})
        url = str(body.get('url', '')).strip()
        if not YT_URL.match(url):
            return self.send(400, {'error': 'That doesn\'t look like a YouTube link.'})
        language = str(body.get('language') or '').strip().lower()
        if language and not re.fullmatch(r'[a-z]{2}', language):
            return self.send(400, {'error': 'Language should be a two-letter code, like "de".'})
        lyrics = str(body.get('lyrics') or '').strip()
        # optional: the song's artist and title (one line each; they go into #ARTIST/#TITLE)
        artist, title = (re.sub(r'[\r\n#]', ' ', str(body.get(k) or '')).strip()[:200] for k in ('artist', 'title'))
        if len(lyrics) > 20000:
            return self.send(400, {'error': 'Those lyrics are too long (20,000 characters at most).'})
        jid = uuid.uuid4().hex[:10]
        jobs[jid] = {'id': jid, 'url': url, 'language': language or None, 'lyrics': lyrics or None,
                     'artist': artist or None, 'title': title or None, 'state': 'queued', 'stage': 'Waiting for the previous song to finish',
                     'name': None, 'error': None, 'files': [], 'log': [], 'created': time.time(),
                     'started': None, 'finished': None, 'dir': None, '_proc': None}
        with lock:
            queue.append(jid)
            wake.set()
        save_jobs()
        self.send(200, {'id': jid})

    def do_DELETE(self):
        parts = self.path.strip('/').split('/')
        j = jobs.get(parts[2]) if len(parts) == 3 and parts[:2] == ['api', 'jobs'] else None
        if not j:
            return self.send(404, {'error': 'no such job'})
        if j['state'] in ('queued', 'running'):  # cancel
            j['cancel'] = True
            if j.get('_proc'):
                j['_proc'].kill()
            if j['state'] == 'queued':
                j['state'], j['error'] = 'error', 'Cancelled'
        else:
            jobs.pop(j['id'], None)
        save_jobs()
        self.send(200, {'ok': True})


if __name__ == '__main__':
    os.makedirs(SONGS, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    load_jobs()
    threading.Thread(target=worker, daemon=True).start()
    print(f'converter listening on :8000 (whisper model {MODEL})', flush=True)
    ThreadingHTTPServer(('0.0.0.0', 8000), H).serve_forever()
