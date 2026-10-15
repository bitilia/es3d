#!/usr/bin/env node
// Reference-image test: do renders look the same everywhere?
//
// Renders a fixed set of examples in headless Chromium with each backend
// (WebGL2, and WebGPU on SwiftShader) at a fixed size, pixel ratio and
// animation time, then compares every picture
//   - with the saved reference in test/render/reference/<scene>.png, and
//   - WebGPU with WebGL2 (both backends must draw the same picture).
// Differences are written to test/render/out/ as <scene>-<backend>-diff.png.
//
//   npm run test:render                    compare (exit code 1 on a mismatch)
//   npm run test:render -- --update        write new references (from WebGL2)
//   npm run test:render -- --only gearbox  some scenes only
//   npm run test:render -- --url http://127.0.0.1:5173/   use a running dev server
//   npm run test:render -- --gpu           draw with this machine's GPU instead of
//                                          SwiftShader, and compare with the references
//
// References are drawn by WebGL2 on SwiftShader (Chromium's software GPU), so
// they are the same on every machine. WebGPU uses SwiftShader where Chromium
// offers it (Linux) and the hardware GPU otherwise; that is a cross-device
// comparison too.
//
// Needs Playwright (npm i -D playwright && npx playwright install chromium).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = path.join(ROOT, 'test/render/reference');
const OUT = path.join(ROOT, 'test/render/out');
const WIDTH = 480;
const HEIGHT = 300;
// scenes and the animation time to draw them at
const SCENES = { primitives: 0, materials: 0, gearbox: 2, staircases: 0, logo: 0, compact: 0 };
// A pixel "differs" when a channel is off by more than PIXEL_TOLERANCE; a
// picture matches while few pixels differ (antialiased edges and sub-pixel
// rasterisation legitimately vary between GPUs) and the mean error is small.
const PIXEL_TOLERANCE = 24;
const MAX_DIFFERING = 0.006; // fraction of pixels
const MAX_MEAN = 1.2; // mean absolute channel error, 0..255
// The materials scene has a fine checkerboard seen at grazing angles, where
// anisotropic filtering decides the colour. GPUs implement it differently (the
// standards only bound it), so that scene gets more room.
const MAX_DIFFERING_FOR = { materials: 0.016 };

function args() {
  const a = process.argv.slice(2);
  const o = { update: false, only: null, url: null, gpu: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--update') o.update = true;
    else if (a[i] === '--gpu') o.gpu = true;
    else if (a[i] === '--only') o.only = a[++i].split(',');
    else if (a[i] === '--url') o.url = a[++i];
  }
  return o;
}

