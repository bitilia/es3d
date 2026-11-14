#!/usr/bin/env node
// One minified ES module for a page: createStage, ancestorNames, mulberry32,
// es3dSin and es3dCos. Written to browser/es3d-stage.min.js and published as
// @es3d/es3d/stage. The website build empties dist/, so this file lives elsewhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.ES3D_STAGE_OUT || path.join(ROOT, 'browser');
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
    emptyOutDir: false, // browser/ also holds es3d.min.js (build-browser.mjs)
    minify: true,
    target: 'es2022',
    sourcemap: false,
    copyPublicDir: false,
    modulePreload: false,
    // library mode leaves whitespace and region comments in an ES module;
    // a page loads this file as it is, so it is minified completely
    rolldownOptions: { output: { minify: true, comments: false } },
    lib: {
      entry: path.join(ROOT, 'src/stage.js'),
      formats: ['es'],
      fileName: () => 'es3d-stage.min.js',
    },
  },
});

const file = path.join(outDir, 'es3d-stage.min.js');
const size = fs.statSync(file).size;
console.log(`browser/es3d-stage.min.js: ${(size / 1024).toFixed(1)} kB`);
