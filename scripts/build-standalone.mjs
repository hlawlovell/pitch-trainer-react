// Builds the whole app into ONE html file (dist-standalone/pitch-trainer.html)
// that opens with a double-click, no server needed.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const res = await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.mp3': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(':') : [],
  outdir: 'out',
  write: false,
});
const js = res.outputFiles.find(f => f.path.endsWith('.js')).text;
const css = res.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pitch Trainer</title><style>${css}</style></head>
<body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
mkdirSync('dist-standalone', { recursive: true });
writeFileSync('dist-standalone/pitch-trainer.html', html);
console.log(`dist-standalone/pitch-trainer.html  ${(html.length / 1024).toFixed(0)} KB`);