async function main() {
  const opts = args();
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    console.error('Playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  let base = opts.url;
  let server = null;
  let outDir = null;
  if (!base) {
    const vite = await import('vite');
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-render-'));
    console.log('building the pages…');
    await vite.build({ logLevel: 'warn', build: { outDir, emptyOutDir: true, sourcemap: false } });
    server = await vite.preview({ logLevel: 'error', build: { outDir }, preview: { port: 4192, strictPort: false } });
    base = server.resolvedUrls.local[0];
  }
  if (!base.endsWith('/')) base += '/';
  fs.mkdirSync(REF, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const scenes = Object.keys(SCENES).filter((s) => !opts.only || opts.only.includes(s));
  const shots = {}; // scene -> backend -> PNG buffer
  const HARDWARE = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'];
  const SWIFTSHADER_WEBGPU = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'];
  if (opts.gpu && opts.update) {
    console.error('References are drawn on SwiftShader; --update ignores --gpu.');
    opts.gpu = false;
  }
  // Playwright's own Chromium has no D3D12 shader compiler on Windows, so it
  // finds a WebGPU adapter there but cannot create a device; an installed
  // Chrome or Edge can.
  const hardware = [{ args: HARDWARE }, { args: HARDWARE, channel: 'chrome' }, { args: HARDWARE, channel: 'msedge' }];
  const backends = [
    { id: 'webgl2', choices: opts.gpu ? hardware : [{ args: [] }] },
    { id: 'webgpu', choices: opts.gpu ? hardware : [{ args: SWIFTSHADER_WEBGPU }, ...hardware] },
  ];
  // the first browser that can draw with the backend
  const launchFor = async (b) => {
    for (const choice of b.choices) {
      let browser;
      try {
        browser = await pw.chromium.launch(choice);
      } catch {
        continue; // that browser is not installed
      }
      if (b.id !== 'webgpu') return browser;
      const page = await browser.newPage();
      await page.goto(base); // navigator.gpu needs a secure context such as localhost, not about:blank
      const ok = await page.evaluate(async () => {
        try {
          const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
          const device = adapter && (await adapter.requestDevice());
          if (device) device.destroy();
          return !!device;
        } catch {
          return false;
        }
      });
      await page.close();
      if (ok) {
        if (choice.channel) console.log(`${b.id}: drawing with the installed ${choice.channel}`);
        return browser;
      }
      await browser.close();
    }
    return null;
  };
  let failed = 0;
  try {
    for (const b of backends) {
      const browser = await launchFor(b);
      if (!browser) {
        console.log(`${b.id}: not available in this Chromium, skipped`);
        continue;
      }
      try {
        for (const scene of scenes) {
          const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
          const q = new URLSearchParams({ example: scene, renderer: b.id, ui: 'minimal', t: String(SCENES[scene]) });
          q.set('paused', '');
          if (b.id === 'webgpu') q.set('present', 'readback'); // headless WebGPU canvases are not composited
          await page.goto(`${base}studio/?${q}`);
          await page.waitForTimeout(2500);
          const label = await page.$eval('#backend-label', (el) => el.textContent);
          if (!/WebGL2|WebGPU/.test(label)) {
            console.log(`${scene.padEnd(12)} ${b.id.padEnd(7)} skipped: ${label}`);
            await page.close();
            continue;
          }
          const png = await page.locator('#viewport').screenshot({ type: 'png' });
          (shots[scene] ||= {})[b.id] = png;
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }

    // compare in a page: the browser decodes PNGs, so no image library is needed
    const browser = await pw.chromium.launch();
    const page = await browser.newPage();
    const compare = (a, b) =>
      page.evaluate(
        async ([a, b, tol]) => {
          const load = (src) => new Promise((res, rej) => {
            const im = new Image();
            im.onload = () => res(im);
            im.onerror = rej;
            im.src = src;
          });
          const [ia, ib] = await Promise.all([load(a), load(b)]);
          if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: true };
          const w = ia.width, h = ia.height;
          const px = (im) => {
            const c = new OffscreenCanvas(w, h).getContext('2d');
            c.drawImage(im, 0, 0);
            return c.getImageData(0, 0, w, h).data;
          };
          const da = px(ia), db = px(ib);
          const diff = new OffscreenCanvas(w, h);
          const dc = diff.getContext('2d');
          const out = dc.createImageData(w, h);
          let sum = 0, differing = 0;
          for (let i = 0; i < da.length; i += 4) {
            let m = 0;
            for (let k = 0; k < 3; k++) {
              const d = Math.abs(da[i + k] - db[i + k]);
              sum += d;
              if (d > m) m = d;
            }
            if (m > tol) differing++;
            // grey copy of the picture, differing pixels in red
            const g = (da[i] + da[i + 1] + da[i + 2]) / 9;
            out.data[i] = m > tol ? 255 : g;
            out.data[i + 1] = m > tol ? 40 : g;
            out.data[i + 2] = m > tol ? 40 : g;
            out.data[i + 3] = 255;
          }
          dc.putImageData(out, 0, 0);
          const blob = await diff.convertToBlob({ type: 'image/png' });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return { mean: sum / ((da.length / 4) * 3), differing: differing / (da.length / 4), diff: btoa(bin) };
        },
        [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`, PIXEL_TOLERANCE],
      );
    const verdict = (r, scene) => !r.sizeMismatch && r.differing <= (MAX_DIFFERING_FOR[scene] ?? MAX_DIFFERING) && r.mean <= MAX_MEAN;
    const fmt = (r) => (r.sizeMismatch ? 'size differs' : `${(r.differing * 100).toFixed(2)}% pixels differ, mean error ${r.mean.toFixed(2)}`);
    const check = async (label, a, b, diffName) => {
      const r = await compare(a, b);
      const ok = verdict(r, label.split(' ')[0]);
      if (!ok) {
        failed++;
        if (r.diff) fs.writeFileSync(path.join(OUT, diffName), Buffer.from(r.diff, 'base64'));
      }
      console.log(`${label.padEnd(30)} ${ok ? 'ok  ' : 'FAIL'} ${fmt(r)}`);
    };

    for (const scene of scenes) {
      const s = shots[scene] || {};
      for (const [id, png] of Object.entries(s)) fs.writeFileSync(path.join(OUT, `${scene}-${id}.png`), png);
      const refFile = path.join(REF, `${scene}.png`);
      if (opts.update) {
        if (s.webgl2) {
          fs.writeFileSync(refFile, s.webgl2);
          console.log(`${scene.padEnd(12)} reference written`);
        }
        continue;
      }
      if (!fs.existsSync(refFile)) {
        console.log(`${scene.padEnd(12)} no reference (run with --update)`);
        failed++;
        continue;
      }
      const ref = fs.readFileSync(refFile);
      for (const [id, png] of Object.entries(s)) await check(`${scene} ${id} vs reference`, ref, png, `${scene}-${id}-diff.png`);
      if (s.webgl2 && s.webgpu) await check(`${scene} webgpu vs webgl2`, s.webgl2, s.webgpu, `${scene}-webgpu-vs-webgl2-diff.png`);
    }
    await browser.close();
  } finally {
    if (server) await new Promise((r) => server.httpServer.close(r));
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  }
  if (failed) console.log(`\n${failed} comparison(s) failed; pictures and diffs are in ${path.relative(ROOT, OUT)}/`);
  process.exit(failed ? 1 : 0);
}

main();
