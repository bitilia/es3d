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
  build: {
    outDir,
    emptyOutDir: true,
    minify: true,
    target: 'es2022',
    sourcemap: false,
    copyPublicDir: false,
    modulePreload: false,
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
