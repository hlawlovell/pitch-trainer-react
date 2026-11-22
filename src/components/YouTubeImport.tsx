import { useCallback, useEffect, useRef, useState } from 'react';
import { lsGet, lsSet } from '../lib/storage';
import { toast } from './ui';

/** A conversion job on the converter service (engine/kengine/service.py, or the Docker converter/server.py). */
export interface Job {
  id: string; url: string; language?: string | null; hasLyrics?: boolean;
  state: 'queued' | 'running' | 'done' | 'error';
  stage: string; name: string | null; error: string | null;
  files: string[]; log: string[];
  created: number; started: number | null; finished: number | null;
  engine?: 'kengine' | 'ultrasinger' | null; // which engine made it (kengine service only)
}

type FileWithPath = { file: File; path: string };
const ADDED = 'pt_yt_added'; // job ids already added to the library (so a finished job is added once, even after a reload)
const TYPES: Record<string, string> = { mp3: 'audio/mpeg', mp4: 'video/mp4', jpg: 'image/jpeg', txt: 'text/plain' };

export const isYouTube = (s: string) => /^https:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?|shorts\/|live\/)|youtu\.be\/)\S+$/.test(s.trim());

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch('api/' + path, init);
  const isJson = r.headers.get('content-type')?.includes('json');
  if (!isJson) throw new Error('offline'); // nginx error page / dev server fallback: converter isn't running
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

/** Download a finished job's folder as Files, in the shape the library's folder import expects. */
export async function jobFiles(j: Job): Promise<FileWithPath[]> {
  return Promise.all(j.files.map(async name => {
    const r = await fetch(`api/jobs/${j.id}/files/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`Couldn't download ${name}`);
    const type = TYPES[name.split('.').pop()!.toLowerCase()] ?? '';
    return { file: new File([await r.blob()], name, { type }), path: `${j.name}/${name}` };
  }));
}

const LANGS: [string, string][] = [
  ['en', 'English'], ['de', 'German'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['es', 'Spanish'],
  ['fr', 'French'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['nl', 'Dutch'], ['pl', 'Polish'],
];

const mins = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);

export default function YouTubeImport({ onFiles }: { onFiles: (files: FileWithPath[]) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [opts, setOpts] = useState(false);
  const [language, setLanguage] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [up, setUp] = useState<boolean | null>(null);
  const [, tick] = useState(0);
  const adding = useRef(new Set<string>());
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  const addJob = useCallback(async (j: Job) => {
    if (adding.current.has(j.id)) return;
    adding.current.add(j.id);
    try {
      await onFilesRef.current(await jobFiles(j));
      lsSet(ADDED, [...lsGet<string[]>(ADDED, []), j.id].slice(-200));
    } catch (e: any) {
      toast(`Couldn't add "${j.name}": ${e.message || e}`);
      adding.current.delete(j.id);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await api<Job[]>('jobs');
      setJobs(list);
      setUp(true);
      const added = new Set(lsGet<string[]>(ADDED, []));
      for (const j of list) if (j.state === 'done' && !added.has(j.id)) addJob(j);
      return list;
    } catch { setUp(false); return []; }
  }, [addJob]);

  // poll quickly while something is converting, slowly otherwise (picks up a converter started later)
  const busy = jobs.some(j => j.state === 'queued' || j.state === 'running');
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, busy ? 2000 : 15000);
    return () => clearInterval(id);
  }, [refresh, busy]);
  useEffect(() => { // elapsed-time display
    if (!busy) return;
    const id = setInterval(() => tick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const submit = async () => {
    const u = url.trim();
    if (!isYouTube(u)) { toast("That doesn't look like a YouTube link."); return; }
    try {
      await api('convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u, language, lyrics }) });
      setUrl(''); setLyrics('');
      refresh();
    } catch (e: any) { toast(e.message === 'offline' ? 'The converter isn\'t running.' : e.message); }
  };
  const drop = async (j: Job) => {
    await api(`jobs/${j.id}`, { method: 'DELETE' }).catch(() => {});
    refresh();
  };

  const now = Date.now() / 1000;
  const shown = jobs.filter(j => j.state !== 'done' || !lsGet<string[]>(ADDED, []).includes(j.id) || now - (j.finished ?? 0) < 600);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Make a song from YouTube</h3>
      {up === false ? (
        <div className="hint">
          The converter isn't running. Start <code>engine\start-kengine.cmd</code> (or open the app with
          <code>start-app.cmd</code>, which starts it for you), then this box will work.
        </div>
      ) : (
        <>
          <div className="row" style={{ margin: 0 }}>
            <input type="url" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }} disabled={up === null}
              style={{ flex: 1, minWidth: 240, background: 'var(--panel2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px', font: 'inherit' }} />
            <button className="btn primary" onClick={submit} disabled={!url.trim() || up === null}>Convert</button>
            <button className={'btn sm' + (opts ? ' on' : '')} onClick={() => setOpts(o => !o)} aria-expanded={opts}>
              Options{language || lyrics.trim() ? ' •' : ''}
            </button>
          </div>
          {opts && (
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              <div className="row" style={{ margin: 0 }}>
                <label htmlFor="yt-lang" className="hint" style={{ minWidth: 70 }}>Language</label>
                <select id="yt-lang" value={language} onChange={e => setLanguage(e.target.value)}>
                  <option value="">Detect automatically</option>
                  {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                </select>
                <span className="hint">Set it when the song isn't in English or opens with another language.</span>
              </div>
              <label htmlFor="yt-lyrics" className="hint">Lyrics (optional): paste the lyrics, one line per line (with or without [mm:ss] times), when the song's lyrics can't be found online or come out wrong.</label>
              <textarea id="yt-lyrics" value={lyrics} onChange={e => setLyrics(e.target.value)} rows={6} placeholder={'Alles Lebendige stirbt eines Tages\n…'}
                style={{ background: 'var(--panel2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', font: 'inherit', resize: 'vertical' }} />
            </div>
          )}
          <div className="hint" style={{ marginTop: 8 }}>
            The converter separates the vocals, finds the lyrics online (or listens for them) and detects the notes: a few minutes
            per song. If the lyrics don't fit the singing, the backup converter (UltraSinger) takes over, which is slower.
            The result is a first draft: expect some notes and words to need fixing. For personal use only.
          </div>
        </>
      )}
      {shown.map(j => (
        <div key={j.id} style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10 }}>
          <div className="row" style={{ margin: 0 }}>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{j.name ?? j.url}</span>
            <span className="hint" style={{ color: j.state === 'error' ? 'var(--bad)' : j.state === 'done' ? 'var(--good)' : undefined }}>
              {j.state === 'done' ? 'Added to your library' + (j.engine === 'ultrasinger' ? ' (made by the backup converter)' : '') : j.state === 'error' ? 'Failed' : j.stage}
              {j.state === 'running' && j.started ? ` · ${mins(now - j.started)}` : ''}
            </span>
            <span style={{ flex: 1 }} />
            {j.state === 'done' && <button className="btn sm" onClick={() => { adding.current.delete(j.id); addJob(j); }} title="Add it to the library again">Re-add</button>}
            <button className="btn sm" onClick={() => drop(j)} title={j.state === 'queued' || j.state === 'running' ? 'Cancel' : 'Hide'}>✕</button>
          </div>
          {j.state === 'running' && j.log.length > 0 && <div className="hint" style={{ fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.log[j.log.length - 1]}</div>}
          {j.state === 'error' && <pre className="hint" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', color: 'var(--bad)' }}>{j.error}</pre>}
        </div>
      ))}
    </div>
  );
}
