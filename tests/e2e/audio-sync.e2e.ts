/**
 * Regression test: karaoke notes must stay in sync with the music after seeking.
 *
 * History: Chrome seeks inaccurately in MP3s (it uses the file's coarse Xing seek table, then reports
 * the time you asked for rather than where it landed). After jumping around a real song the music was
 * ~0.7 s away from where the app drew the notes. The fix decodes MP3s to WAV before playback
 * (src/audio/seekable.ts). This test drives the real app in Chrome, jumps around a long synthetic MP3 by
 * clicking lines (forwards and backwards), records what the <audio> element actually plays, and checks
 * that the melody in that audio lines up with the notes the app is drawing.
 *
 * Needs Chrome (or Edge); set CHROME_PATH if it isn't in a standard location. Skipped if none is found.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { parseUltrastar } from '../../src/lib/ultrastar';
import { measureOffset, type Capture } from './align';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIX = fileURLToPath(new URL('../fixtures/sync/', import.meta.url));
const TOLERANCE = 0.1; // seconds; in sync measures ~0.03, the MP3 seek bug measured ~0.7

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => p && existsSync(p));

const song = parseUltrastar(readFileSync(FIX + 'sync-test.txt', 'utf8'));
const notes = song.tracks[0].lines.flatMap(l => l.notes);
const lines = song.tracks[0].lines;

describe.skipIf(!chromePath)('karaoke audio stays in sync with the notes', () => {
  let server: ViteDevServer, browser: Browser, page: Page;

  beforeAll(async () => {
    server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, strictPort: false } });
    await server.listen();
    browser = await puppeteer.launch({
      executablePath: chromePath, headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    page = await browser.newPage();
    await page.goto(server.resolvedUrls!.local[0], { waitUntil: 'networkidle0' });

    // open Karaoke, add the fixture song, open it
    await clickText(page, 'button', 'Karaoke');
    const input = await page.waitForSelector('input[type=file][accept]');
    await input!.uploadFile(FIX + 'sync-test.txt', FIX + 'sync-test.mp3');
    await page.waitForFunction(() => [...document.querySelectorAll('.song .t')].some(e => e.textContent === 'Sync Test'), { timeout: 30_000 });
    await clickText(page, '.song', 'Sync Test');
    await page.waitForFunction(() => { const a = document.querySelector('audio'); return !!a && a.readyState >= 3; }, { timeout: 60_000 });

    // record exactly what the <audio> element outputs, tagged with its currentTime
    await page.evaluate(() => {
      const a = document.querySelector('audio')!;
      const ac = new AudioContext();
      const src = ac.createMediaElementSource(a);
      const sp = ac.createScriptProcessor(2048, 1, 1);
      const mute = ac.createGain(); mute.gain.value = 0;
      src.connect(sp); sp.connect(mute); mute.connect(ac.destination);
      (window as any).__cap = { sr: ac.sampleRate, chunks: [] };
      sp.onaudioprocess = e => {
        if (!a.paused) (window as any).__cap.chunks.push({ ct: a.currentTime, d: Array.from(e.inputBuffer.getChannelData(0)) });
      };
    });
    // the song starts by itself once its audio is ready
    await page.waitForFunction(() => !document.querySelector('audio')!.paused, { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  /** Click a lyric line in the side panel (seeks to 1 s before it), then record ~7 s of playback. */
  async function jumpToLineAndMeasure(lineIdx: number) {
    await page.evaluate(i => (document.querySelectorAll('.kline')[i] as HTMLElement).click(), lineIdx);
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => { (window as any).__cap.chunks = []; });
    await new Promise(r => setTimeout(r, 7000));
    const cap: Capture = await page.evaluate(() => (window as any).__cap);
    return measureOffset(cap, notes);
  }

  // a line from the middle of each melody, visited out of order so we seek both forwards and backwards
  const lineIn = (t0: number) => lines.findIndex(l => l.start >= t0);
  const targets: [string, number][] = [
    ['forward jump to ~7:05', lineIn(425)],
    ['jump back to ~0:25', lineIn(25)],
    ['forward jump to ~3:35', lineIn(215)],
  ];

  for (const [label, idx] of targets) {
    it(`notes match the music after a ${label}`, async () => {
      const r = await jumpToLineAndMeasure(idx);
      console.log(`${label}: offset ${r.offset >= 0 ? '+' : ''}${r.offset.toFixed(2)} s over ${r.notes} notes`);
      expect(r.notes, `too few notes in the measured window (${r.from.toFixed(1)}–${r.to.toFixed(1)} s)`).toBeGreaterThanOrEqual(5);
      expect(Math.abs(r.offset), `audio is ${r.offset} s off the notes around ${r.from.toFixed(1)}–${r.to.toFixed(1)} s`).toBeLessThanOrEqual(TOLERANCE);
    }, 30_000);
  }
});

async function clickText(page: Page, sel: string, text: string) {
  const ok = await page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(e => e.textContent?.includes(text));
    el?.click();
    return !!el;
  }, sel, text);
  if (!ok) throw new Error(`nothing matching ${sel} contains "${text}"`);
}
