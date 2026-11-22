# kengine TODO

Parked 2026-11-21. Scores below are from `python -X utf8 -m kengine.bench` (see HANDOFF.md).

## Done 2026-11-21 (iterating on 无人之岛)
- New scoreboard column `seq`: notes matched in order, timing ignored (F1, 100 = identical).
- notes.py: `pitch_of=1` (a note's pitch = its most common semitone, not the median: glides into
  the next note pulled short notes a semitone off), `key_prior=0.2` (a note sitting between two
  semitones takes the one the song uses more), `chroma_max=0.25/chroma_rare=0.15` (short notes on
  pitches the song hardly uses, touching a note 1-2 semitones away, join it: leap/scoop passing notes).
- warp.py: phrases also split after long notes, and each phrase's offset is fine-tuned on the
  singer's pitch track (the chorus reference had been 0.6 s late).
- Results: tuning set 88.0 → 89.4 exact (seq 69.6 → 72.9); held out 84.9 → 86.4 (seq 68.7 → 71.7);
  无人之岛 74.1 → 77.3 exact, seq 77.1 → 80.1 (on the fixed reference). Within-a-semitone dropped
  ~0.7 (some notes now 2 off instead of 1).
- Tried, not adopted: `glide_max` (leap rule; neutral), `approach_ratio=1.0` (merge in-key scoops
  more eagerly; +0.7 on 无人之岛 but -0.2 average). Revisit with more Chinese test songs: Chinese
  scoops take the syllable (如/天: G→A, syllable on the short G).

## Done 2026-11-21 (kengine is the default converter)
- kengine service + lyric gate + Docker converter as backup (HANDOFF.md §2).
- Lyric shift search uses every line (`fit_coarse/fit_fine=0`): I Need U fixed (17 s off -> 0.19 s),
  Eyes Nose Lips from 35 s off to ~1 s off.
- Pasted lyrics without timestamps: aligned over the whole song (about as good as LRCLIB timings).
- No lyrics anywhere: faster-whisper transcription, then normal alignment.

## Next (found by the held-out run)
1. **Korean lyric timing** (mostly fixed: see above; Eyes, Nose, Lips still ~1 s off) — lyrics land 17–35 s off on Eyes, Nose, Lips and I Need U (partly on
   Haru Haru, Mirrors). The aligner is much less confident on Korean (0.15–0.3 vs 0.4–0.56 English),
   so `pipeline._fit_offset` picks a wrong shift. Ideas: more sample lines + median instead of mean;
   score whole-song ordered alignment; check uroman's Korean romanisation suits MMS.
2. **Avid: no LRCLIB lyrics** — add a title-only search fallback (`lyrics.lrclib`), or a speech-
   recognition fallback (also needed for pasted lyrics without timings, which currently raise).
3. **Coverage ~84%** — hundreds of small gaps between notes (references run notes edge to edge).
   Try a "fill short gaps" rule in `notes.place` output.
4. **±1–2 semitone errors** — ornaments/vibrato around notes; main remaining pitch error.
5. **Extra singing** — backing vocals / other members (Mirrors 107 s, Spring Day 54 s). Try a
   lead-vocal model (UVR_MDXNET_KARA_2.onnx) after Kim_Vocal_2.
6. **Rap sections** — Haru Haru coverage 67%.

## Test data
- Add songs with `python -X utf8 -m kengine.add <name> --youtube URL|--audio FILE --reference FILE.txt|.mid
  --artist A --title T --language xx [--holdout]`. MIDI references get key search automatically.
- `bench/wurenzhidao` (任然 - 无人之岛): reference made from a Synthesia video (2026-11-21):
  `python -m kengine.synthesia video.mkv synthesia.mid` reads the falling notes (checked against the
  sheet-music video https://youtu.be/QZUTHx_RPa4: ~10 bars match note for note), then
  `python -m kengine.warp synthesia.mid work/pitch.json reference.mid` moves it onto the recording
  (one tempo + per-phrase offsets from DTW against the vocal pitch track; piano-only parts dropped).
  Scores: kengine 69.9% exact / 83.3% semitone; UltraSinger converter (renote) 66.7 / 80.2. Time-grid
  scores are low because the pianist's rhythm inside phrases ≠ the singer's; timing-free sequence
  check: kengine 82.6% of reference notes in order at the right pitch, converter 76.2%.
  Idea: add that sequence metric to `score.py` for MIDI/Synthesia references.
- Synthesia covers exist for most songs: `kengine.synthesia` + `kengine.warp` turn one into a
  reference in ~30 s (assumes full 88-key keyboard and default colours; check with an overlay).
- Keep some songs `--holdout` so tuning doesn't overfit.

## Later
- Start the kengine service with Windows (Task Scheduler / Startup folder shortcut to start-kengine.cmd).
- Word timing for Korean/Japanese references is scored on romanisation; WER there is unreliable.
- Hyphenate English words into syllables across notes (display "per-fect").
