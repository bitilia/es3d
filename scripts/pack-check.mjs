#!/usr/bin/env node
// Packs the package the way `npm publish` does, then bundles its public entry
// from that tarball. The bundle fails if a file the library imports is missing
// from package.json "files".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es3d-pack-'));

try {
  const json = execSync(`npm pack --json --pack-destination "${tmp}"`, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const info = JSON.parse(json)[0];
  execFileSync('tar', ['-xzf', path.join(tmp, info.filename), '-C', tmp]);
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package', 'package.json'), 'utf8'));
  const rel = (pkg.exports && pkg.exports['.']) || pkg.main;
  const entry = path.join(tmp, 'package', rel);
  const input = path.join(tmp, 'entry.js');
  fs.writeFileSync(input, "import * as es3d from '@es3d/es3d';\nif (typeof es3d.compile !== 'function' || typeof es3d.createRenderer !== 'function') throw new Error('public entry is incomplete');\n");
  const vite = await import('vite');
  await vite.build({
    configFile: false,
    root: tmp,
    logLevel: 'warn',
    resolve: { alias: [{ find: /^@es3d\/es3d$/, replacement: entry }] },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      copyPublicDir: false,
      modulePreload: false,
      rolldownOptions: {
        input,
        output: { format: 'es', codeSplitting: false },
      },
    },
  });
  console.log(`${info.filename}: ${info.entryCount} files, ${(info.size / 1000).toFixed(1)} kB — entry bundles from the tarball.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
