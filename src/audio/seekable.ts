/**
 * Browsers seek inaccurately in MP3s: Chrome jumps using the file's coarse Xing index and then reports
 * the time you asked for, not where it landed. Measured on a real song: after a few seeks the audio was
 * ~0.7 s away from `currentTime`, so the notes drifted out of sync with the music. Playback from the start
 * is fine; only seeking (scrubbing, ±5 s, clicking a line, loops) breaks it.
 *
 * Fix: decode the MP3 once and play it as an uncompressed WAV, where seeking is sample-exact.
 * The <audio> element still does the playback, so speed changes keep the pitch.
 */
export async function seekableAudio(file: Blob, name = ''): Promise<Blob> {
  const isMp3 = /mpeg|mp3/i.test(file.type) || /\.mp3$/i.test(name);
  if (!isMp3) return file;
  try {
    const ctx = new OfflineAudioContext(2, 1, 44100);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    return encodeWav16(buf);
  } catch (e) {
    console.warn('Could not decode MP3 for accurate seeking; using it as is', e);
    return file;
  }
}

/** 16-bit PCM WAV (mono or stereo) from an AudioBuffer. */
export function encodeWav16(buf: AudioBuffer): Blob {
  const chs = Math.min(2, buf.numberOfChannels), n = buf.length, sr = buf.sampleRate;
  const data = new Int16Array(n * chs);
  for (let c = 0; c < chs; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0, j = c; i < n; i++, j += chs) {
      const x = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
      data[j] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
  }
  const head = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
  const bytes = data.byteLength;
  w(0, 'RIFF'); head.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
  head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, chs, true);
  head.setUint32(24, sr, true); head.setUint32(28, sr * chs * 2, true); head.setUint16(32, chs * 2, true); head.setUint16(34, 16, true);
  w(36, 'data'); head.setUint32(40, bytes, true);
  return new Blob([head.buffer, data.buffer], { type: 'audio/wav' }); // Int16Array is little-endian on every platform browsers run on
}
