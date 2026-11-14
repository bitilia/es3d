#!/usr/bin/env node
// One minified ES module with ES3D's whole browser-safe API (src/browser.js):
// documents, the renderer and the stage, and file conversion in the page.
// Written to browser/es3d.min.js and published as @es3d/es3d/browser. Built
// the way the stage file is (build-stage.mjs): one file, no source map, no
// import of another file, and nothing that only runs in Node.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.ES3D_BROWSER_OUT || path.join(ROOT, 'browser');
const NAME = 'es3d.min.js';
fs.mkdirSync(outDir, { recursive: true });

const vite = await import('vite');
await vite.build({
  configFile: false,
  root: ROOT,
  logLevel: 'warn',
  // the browser branch of io/compression.js; its Node branch (zlib) is left out
  define: { __ES3D_BROWSER__: 'true' },
  build: {
    outDir,
    emptyOutDir: false, // browser/ also holds es3d-stage.min.js
    minify: true,
    target: 'es2022',
    sourcemap: false,
    copyPublicDir: false,
    modulePreload: false,
    // library mode leaves whitespace and region comments in an ES module;
    // a page loads this file as it is, so it is minified completely
    rolldownOptions: { output: { minify: true, comments: false } },
    lib: {
      entry: path.join(ROOT, 'src/browser.js'),
      formats: ['es'],
      fileName: () => NAME,
    },
  },
});

const file = path.join(outDir, NAME);
const text = fs.readFileSync(file, 'utf8');
// a browser cannot load these: fail the build rather than publish them
const problems = [];
if (/["'`]node:[a-z]/.test(text)) problems.push('a node: module');
if (/\brequire\(/.test(text)) problems.push('require()');
if (/(?:from|import)\s*\(?\s*["']\.\.?\//.test(text)) problems.push('an import of another file');
if (problems.length) {
  console.error(`browser/${NAME} has ${problems.join(', ')}`);
  process.exit(1);
}
console.log(`browser/${NAME}: ${(text.length / 1024).toFixed(1)} kB`);
