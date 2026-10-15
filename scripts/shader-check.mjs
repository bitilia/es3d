#!/usr/bin/env node
// Compiles every generated mesh shader variant (src/render/shaders/) in
// headless Chromium: WebGL2, and WebGPU on SwiftShader where Chromium offers
// it. The renderer compiles variants on first use, so an error in a rare
// combination of material features would otherwise only show on a page that
// uses it.
//
//   npm run test:shaders
//
// Needs Playwright (npm i -D playwright && npx playwright install chromium).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    console.error('Playwright is not installed: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  const vite = await import('vite');
  const server = await vite.createServer({ root: ROOT, logLevel: 'error', server: { port: 5197, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  const browser = await pw.chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'] });
  let status = 0;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(`${server.resolvedUrls.local[0]}test/render/shaders.html`);
    await page.waitForFunction(() => window.__result, null, { timeout: 10 * 60 * 1000 });
    const r = await page.evaluate(() => window.__result);
    console.log(`GLSL: ${r.glsl} of ${r.expected} variants compile and link`);
    console.log(r.webgpu ? `WGSL: ${r.wgsl} of ${r.expected} variants compile into pipelines` : 'WGSL: WebGPU is not available in this Chromium, skipped');
    for (const e of r.errors.slice(0, 20)) console.error(e);
    if (r.errors.length || r.glsl !== r.expected || (r.webgpu && r.wgsl !== r.expected)) status = 1;
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(status);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
