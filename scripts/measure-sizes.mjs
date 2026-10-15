#!/usr/bin/env node
// Measures the file sizes the website quotes and writes them to
// docs/site/sizes.json. Pages never measure anything themselves: the site
// plugin writes these numbers into the HTML when a page is served or built
// (<!--#filesize of="…" -->).
//
// For each file: its size and its gzipped size (level 9).
//
//   npm run sizes              measure and write docs/site/sizes.json
//   npm run sizes -- --check   exit 1 if sizes.json is out of date (CI)
//
// Run it after changing an example, the home page logo or a demo scene.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The demo scenes import their STEP models with Vite's `?raw` suffix.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { readFile } from 'node:fs/promises';
export async function load(url, context, next) {
  if (!url.endsWith('?raw')) return next(url, context);
  const text = await readFile(new URL(url.slice(0, -4)), 'utf8');
  return { format: 'module', source: 'export default ' + JSON.stringify(text) + ';', shortCircuit: true };
}`),
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/site/sizes.json');
const at = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

function measure(text) {
  // git stores the scenes with LF line endings and the site is built from
  // that; a Windows checkout turns them into CRLF, which must not change the
  // quoted sizes (or make the CI check fail)
  const bytes = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
  return { es3d: bytes.length, gzip: zlib.gzipSync(bytes, { level: 9 }).length };
}

const sizes = {};

// files on the site, keyed by their path in the repository
const files = ['docs/public/es3d-logo.es3d'];
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/public/examples/manifest.json'), 'utf8'));
for (const ex of manifest.examples) files.push(`docs/public/examples/${ex.file}`);
for (const f of files) sizes[f] = measure(fs.readFileSync(path.join(ROOT, f), 'utf8'));

// the demo sites, as each one first shows its scene
const { villageScene } = await at('docs/demo/ashby/scene.js');
const { giftScene, loadGift } = await at('docs/demo/parcel/scene.js');
const { bikeScene } = await at('docs/demo/spoke/scene.js');
const { roomScene } = await at('docs/demo/helio/scene.js');
sizes['demo/ashby'] = measure(villageScene({ tour: true }));
sizes['demo/parcel'] = measure(giftScene('red', await loadGift()));
sizes['demo/spoke'] = measure(bikeScene('signal'));
sizes['demo/spoke-tour'] = measure(bikeScene('signal', { tour: true }));
sizes['demo/helio'] = measure(roomScene('brass'));

const json = JSON.stringify(sizes, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== json) {
    console.error('docs/site/sizes.json is out of date. Run: npm run sizes');
    process.exit(1);
  }
  console.log('docs/site/sizes.json is up to date');
} else {
  fs.writeFileSync(OUT, json);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${Object.keys(sizes).length} entries)`);
}
