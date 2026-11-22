import { getS } from './settings';

export const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const FIX_S = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const FIX_F = ['Do', 'Re♭', 'Re', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const MOV_S = ['Do', 'Di', 'Re', 'Ri', 'Mi', 'Fa', 'Fi', 'Sol', 'Si', 'La', 'Li', 'Ti'];
const MOV_F = ['Do', 'Ra', 'Re', 'Me', 'Mi', 'Fa', 'Se', 'Sol', 'Le', 'La', 'Te', 'Ti'];

export const IVN = ['Unison', 'Minor 2nd', 'Major 2nd', 'Minor 3rd', 'Major 3rd', 'Perfect 4th', 'Tritone',
  'Perfect 5th', 'Minor 6th', 'Major 6th', 'Minor 7th', 'Major 7th', 'Octave'];

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const ftom = (f: number) => 69 + 12 * Math.log2(f / 440);
export const pc = (m: number) => ((m % 12) + 12) % 12;
export const octOf = (m: number) => Math.floor(m / 12) - 1;
export const isBlack = (m: number) => [1, 3, 6, 8, 10].includes(pc(m));

/** Letter name, e.g. C♯4. Always unambiguous (used in reports). */
export function letter(m: number, withOct = true): string {
  m = Math.round(m);
  return (getS().accidental === 'flat' ? FLAT : SHARP)[pc(m)] + (withOct ? octOf(m) : '');
}

/** Name in the user's chosen style. root = key note for movable do (null → letters). */
export function noteName(m: number, root: number | null = null): string {
  const S = getS();
  m = Math.round(m);
  const o = S.octave ? String(octOf(m)) : '';
  const fl = S.accidental === 'flat';
  switch (S.naming) {
    case 'fixed': return (fl ? FIX_F : FIX_S)[pc(m)] + o;
    case 'movable': return root == null ? letter(m, S.octave) : (fl ? MOV_F : MOV_S)[pc(m - root)];
    case 'both': return root == null ? letter(m, S.octave) : letter(m, S.octave) + ' · ' + (fl ? MOV_F : MOV_S)[pc(m - root)];
    default: return letter(m, S.octave);
  }
}

export const fmtTime = (s: number) => {
  if (!isFinite(s)) return '–';
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
