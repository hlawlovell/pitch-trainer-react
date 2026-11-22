"""kengine as the app's YouTube -> UltraStar converter: a small service that runs natively on Windows
(the GPU, through DirectML, isn't reachable from Docker).

  start-kengine.cmd      (or: .venv\\Scripts\\python.exe -X utf8 -m kengine.service)

Same API as the Docker converter (converter/server.py, whose job queue, HTTP handler and download
step are reused as-is), on 127.0.0.1:8002. The app's nginx sends /api/ here, and to the Docker
converter when this service isn't running.

Each song:
  1. download: details, MP3, H.264 video, thumbnail (converter.download)
  2. kengine: vocals, pitch, lyrics (LRCLIB or pasted, with timestamps), alignment, notes
  3. lyric check: if the lyrics can't be trusted (none found, pasted without timestamps, a poor
     fit, or a big shift although both versions are the same length), the song is handed to the
     Docker converter (UltraSinger, which transcribes the words itself) and its result is used
  4. folder: converted-songs/<Artist - Title>/{.txt,.mp3,.mp4,.jpg}
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # the app's folder
os.environ.setdefault('SONGS_DIR', str(ROOT / 'converted-songs'))
os.environ.setdefault('WORK_DIR', str(ROOT / 'engine' / 'service-work'))
os.environ['PYTHONUTF8'] = '1'  # yt-dlp & co. print song names in UTF-8
sys.path.insert(0, str(ROOT / 'converter'))
import server as conv  # noqa: E402  (converter/server.py)


PORT = int(os.environ.get('KENGINE_PORT', '8002'))
BACKUP = os.environ.get('BACKUP_CONVERTER', 'http://127.0.0.1:8001')
MIN_FIT = 0.2     # best lyric-fit score below this: the lyrics don't match the singing
MAX_SHIFT = 4.0   # a shift bigger than this (s) is suspicious…
SAME_LEN = 3.0    # …when the video and the lyrics' version are this close in length (s)

_log = conv.log


def _stage_or_log(j, line):
    """kengine.job prints "STAGE: ..." as each step starts: show it as the job's stage."""
    if line.startswith('STAGE: '):
        j['stage'] = line[7:].strip()
    else:
        _log(j, line)


conv.log = _stage_or_log

_public = conv.public
conv.public = lambda j: {**_public(j), 'engine': j.get('engine')}


QUOTED = re.compile(r"^(.+?)\s*['‘’\"“”「『〈《]\s*(.+?)\s*['’‘\"”“」』〉》]")   # BTS (방탄소년단) 'I NEED U' Official MV
TAIL = re.compile(r'\s*[-|/]?\s*(official\s*)?(music\s*video|m/?v|lyrics?( video)?|audio|visuali[sz]er|live|performance)\b.*$', re.I)
PARENS = re.compile(r'\s*[\(\[【（][^\)\]】）]*[\)\]】）]')


def meta_of(info: dict, name: str) -> tuple[str, str]:
    """Artist and title for the lyrics search, from YouTube's music metadata or the video title.
    Handles "Artist - Title (Official Video)", K-pop style "ARTIST (한글) 'SONG' Official MV" and
    "Title" uploaded by "Artist - Topic"/"ArtistVEVO"."""
    artist, track = info.get('artist') or info.get('creator'), info.get('track')
    if artist and track:
        return artist.split(',')[0].strip(), PARENS.sub('', conv.JUNK.sub('', track)).strip()
    title = info.get('title') or name
    m = QUOTED.match(title)
    if m:
        a, t = PARENS.sub('', m.group(1)).strip(' -_|'), m.group(2)
        if re.search(r'[A-Za-z]', a):  # "IVE 아이브": keep the Latin name
            a = re.sub(r'\s*[가-힣ぁ-ヿ一-鿿]+$', '', a).strip()
        if a:
            return a, t.strip()
    t = TAIL.sub('', PARENS.sub('', conv.JUNK.sub('', title))).strip(' -_|')
    if ' - ' in t:
        a, t = t.split(' - ', 1)
        return a.strip(), TAIL.sub('', t).strip()
    up = re.sub(r'\s*(VEVO|- Topic|Official)$', '', info.get('uploader') or info.get('channel') or '', flags=re.I).strip()
    return up, t


