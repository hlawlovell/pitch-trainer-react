import { getCtx, micStream } from './engine';
import { getS } from '../lib/settings';

interface Rec {
  mr: MediaRecorder; chunks: Blob[]; startAC: number; paused: number; pauseAt: number | null; name: string;
}
let rec: Rec | null = null;
let lastRecording: { name: string; blob: Promise<Blob> } | null = null;

export const isRecording = () => !!rec;
export const hasRecording = () => !!rec || !!lastRecording;

export function stamp(d: Date) {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Seconds since recording started (excluding pauses), or null. */
export function recTime(): number | null {
  const AC = getCtx();
  if (!rec || !AC) return null;
  return AC.currentTime - rec.startAC - rec.paused - (rec.pauseAt != null ? AC.currentTime - rec.pauseAt : 0);
}

export function startRecording(name: string): string | null {
  stopRecording();
  const AC = getCtx();
  if (!getS().record || !micStream || !AC || typeof MediaRecorder === 'undefined') return null;
  try {
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.start(1000);
    rec = { mr, chunks, startAC: AC.currentTime, paused: 0, pauseAt: null, name };
    return name + '.wav';
  } catch (e) {
    console.warn('recording unavailable', e);
    rec = null;
    return null;
  }
}

export function pauseRecording(p: boolean) {
  const AC = getCtx();
  if (!rec || !AC || rec.mr.state === 'inactive') return;
  if (p && rec.mr.state === 'recording') { rec.mr.pause(); rec.pauseAt = AC.currentTime; }
  else if (!p && rec.mr.state === 'paused') { rec.mr.resume(); rec.paused += AC.currentTime - (rec.pauseAt ?? AC.currentTime); rec.pauseAt = null; }
}

export function stopRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;
  const blob = new Promise<Blob>(res => { r.mr.onstop = () => res(new Blob(r.chunks, { type: r.mr.mimeType })); });
  try { r.mr.stop(); } catch { /* ignore */ }
  lastRecording = { name: r.name, blob };
}

async function currentBlob(): Promise<{ name: string; blob: Blob } | null> {
  if (rec && rec.mr.state !== 'inactive') {
    const r = rec;
    await new Promise<void>(res => {
      const h = () => { r.mr.removeEventListener('dataavailable', h); setTimeout(res, 0); };
      r.mr.addEventListener('dataavailable', h);
      r.mr.requestData();
    });
    return { name: r.name, blob: new Blob(r.chunks, { type: r.mr.mimeType }) };
  }
  if (lastRecording) return { name: lastRecording.name, blob: await lastRecording.blob };
  return null;
}

function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.getChannelData(0), n = ch.length, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab), sr = buf.sampleRate;
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, ch[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([ab], { type: 'audio/wav' });
}

export function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Downloads the current/last recording as a mono 22 kHz WAV. Returns a message for the user. */
export async function downloadRecording(): Promise<string> {
  const r = await currentBlob();
  if (!r || !r.blob.size) return 'No recording yet. Recording starts with each exercise or song (Settings → Record my voice).';
  const AC = getCtx()!;
  try {
    const dec = await new Promise<AudioBuffer>(async (res, rej) => AC.decodeAudioData(await r.blob.arrayBuffer(), res, rej));
    const SR = 22050;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(dec.duration * SR)), SR);
    const bs = off.createBufferSource();
    bs.buffer = dec; bs.connect(off.destination); bs.start();
    download(r.name + '.wav', encodeWav(await off.startRendering()));
  } catch (e) {
    console.warn('WAV conversion failed, saving original', e);
    const ext = (r.blob.type.match(/audio\/(\w+)/)?.[1] ?? 'webm').replace('mp4', 'm4a');
    download(r.name + '.' + ext, r.blob);
  }
  return 'Recording downloaded.';
}
