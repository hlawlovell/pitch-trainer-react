import { describe, expect, it } from 'vitest';
import { pinyin } from 'pinyin-pro';
import { isChinese, linePinyin } from '../../src/lib/pinyin';

describe('pinyin for Chinese lyrics', () => {
  it('recognises Chinese, but not Japanese or Korean that use some Chinese characters', () => {
    expect(isChinese(['我还是会想起你'])).toBe(true);
    expect(isChinese(['君の名は', '東京'])).toBe(false); // kanji + kana
    expect(isChinese(['사랑해 愛'])).toBe(false);
    expect(isChinese(["I'm not a perfect person"])).toBe(false);
  });

  it('gives one entry per character, aligned with the line, with readings from context', () => {
    const line = '长大了 ok';
    const py = linePinyin(pinyin, line);
    expect(py).toHaveLength(line.length);
    expect(py.slice(0, 3)).toEqual(['zhǎng', 'dà', 'le']);
    expect(py.slice(3)).toEqual(['', '', '']); // space and Latin letters get no pinyin
  });
});
