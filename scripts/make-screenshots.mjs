#!/usr/bin/env node
// Renders the pictures in README.md and the docs (docs/images/*.jpg): ES3D
// Studio with a few examples, and the demo sites. Each is taken in headless
// Chromium at a fixed size and pixel ratio with the WebGL2 renderer on
// SwiftShader, so a rerun after a change gives comparable pictures on any
// machine. The example gallery thumbnails have their own script
// (npm run thumbnails).
//
//   npm run screenshots                 all pictures
//   npm run screenshots -- studio-forest demo-spoke-tour    some of them
//   npm run screenshots -- --url http://127.0.0.1:5173/     use a running dev server
//
// Needs Playwright (npm i -D playwright && npx playwright install chromium).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images');
const STUDIO = { width: 1600, height: 900 };
const DEMO = { width: 1280, height: 800 };

/**
 * Each picture: the page, how long to let it settle, and an optional step
 * before the picture is taken (scrolling, clicking).
 */
const SHOTS = [
  { name: 'studio-primitives', url: 'studio/?example=primitives&renderer=webgl2&paused', size: STUDIO, wait: 3500 },
  { name: 'studio-forest', url: 'studio/?example=forest&renderer=webgl2&paused', size: STUDIO, wait: 6000 },
  { name: 'studio-errors', url: 'studio/?example=errors&renderer=webgl2&paused', size: STUDIO, wait: 3000 },
  { name: 'demo-parcel', url: 'demo/parcel/', size: DEMO, wait: 5000, reducedMotion: true },
  { name: 'demo-spoke', url: 'demo/spoke/', size: DEMO, wait: 3500, reducedMotion: true },
  { name: 'demo-helio', url: 'demo/helio/', size: DEMO, wait: 4000, reducedMotion: true },
  {
    name: 'demo-spoke-tour',
    url: 'demo/spoke/',
    size: DEMO,
    wait: 2500,
    reducedMotion: true,
    // the second stop of the scroll tour: the drivetrain
    before: (page) => scrollToStop(page, '0.34'),
  },
  // Ashby's fly-through: the approach, and the view from the square
  { name: 'demo-ashby', url: 'demo/ashby/', size: DEMO, wait: 4000, reducedMotion: true },
  { name: 'demo-ashby-square', url: 'demo/ashby/', size: DEMO, wait: 3000, reducedMotion: true, before: (page) => scrollToStop(page, '0.5') },
];

/** Scroll until the paragraph pinned to a scroll-tour stop is centred, and let the view settle. */
async function scrollToStop(page, stop) {
  const y = await page.$eval(`#tour [data-es3d-stop="${stop}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return r.top + scrollY + r.height / 2 - innerHeight / 2;
  });
  await page.evaluate((top) => scrollTo(0, top), y);
  await page.waitForTimeout(2000);
}

async function main() {
  const argv = process.argv.slice(2);
  let base = null;
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') base = argv[++i];
    else only.push(argv[i]);
  }
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    console.error('Playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  let server = null;
  let outDir = null;
  if (!base) {
    const vite = await import('vite');
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-shots-'));
    console.log('building the pages…');
    await vite.build({ logLevel: 'warn', build: { outDir, emptyOutDir: true, sourcemap: false } });
    server = await vite.preview({ logLevel: 'error', build: { outDir }, preview: { port: 4193, strictPort: false } });
    base = server.resolvedUrls.local[0];
  }
  if (!base.endsWith('/')) base += '/';
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await pw.chromium.launch();
  let status = 0;
  try {
    for (const shot of SHOTS) {
      if (only.length && !only.includes(shot.name)) continue;
      // reduced motion: demo sites hold still (no auto orbit), so pictures are repeatable
      const page = await browser.newPage({ viewport: shot.size, deviceScaleFactor: 1.25, reducedMotion: shot.reducedMotion ? 'reduce' : 'no-preference' });
      page.on('pageerror', (e) => console.error(`${shot.name}: ${e.message}`));
      await page.goto(base + shot.url);
      await page.waitForTimeout(shot.wait);
      if (shot.before) await shot.before(page);
      const file = path.join(OUT, `${shot.name}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
      console.log(`${path.relative(ROOT, file)}  ${fs.statSync(file).size.toLocaleString('en-US')} bytes`);
      await page.close();
    }
  } catch (e) {
    console.error(e.message);
    status = 1;
  } finally {
    await browser.close();
    if (server) await new Promise((r) => server.httpServer.close(r));
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  }
  process.exit(status);
}

main();
