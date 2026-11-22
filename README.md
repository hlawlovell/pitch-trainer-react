# Pitch Trainer

A singing pitch trainer with note names everywhere, a piano across the top, and a karaoke mode for UltraStar Deluxe songs. It runs entirely in your browser, with **no backend**. Songs, scores and recordings never leave your computer.

## Run it on Windows

### Option A: Node.js (recommended)
1. Install **Node.js** (https://nodejs.org) and set up the song converter, kengine (see `engine/HANDOFF.md`).
2. Double-click **`start-app.cmd`**. It starts kengine in its own window and the app on **http://localhost:8080**,
   and opens your browser. Allow the microphone when asked. Close both windows to stop.
3. Optional: the backup converter (UltraSinger) runs in **Docker Desktop**. Double-click **`start.bat`** to start it
   along with the app, and **`stop.bat`** to stop it. kengine hands it the few songs it can't convert itself.

> Use the `localhost` address. Browsers only allow the microphone on `localhost` or `https://` pages,
> so opening it as `http://192.168.x.x:8080` from another device won't get mic access.

### Option B: No install at all
Open **`dist-standalone/pitch-trainer.html`** in Chrome or Edge (double-click). Everything is in that one file.

### Option C: Node.js from a terminal
```
npm install
npm run dev          # http://localhost:8080 with hot reload
npm run build        # static site in dist/
npm run build:standalone   # rebuild the single-file version
```

## Karaoke songs
Add songs in the **Karaoke** tab with **Add song folder**, or drag folders onto the page. Pick one song folder or a folder full of song folders. Each song folder needs:

- the UltraStar `.txt` file (`#TITLE`, `#ARTIST`, `#BPM`, `#GAP`, notes…)
- the audio file it names in `#MP3:` / `#AUDIO:` (mp3, m4a, ogg…)
- optional `#VIDEO:` (mp4/webm/mov play in browsers; .avi/.divx are skipped) and `#COVER:` image

Songs are stored in the browser (IndexedDB) so you only add them once. You can turn this off in Settings.

**Practice mode:** pause, scrub, ±5 s, 0.5×–1× speed (pitch preserved), loop any line (🔁, or press `L`),
shift-click to loop several lines, A/B loop points, a guide melody played on the piano, and per-line scores.
**Perform mode:** sing straight through and get a score at the end.

UltraStar files are often written an octave away from where people actually sing them. **Octave: auto** fits the melody to your vocal range, and scoring accepts the right note in any octave by default.

## Tips
- Use **headphones** so the mic hears only you, not the song or the piano.
- If your pitch line lags behind the notes in karaoke, raise **Settings → Karaoke → Mic latency**.
- **Progress & AI report** turns your measured singing into a text report to paste into an AI chat, and lets you download your voice recording.

## Tests
```
npm test          # unit tests (fast)
npm run test:e2e  # browser tests: drives the real app in Chrome (~30 s)
```
The browser test guards karaoke audio sync: browsers seek inaccurately in MP3s, which once left the music ~0.7 s away from the notes after scrubbing. The app now decodes MP3s to WAV before playback (`src/audio/seekable.ts`), and the test plays a synthetic song (`tests/fixtures/sync/`), jumps around it, records what the audio element actually plays and checks it lines up with the notes to within 0.1 s. It needs Chrome or Edge (set `CHROME_PATH` if it isn't found) and is skipped otherwise. Regenerate the fixture with `npm run fixtures` (needs ffmpeg).

## Credits
Piano samples are rendered from the TimGM6mb General MIDI soundfont by Tim Brechbill (GPL-2.0).