def lyrics_doubt(kwork: Path) -> str | None:
    """Why the lyrics can't be trusted, or None."""
    L = json.loads((kwork / 'lyrics.json').read_text(encoding='utf-8'))
    best = L['candidates'][0][1] if L.get('candidates') else 0.0
    off, diff = L.get('offset', 0.0), L.get('length_diff', 0.0)
    if L.get('source', '').startswith('speech'):
        return None  # transcribed: the backup converter would only transcribe them too
    if best < MIN_FIT:
        return f'the lyrics matched the singing poorly (fit {best:.2f})'
    if abs(off) > MAX_SHIFT and abs(diff) < SAME_LEN:
        return f'the lyrics needed a {off:+.0f} s shift although both versions are the same length'
    return None


def convert(j) -> bool:
    """True when finished here; False when handed to the backup converter (still running)."""
    d = conv.download(j)
    work = Path(d['work'])
    kwork = work / 'kengine'
    artist, title = meta_of(d['info'], d['name'])
    if artist and title:
        j['name'] = conv.safe(f'{artist} - {title}')
        j['artist'], j['title'] = artist, title
    meta = {'artist': artist, 'title': title, 'language': j.get('language')}
    conv.log(j, f'kengine: "{title}" by {artist or "?"}')

    spec = kwork / 'job.json'
    kwork.mkdir(parents=True, exist_ok=True)
    spec.write_text(json.dumps({'meta': meta, 'lyrics': j.get('lyrics')}, ensure_ascii=False), encoding='utf-8')
    try:  # a process of its own: memory is freed afterwards, and Cancel can kill it
        conv.run(j, [sys.executable, '-X', 'utf8', '-m', 'kengine.job', str(kwork), d['mp3'], str(spec)],
                 cwd=str(ROOT / 'engine'))
        txt = (kwork / 'song.txt').read_text(encoding='utf-8')
        doubt = lyrics_doubt(kwork)
    except RuntimeError as e:  # no lyrics, pasted lyrics without timestamps, or a step failed
        if j.get('cancel'):
            raise
        msg = str(e)
        known = [m for m in ('No lyrics found', 'without timings') if m in msg]
        doubt = ('no lyrics were found for it' if known and known[0] == 'No lyrics found' else
                 'the pasted lyrics have no timestamps' if known else f'kengine failed ({msg.splitlines()[-1][:200]})')
    if doubt:
        handoff(j, doubt)
        return False

    dest = conv.new_song_dir(j['name'] or d['name'])
    base = os.path.basename(dest)
    shutil.copy(d['mp3'], os.path.join(dest, f'{base}.mp3'))
    txt = conv.set_tag(txt, 'MP3', f'{base}.mp3')
    thumb = work / 'thumb.jpg'
    if thumb.exists():
        shutil.copy(thumb, os.path.join(dest, f'{base}.jpg'))
        txt = conv.set_tag(txt, 'COVER', f'{base}.jpg')
    if d['video']:
        shutil.move(d['video'], os.path.join(dest, f'{base}.mp4'))
        txt = conv.set_tag(txt, 'VIDEO', f'{base}.mp4')
        txt = conv.set_tag(txt, 'VIDEOGAP', '0')
    with open(os.path.join(dest, f'{base}.txt'), 'w', encoding='utf-8') as f:
        f.write(txt)
    # keep kengine's intermediate results (not the big audio), so the notes can be rebuilt later
    keep = Path(conv.WORK) / '_keep' / work.name
    keep.mkdir(parents=True, exist_ok=True)
    for n in ('pitch.json', 'lyrics.json', 'align.json', 'song.txt'):
        if (kwork / n).exists():
            shutil.copy(kwork / n, keep / n)
    (keep / 'song.json').write_text(json.dumps({'url': j['url'], 'folder': base, 'artist': artist, 'title': title},
                                               ensure_ascii=False), encoding='utf-8')
    j['name'], j['dir'], j['files'], j['engine'] = base, dest, sorted(os.listdir(dest)), 'kengine'
    conv.log(j, 'Made with kengine')
    shutil.rmtree(work, ignore_errors=True)
    return True


