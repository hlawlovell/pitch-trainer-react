# Handoff — pitch-trainer karaoke + song engine (2026-11-21)

Project: `c:\Users\hlawl\Documents\software\pitch-trainer\pitch-trainer-react` (Windows 11, PowerShell +
Git Bash). The user is a baritone learning to sing (K-ballads, Chinese/Korean/English songs).

## 1. The app (React 19 + TS + Vite 7, `npm run dev` on :8080)
- Run: `start-app.cmd` (kengine + `npm run dev` on :8080, which proxies /api to kengine on 8002). Docker now only runs
  the backup `converter` (`docker compose up -d --build`, on 127.0.0.1:8001).
- Karaoke player `src/screens/KaraokePlayer.tsx`, note canvas `src/components/Roll.tsx`, scoring
  `src/lib/analysis.ts` (v1/v2), settings `src/lib/settings.ts` (localStorage, versioned migrations),
  UltraStar parser `src/lib/ultrastar.ts` (pitch 0 = C4; files stored as absolute MIDI are shifted by median).
- Recent features: Perform mode (UltraStar-style filling bars), auto-play when audio is ready (no
  Start button; Try again only on mic error), stripes hidden behind music videos, pinyin under Chinese
  lyrics (`src/lib/pinyin.ts`, pinyin-pro lazy chunk, setting kPinyin), top lyric line switches as soon
  as the next line starts, "Make a song from YouTube" box (`src/components/YouTubeImport.tsx`) with
  Options (language + pasted lyrics), MP3s decoded to WAV for exact seeking (`src/audio/seekable.ts`).
- Tests: `npx vitest run` (32 unit), `npm run test:e2e` (audio-sync, puppeteer + system Chrome).
- Known pre-existing tsc error at App.tsx(40) (duplicate key) — harmless, filtered out.

## 2. Converting songs: kengine service (default) + Docker converter (backup)
- Start `engine/start-kengine.cmd` (window stays open) = `kengine/service.py` on 127.0.0.1:8002, native
  Windows for the GPU. `npm run dev` proxies `/api/` there; there is no fallback if it's down (the old
  Docker nginx app container that fell back to the converter was removed; `Dockerfile`/`nginx.conf` are unused).
- The service reuses `converter/server.py` (job store, HTTP handler, `download()`): same API
  (`POST /api/convert {url, language?, lyrics?}`, `GET /api/jobs[/id]`, files, DELETE = cancel/hide); jobs
  have `engine: "kengine" | "ultrasinger"`. Queue in `engine/service-work/jobs.json`.
- Each song runs in its own process (`kengine/job.py`): GPU models are freed after every song (one long
  process held 6 GB and ran Windows out of memory) and Cancel kills it.
- Lyric gate (`service.lyrics_doubt`): kengine's result is used unless the lyric fit is < 0.2, or the
  lyrics needed a > 4 s shift while both versions are within 3 s in length; then (and if kengine fails)
  the job is handed to the Docker converter (`POST 127.0.0.1:8001/api/convert` with the parsed
  artist/title) and followed until done (`service.follow`; survives restarts).
- Video title → artist/title for LRCLIB: `service.meta_of` (YouTube music metadata; `ARTIST 'SONG' MV`;
  `Artist - Title (Official Video)`; `Title` by `Artist - Topic`).
- Docker converter (`converter/`, UltraSinger, CPU, ~7 min/song): yt-dlp (HLS first; DASH 403s) → H.264 →
  UltraSinger (pinned, key-snapping off) → `renote()` → pasted lyrics → Chinese clean-up. Its `download()`
  is shared with the service. Output: `converted-songs/<Artist - Title>/`.

## 3. kengine (`engine/`) — our own engine, native Windows, GPU via DirectML (RX 5700 XT)
- venv: `engine/.venv` (Python 3.12). Run from `engine/` with `.venv\Scripts\python.exe -X utf8 -m …`
  (`-X utf8` matters: Korean/Chinese text). Models in `engine/models/` (Kim_Vocal_2.onnx, rmvpe.onnx;
  MMS aligner cached by torch hub; Whisper in models/whisper). Dependencies: `engine/requirements.txt`
  (installing packages can replace the GPU onnxruntime with the CPU one: see that file).
- Steps (`kengine/pipeline.py`, each cached in `bench/<song>/work/`):
  1. vocals — audio-separator MDX-Net Kim_Vocal_2, GPU (DirectML): ~25 s/song (8.5× CPU)
  2. pitch — RMVPE ONNX (`pitch.py`), CPU ~10 s (GPU no faster)
  3. aligner features — torchaudio MMS_FA emissions for the whole song, once (`align.emissions`, ~80 s CPU;
     DirectML lacks an op) → `emissions.npz`; then any alignment is instant (`align.align_em`)
  4. lyrics — pasted (synced, or plain: timed by aligning the whole text to the whole song), LRCLIB synced
     lyrics, or speech recognition (faster-whisper medium, CPU) when there are none;
     LRCLIB synced lyrics (`lyrics.py`; free-text fallback; long MV versions and short TV
     edits allowed) or pasted text; global offset found by aligning sample lines over every shift
     (`pipeline._fit_offset`)
  5. align — per line, tokens: words / Chinese characters (pypinyin) / Japanese words (pykakasi);
     romanised with uroman otherwise
  6. notes (`notes.py`) — pitch → notes (smoothing, octave folding, settle-based splitting, tuning
     correction when the recording is >15 cents off A440), syllables placed by DP, lyric-aware scoop/
     fall-off merging (`_scoops`, "try 3"), UltraStar writer.
- Scoreboard: `python -X utf8 -m kengine.bench [songs] [--from notes] [--set key=value] [--holdout]`;
  `kengine.diagnose <song>` (error sizes, gaps, worst lines); `kengine.add` (new test song, .txt or .mid
  reference); `kengine.score A B` (two files); `kengine.synthesia` (notes from a
  Synthesia video) + `kengine.warp` (fit a cover's melody onto the recording's timeline). Metrics: exact / pitch / semitone / octave / coverage /
  extra / short / wer / word_ms / far; time offset, key (MIDI) and one whole-song octave are searched.
- Bench songs (`engine/bench/`, references from `C:\Program Files (x86)\UltraStar Deluxe\songs` and
  the user's Downloads): tuned on reason, here-without-you, it-will-rain, butterfly, spring-day
  (avg 89.4% exact / 93.3% within a semitone); held out (12): avg 86.4% / 91.2% (after 2026-11-21 changes, see TODO). wurenzhidao: Synthesia-based reference (see TODO).
- Findings: forced alignment beats Whisper timing (4% vs 20% of words >300 ms off, after the ~90 ms
  consonant-vs-vowel convention); RMVPE ≈ SwiftF0 on pitch; separation on GPU is the big speed win.

## 4. Open items
See `engine/TODO.md` (Korean offset fitting, Avid lyrics search, gap filling, ±1–2 semitone errors,
backing vocals, connecting kengine to the app).

## Misc context
- WSL memory: vmmemWSL fills with page cache during builds; suggested `.wslconfig` (memory=6GB,
  autoMemoryReclaim=gradual) — not applied.
- User's songs: UltraStar Deluxe songs folder above; test folders in Downloads (The Reason etc.).
