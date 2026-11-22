/**
 * Pinyin for Chinese lyrics. pinyin-pro is large, so it's loaded only when a song has Chinese lyrics.
 * Readings are worked out per lyric line, so characters with several readings (了, 长, 还…) get the one
 * that fits their context.
 */
import { useEffect, useState } from 'react';

const HAN = /[㐀-鿿豈-﫿]/;
const KANA_HANGUL = /[぀-ヿ가-힯]/;

/** Chinese = has Chinese characters and no Japanese kana or Korean hangul (kanji alone don't count). */
export function isChinese(texts: string[]): boolean {
  const all = texts.join('');
  return HAN.test(all) && !KANA_HANGUL.test(all);
}

export const hasHan = (s: string) => HAN.test(s);

type Pinyin = typeof import('pinyin-pro').pinyin;
let loaded: Promise<Pinyin> | null = null;
const load = () => (loaded ??= import('pinyin-pro').then(m => m.pinyin));

/** For each line, the pinyin of each character of the line's text ('' for anything that isn't Chinese). */
export function linePinyin(pinyin: Pinyin, line: string): string[] {
  const out: string[] = [];
  for (const c of pinyin(line, { type: 'all', toneType: 'symbol' })) {
    // one entry per character; keep lengths aligned with the string's code units
    out.push(c.isZh ? c.pinyin : '');
    for (let i = 1; i < c.origin.length; i++) out.push('');
  }
  return out;
}

/** Pinyin per character for each line, or null while loading / when the lyrics aren't Chinese. */
export function usePinyin(lines: string[], enabled: boolean): string[][] | null {
  const [res, setRes] = useState<string[][] | null>(null);
  const key = lines.join('\n');
  useEffect(() => {
    setRes(null);
    if (!enabled || !isChinese(lines)) return;
    let alive = true;
    load().then(p => { if (alive) setRes(lines.map(l => linePinyin(p, l))); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return res;
}
