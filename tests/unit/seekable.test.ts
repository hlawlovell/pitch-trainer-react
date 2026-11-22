import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWav16, seekableAudio } from '../../src/audio/seekable';

/** Minimal AudioBuffer stand-in. */
const fakeBuffer = (channels: number[][], sampleRate = 44100) => ({
  numberOfChannels: channels.length, length: channels[0].length, sampleRate,
  getChannelData: (c: number) => Float32Array.from(channels[c]),
}) as unknown as AudioBuffer;

const stubDecoder = (impl: () => Promise<AudioBuffer>) => {
  const decode = vi.fn(impl);
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  return decode;
};

afterEach(() => vi.unstubAllGlobals());

describe('seekableAudio (MP3s are decoded to WAV so seeking is exact)', () => {
  it('converts an MP3 to WAV', async () => {
    const decode = stubDecoder(async () => fakeBuffer([[0, 0.5], [0, -0.5]]));
    const out = await seekableAudio(new Blob([new Uint8Array(10)], { type: 'audio/mpeg' }), 'song.mp3');
    expect(decode).toHaveBeenCalledOnce();
    expect(out.type).toBe('audio/wav');
  });

  it('recognises an MP3 by file name when the type is missing', async () => {
    stubDecoder(async () => fakeBuffer([[0]]));
    const out = await seekableAudio(new Blob([new Uint8Array(4)]), 'Some Song.MP3');
    expect(out.type).toBe('audio/wav');
  });

  it('leaves other formats untouched (they seek accurately already)', async () => {
    const decode = stubDecoder(async () => fakeBuffer([[0]]));
    for (const [type, name] of [['audio/ogg', 'a.ogg'], ['audio/wav', 'a.wav'], ['audio/mp4', 'a.m4a']]) {
      const f = new Blob([new Uint8Array(4)], { type });
      expect(await seekableAudio(f, name)).toBe(f);
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it('falls back to the original file if decoding fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubDecoder(async () => { throw new Error('bad data'); });
    const f = new Blob([new Uint8Array(4)], { type: 'audio/mpeg' });
    expect(await seekableAudio(f, 'a.mp3')).toBe(f);
  });
});

describe('encodeWav16', () => {
  it('writes a valid stereo 16-bit header and interleaved, clipped samples', async () => {
    const blob = encodeWav16(fakeBuffer([[0, 1, -1, 2], [0.5, -0.5, 0, -3]], 48000));
    const v = new DataView(await blob.arrayBuffer());
    const str = (o: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(o + i)));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(v.getUint16(20, true)).toBe(1);          // PCM
    expect(v.getUint16(22, true)).toBe(2);          // channels
    expect(v.getUint32(24, true)).toBe(48000);      // sample rate
    expect(v.getUint32(28, true)).toBe(48000 * 4);  // byte rate
    expect(v.getUint16(32, true)).toBe(4);          // block align
    expect(v.getUint16(34, true)).toBe(16);         // bits
    expect(v.getUint32(40, true)).toBe(4 * 2 * 2);  // data bytes
    const s = (i: number) => v.getInt16(44 + i * 2, true);
    // frames: [L, R] interleaved; values beyond ±1 are clipped
    expect([s(0), s(1)]).toEqual([0, Math.round(0.5 * 0x7fff - 0.5)]);
    expect([s(2), s(3)]).toEqual([0x7fff, -0x4000]);
    expect([s(4), s(5)]).toEqual([-0x8000, 0]);
    expect([s(6), s(7)]).toEqual([0x7fff, -0x8000]);
  });

  it('keeps the exact length, so time positions map 1:1', async () => {
    const n = 44100 * 3;
    const blob = encodeWav16(fakeBuffer([Array(n).fill(0)], 44100));
    expect(blob.size).toBe(44 + n * 2);
  });
});
