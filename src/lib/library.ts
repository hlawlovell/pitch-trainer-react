import { decodeText, parseUltrastar, type USong } from './ultrastar';

export interface SongEntry {
  id: string;
  dir: string;
  txtName: string;
  txt: string;
  song: USong;
  audio?: Blob; audioName?: string;
  video?: Blob; videoName?: string;
  cover?: Blob;
  added: number;
  warnings: string[];
}

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv|avi|divx|flv|mpg|mpeg)$/i;
const PLAYABLE_VIDEO = /\.(mp4|m4v|webm|mov|ogv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;

type FileWithPath = { file: File; path: string };

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Turn a flat list of files (from a folder picker or drag-and-drop) into songs. */
export async function songsFromFiles(files: FileWithPath[]): Promise<{ songs: SongEntry[]; errors: string[] }> {
  const byDir = new Map<string, FileWithPath[]>();
  for (const f of files) {
    const d = dirOf(f.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }
  const songs: SongEntry[] = [];
  const errors: string[] = [];
  for (const [dir, list] of byDir) {
    const txts = list.filter(f => /\.txt$/i.test(f.file.name));
    for (const t of txts) {
      const text = decodeText(await t.file.arrayBuffer());
      if (!/^#(TITLE|BPM)/im.test(text)) continue;
      const song = parseUltrastar(text);
      const find = (name: string | undefined, re: RegExp) => {
        if (name) {
          const exact = list.find(f => f.file.name.toLowerCase() === baseOf(name.replace(/\\/g, '/')).toLowerCase());
          if (exact) return exact;
        }
        return list.find(f => re.test(f.file.name));
      };
      const warnings: string[] = [];
      const a = find(song.mp3, AUDIO_EXT);
      let v = find(song.video, VIDEO_EXT);
      if (v && !PLAYABLE_VIDEO.test(v.file.name)) { warnings.push(`Video "${v.file.name}" is in a format browsers can't play, so it was skipped.`); v = undefined; }
      const c = find(song.cover, /\[co\]|cover/i) || find(undefined, IMAGE_EXT);
      if (!a && !v) { errors.push(`${song.artist} - ${song.title}: no audio file found${song.mp3 ? ` (expected "${song.mp3}")` : ''}.`); continue; }
      if (!a) warnings.push('No separate audio file; using the video\'s soundtrack.');
      if (!song.tracks.some(tr => tr.lines.length)) { errors.push(`${baseOf(t.path)}: no notes found.`); continue; }
      songs.push({
        id: `${song.artist}|${song.title}|${t.file.size}`.toLowerCase(),
        dir, txtName: t.file.name, txt: text, song,
        audio: a?.file, audioName: a?.file.name, video: v?.file, videoName: v?.file.name, cover: c?.file,
        added: Date.now(), warnings,
      });
    }
  }
  if (!songs.length && !errors.length) errors.push('No UltraStar .txt files found. Pick the song folder (or a folder of song folders).');
  return { songs, errors };
}

export function filesFromInput(list: FileList): FileWithPath[] {
  return Array.from(list).map(f => ({ file: f, path: (f as any).webkitRelativePath || f.name }));
}

/** Recursively read a drag-and-drop (folders included). */
export async function filesFromDrop(dt: DataTransfer): Promise<FileWithPath[]> {
  const out: FileWithPath[] = [];
  const entries = Array.from(dt.items).map(i => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(dt.files).map(f => ({ file: f, path: f.name }));
  const walk = async (entry: any, path: string): Promise<void> => {
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: path + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, path + entry.name + '/');
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/* ---------- IndexedDB persistence ---------- */
const DB = 'pitch-trainer', STORE = 'songs';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
};

export async function saveSong(e: SongEntry) {
  const { song: _song, ...rest } = e;
  await tx('readwrite', s => s.put(rest));
}
export async function deleteSong(id: string) {
  await tx('readwrite', s => s.delete(id));
}
export async function loadLibrary(): Promise<SongEntry[]> {
  try {
    const rows = (await tx('readonly', s => s.getAll())) as Omit<SongEntry, 'song'>[];
    return rows.map(r => ({ ...r, song: parseUltrastar(r.txt) })).sort((a, b) => a.song.artist.localeCompare(b.song.artist) || a.song.title.localeCompare(b.song.title));
  } catch (e) {
    console.warn('song library unavailable', e);
    return [];
  }
}
