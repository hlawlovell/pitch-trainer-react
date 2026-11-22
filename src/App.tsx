import { useCallback, useState } from 'react';
import TopPiano from './components/TopPiano';
import { Toaster } from './components/ui';
import TrainerGame from './screens/TrainerGame';
import KaraokeLibrary from './screens/KaraokeLibrary';
import KaraokePlayer from './screens/KaraokePlayer';
import { Course, Practice, Progress, SettingsScreen } from './screens/Menus';
import { LEVELS, type ExerciseCfg } from './lib/exercises';
import type { SongEntry } from './lib/library';

type Tab = 'course' | 'practice' | 'free' | 'karaoke' | 'progress' | 'settings';
type Game = { cfg?: ExerciseCfg; title: string; level?: number | null; free?: boolean; key: number };

const TABS: [Tab, string][] = [
  ['course', 'Course'], ['practice', 'Practice'], ['free', 'Free sing'], ['karaoke', 'Karaoke'],
  ['progress', 'Progress & AI report'], ['settings', 'Settings'],
];

export default function App() {
  const [tab, setTab] = useState<Tab>('course');
  const [game, setGame] = useState<Game | null>(null);
  const [songs, setSongs] = useState<SongEntry[]>([]);
  const [playing, setPlaying] = useState<SongEntry | null>(null);

  const startLevel = useCallback((i: number) => {
    const L = LEVELS[i];
    setGame({ cfg: { rounds: 8, ...L.cfg }, title: `Level ${i + 1}: ${L.name}`, level: i, key: Date.now() });
  }, []);

  const go = (t: Tab) => {
    setGame(null);
    setPlaying(null);
    if (t === 'free') { setTab('free'); setGame({ title: 'Free sing', free: true, key: Date.now() }); return; }
    setTab(t);
  };

  let body: React.ReactNode;
  if (game) {
    body = (
      <TrainerGame key={game.key} {...game}
        onExit={() => { setGame(null); if (tab === 'free') setTab('course'); }}
        onAgain={() => setGame({ ...game, key: Date.now() })}
        onLevel={startLevel} />
    );
  } else if (tab === 'karaoke') {
    body = playing
      ? <KaraokePlayer key={playing.id} entry={playing} onExit={() => setPlaying(null)} />
      : <KaraokeLibrary songs={songs} setSongs={setSongs} onPlay={setPlaying} />;
  } else if (tab === 'practice') body = <Practice onStart={(cfg, title) => setGame({ cfg, title, key: Date.now() })} />;
  else if (tab === 'progress') body = <Progress />;
  else if (tab === 'settings') body = <SettingsScreen />;
  else body = <Course onLevel={startLevel} onSettings={() => setTab('settings')} />;

  return (
    <div className="app">
      <header>
        <h1>🎤 Pitch<span>Trainer</span></h1>
        <nav>
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t && (t !== 'free' || !!game?.free) ? 'on' : ''} onClick={() => go(t)}>{label}</button>
          ))}
        </nav>
      </header>
      <TopPiano />
      <main>{body}</main>
      <Toaster />
    </div>
  );
}
