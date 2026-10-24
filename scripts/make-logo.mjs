// Rasterize the wordmark for structured data. Google's organization logo
// is a crawlable raster image at least 112px on both sides; the SVG wordmark
// is 304 by 96.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'docs/public/favicon.svg'), 'utf8')
  .replace('<svg ', '<svg width="1216" height="384" ');
const html = `<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`;
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1216, height: 384 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
const out = path.join(root, 'docs/public/logo.png');
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1216, height: 384 }, type: 'png' });
await browser.close();
const buf = fs.readFileSync(out);
console.log('png', buf.readUInt32BE(16), buf.readUInt32BE(20), buf.length);
