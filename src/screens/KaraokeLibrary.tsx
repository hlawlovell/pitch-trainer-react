import { useEffect, useMemo, useRef, useState } from 'react';
import { deleteSong, filesFromDrop, filesFromInput, loadLibrary, saveSong, songsFromFiles, type SongEntry } from '../lib/library';
import { useSettings } from '../lib/settings';
import { fmtTime } from '../lib/notes';
import { toast } from '../components/ui';
import YouTubeImport from '../components/YouTubeImport';

export default function KaraokeLibrary({ songs, setSongs, onPlay }: {
  songs: SongEntry[]; setSongs: (f: (s: SongEntry[]) => SongEntry[]) => void; onPlay: (s: SongEntry) => void;
}) {
  const S = useSettings();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const dirInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    loadLibrary().then(saved => {
      if (saved.length) setSongs(cur => {
        const ids = new Set(cur.map(s => s.id));
        return [...cur, ...saved.filter(s => !ids.has(s.id))];
      });
    });
  }, [setSongs]);

  const covers = useMemo(() => {
    const m: Record<string, string> = {};
    songs.forEach(s => { if (s.cover) m[s.id] = URL.createObjectURL(s.cover); });
    return m;
  }, [songs]);
  useEffect(() => () => Object.values(covers).forEach(u => URL.revokeObjectURL(u)), [covers]);

  const add = async (files: { file: File; path: string }[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const { songs: found, errors } = await songsFromFiles(files);
      errors.forEach(e => toast(e));
      found.forEach(f => f.warnings.forEach(w => toast(`${f.song.title}: ${w}`)));
      if (found.length) {
        setSongs(cur => {
          const ids = new Set(found.map(f => f.id));
          return [...cur.filter(c => !ids.has(c.id)), ...found].sort((a, b) => a.song.artist.localeCompare(b.song.artist) || a.song.title.localeCompare(b.song.title));
        });
        if (S.kStoreSongs) {
          for (const f of found) {
            try { await saveSong(f); }
            catch { toast(`Couldn't store "${f.song.title}" in the browser (storage full?). It's available until you reload.`); }
          }
        }
        toast(`Added ${found.length} song${found.length === 1 ? '' : 's'}.`);
      }
    } finally { setBusy(false); }
  };

  const remove = async (s: SongEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Remove "${s.song.title}" from the library?`)) return;
    await deleteSong(s.id).catch(() => {});
    setSongs(cur => cur.filter(c => c.id !== s.id));
  };

  const list = songs.filter(s => !q || `${s.song.artist} ${s.song.title}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="screen"><div className="wrap">
      <h2>Karaoke</h2>
      <p className="sub">Sing along to UltraStar Deluxe songs on the same note screen as the trainer. Add a song folder (the .txt with its audio, and optionally video and cover), or a folder containing many song folders.</p>
      <div className={'drop' + (over ? ' over' : '')}
        onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={async e => { e.preventDefault(); setOver(false); add(await filesFromDrop(e.dataTransfer)); }}>
        <div style={{ fontSize: 30 }}>🎵</div>
        <div style={{ margin: '6px 0 12px' }}>{busy ? 'Reading songs…' : 'Drag song folders here, or'}</div>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => dirInput.current?.click()}>📁 Add song folder</button>
          <button className="btn" onClick={() => fileInput.current?.click()}>Pick files…</button>
        </div>
        <input ref={dirInput} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as any)}
          onChange={e => { if (e.target.files) add(filesFromInput(e.target.files)); e.target.value = ''; }} />
        <input ref={fileInput} type="file" hidden multiple accept=".txt,audio/*,video/*,image/*"
          onChange={e => { if (e.target.files) add(filesFromInput(e.target.files)); e.target.value = ''; }} />
        <div className="hint" style={{ marginTop: 10 }}>
          {S.kStoreSongs ? 'Songs are kept in this browser, so you only add them once. Nothing is uploaded anywhere.' : 'Songs are kept only until you reload (change this in Settings).'}
        </div>
      </div>
      <YouTubeImport onFiles={add} />

      {songs.length > 0 && (
        <div className="row" style={{ marginTop: 16 }}>
          <input type="search" placeholder="Search songs…" value={q} onChange={e => setQ(e.target.value)}
            style={{ background: 'var(--panel2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px', font: 'inherit', minWidth: 240 }} />
          <span className="hint">{songs.length} song{songs.length === 1 ? '' : 's'}</span>
        </div>
      )}
      <div className="songs">
        {list.map(s => {
          const notes = s.song.tracks[0].lines.flatMap(l => l.notes);
          const end = notes.length ? notes[notes.length - 1].end : 0;
          return (
            <div className="song" key={s.id} onClick={() => onPlay(s)}>
              <div className="cover" style={covers[s.id] ? { backgroundImage: `url("${covers[s.id]}")` } : undefined}>{!covers[s.id] && '🎤'}</div>
              <div className="info">
                <div className="t">{s.song.title}</div>
                <div className="a">{s.song.artist}{s.song.year ? ` · ${s.song.year}` : ''}</div>
                <div className="tags">
                  <span className="tag">{fmtTime(end)}</span>
                  {s.video && <span className="tag">video</span>}
                  {s.song.tracks.length > 1 && <span className="tag">duet</span>}
                  {s.song.language && <span className="tag">{s.song.language}</span>}
                  <span className="sp" />
                  <button className="btn sm" onClick={e => remove(s, e)} title="Remove from library">✕</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div></div>
  );
}
