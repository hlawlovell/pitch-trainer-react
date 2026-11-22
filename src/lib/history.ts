import { useSyncExternalStore } from 'react';
import { lsGet } from './storage';
import type { NoteResult } from './analysis';

export interface RoundLog {
  label: string;
  score: number;          // %
  rec: number | null;     // seconds into the recording
  songTime?: number;      // karaoke: seconds into the song
  notes: NoteResult[];
}

export interface Session {
  date: string;
  kind: 'trainer' | 'karaoke';
  title: string;
  partial: boolean;
  tol: number; lo: number; hi: number;
  tempo?: number; mode?: string; wait?: boolean;
  octaveFree?: boolean;
  avg: number;
  rec: string | null;     // recording file name
  rounds: RoundLog[];
}

const KEY = 'pt_history';
let HIST: Session[] = lsGet<Session[]>(KEY, []).map(s => ({ ...s, kind: s.kind ?? 'trainer' }));
const listeners = new Set<() => void>();

function persist() {
  for (;;) {
    try { localStorage.setItem(KEY, JSON.stringify(HIST)); return; }
    catch { if (HIST.length <= 1) return; HIST = HIST.slice(1); }
  }
}

export function addSession(s: Session) {
  HIST = [...HIST, s].slice(-300);
  persist();
  listeners.forEach(l => l());
}

export function clearHistory() {
  HIST = [];
  persist();
  listeners.forEach(l => l());
}

export const getHistory = () => HIST;
export function useHistory() {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, getHistory);
}