def _call(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(BACKUP + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b'null')


def handoff(j, why: str):
    """Give the song to the Docker converter (UltraSinger) and follow it from a thread."""
    conv.log(j, f'Lyrics: {why}. Using the backup converter (UltraSinger).')
    try:
        r = _call('POST', '/api/convert', {'url': j['url'], 'language': j.get('language'), 'lyrics': j.get('lyrics'),
                                          'artist': j.get('artist'), 'title': j.get('title')})
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f'{why[:1].upper() + why[1:]}, and the backup converter isn\'t running '
                           f'(start it with: docker compose up -d converter). ({e})')
    j['backup'], j['engine'], j['stage'] = r['id'], 'ultrasinger', 'Backup converter: queued'
    conv.save_jobs()
    threading.Thread(target=follow, args=(j,), daemon=True).start()


def follow(j):
    """Mirror the backup converter's job into ours until it finishes."""
    fails = 0
    while True:
        time.sleep(3)
        if j.get('cancel'):
            try:
                _call('DELETE', f'/api/jobs/{j["backup"]}')
            except Exception:
                pass
            j['state'], j['error'], j['finished'] = 'error', 'Cancelled', time.time()
            conv.save_jobs()
            return
        try:
            b = _call('GET', f'/api/jobs/{j["backup"]}')
            fails = 0
        except Exception as e:
            fails += 1
            if fails < 20:  # e.g. the converter restarting; it keeps its queue
                continue
            b = {'state': 'error', 'error': f'Lost the backup converter ({e})'}
        if b['state'] in ('queued', 'running'):
            j['stage'] = 'Backup converter: ' + (b.get('stage') or '')
            j['log'] = (b.get('log') or [])[-12:]
            continue
        if b['state'] == 'done':
            j['name'], j['files'] = b['name'], b['files']
            j['dir'] = os.path.join(conv.SONGS, b['name'])
            j['state'], j['stage'] = 'done', 'Done'
        else:
            j['state'], j['error'] = 'error', 'Backup converter: ' + (b.get('error') or 'failed')
        j['finished'] = time.time()
        conv.save_jobs()
        return


def worker():
    while True:
        conv.wake.wait()
        with conv.lock:
            jid = conv.queue.pop(0) if conv.queue else None
            if not conv.queue:
                conv.wake.clear()
        if not jid:
            continue
        j = conv.jobs[jid]
        if j.get('cancel'):
            continue
        j['state'], j['started'] = 'running', time.time()
        conv.save_jobs()
        try:
            if convert(j):
                j['state'], j['stage'] = 'done', 'Done'
        except Exception as e:
            j['state'], j['error'] = 'error', str(e)  # work dir kept: a retry reuses kengine's cached steps
        if j['state'] != 'running':
            j['finished'] = time.time()
        conv.save_jobs()


def main():
    os.makedirs(conv.SONGS, exist_ok=True)
    os.makedirs(conv.WORK, exist_ok=True)
    conv.load_jobs()
    # jobs that were with the backup converter: keep following them instead of starting over
    for j in conv.jobs.values():
        if j.get('backup') and j.get('state') == 'queued':
            if j['id'] in conv.queue:
                conv.queue.remove(j['id'])
            j['state'] = 'running'
            threading.Thread(target=follow, args=(j,), daemon=True).start()
    threading.Thread(target=worker, daemon=True).start()
    print(f'kengine service on http://127.0.0.1:{PORT} (songs -> {conv.SONGS}; backup converter {BACKUP})', flush=True)
    conv.ThreadingHTTPServer(('127.0.0.1', PORT), conv.H).serve_forever()


if __name__ == '__main__':
    main()
