#!/usr/bin/env node
// Renders the pictures of the example gallery (docs/public/thumbs/*.jpg)
// with the reference renderer: each example is opened in ES3D Studio's
// minimal mode in headless Chromium and the viewport is saved as a JPEG.
//
//   node scripts/make-thumbnails.mjs            all examples
//   node scripts/make-thumbnails.mjs forest     only some (ids from the manifest)
//
// Needs Playwright (npm i -D playwright && npx playwright install chromium,
// or a global installation), like the browser benchmark.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/public/thumbs');
const WIDTH = 480;
const HEIGHT = 300;
// a moment of the animation that shows the scene well
const TIME = { 'rotating-cube': 1.2, gearbox: 2, solar: 6 };

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    try {
      const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
      const require = createRequire(path.join(root, 'noop.js'));
      return await import(pathToFileURL(require.resolve('playwright')).href);
    } catch {
      return null;
    }
  }
}

async function main() {
  const only = process.argv.slice(2);
  const pw = await loadPlaywright();
  if (!pw) {
    console.error('Playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  const vite = await import('vite');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-thumbs-'));
  console.log('building the pages…');
  await vite.build({ logLevel: 'warn', build: { outDir, emptyOutDir: true, sourcemap: false } });
  const server = await vite.preview({ logLevel: 'error', build: { outDir }, preview: { port: 4191, strictPort: false } });
  const base = server.resolvedUrls.local[0];
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  const browser = await chromium.launch();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/public/examples/manifest.json'), 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  let status = 0;
  try {
    for (const ex of manifest.examples) {
      if (only.length && !only.includes(ex.id)) continue;
      // the error demo has no scene to draw: show the editor with its diagnostics instead
      const full = ex.id === 'errors';
      const page = await browser.newPage({ viewport: full ? { width: WIDTH * 2, height: HEIGHT * 2 } : { width: WIDTH, height: HEIGHT }, deviceScaleFactor: full ? 0.5 : 1 });
      page.on('pageerror', (e) => console.error(`${ex.id}: ${e.message}`));
      const q = new URLSearchParams({ example: ex.id, renderer: 'webgl2', t: String(TIME[ex.id] || 0) });
      q.set('paused', '');
      if (!full) q.set('ui', 'minimal');
      await page.goto(`${base}studio/?${q}`);
      await page.waitForTimeout(ex.id === 'city' || ex.id === 'lod' ? 6000 : 3000);
      const file = path.join(OUT, `${ex.id}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 72 });
      console.log(`${path.relative(ROOT, file)}  ${fs.statSync(file).size.toLocaleString('en-US')} bytes`);
      await page.close();
    }
  } catch (e) {
    console.error(e.message);
    status = 1;
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  process.exit(status);
}

main();
