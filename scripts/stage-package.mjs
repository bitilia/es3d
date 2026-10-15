#!/usr/bin/env node
// Prepares the npm package for staged publishing, without contacting npm.
//
//   npm run stage:prepare
//
// 1. packs the package exactly as `npm publish` would (the "files" list);
// 2. unpacks it into staging/package/ and replaces the repository README with
//    the package README (npm/README.md), which is what npmjs.com shows;
// 3. checks it: no personal or private data, no secrets, every import resolves;
// 4. packs staging/package/ again into staging/<name>-<version>.tgz, the exact
//    tarball `npm stage publish` will send from that folder.
//
// Staging itself is a separate, deliberate step (see staging/REVIEW.md):
//   cd staging/package && npm stage publish
// It needs an npm login with 2FA and npm 11.15 or newer. Nothing here logs in
// or publishes.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(ROOT, 'staging');
const PKG = path.join(STAGING, 'package');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' });
// `npm run` sets npm_execpath; running npm's script with node needs no shell (npm.cmd on Windows would)
const npmRun = (args, cwd) => (process.env.npm_execpath ? run(process.execPath, [process.env.npm_execpath, ...args], cwd) : run('npm', args, cwd));

// What must never be published. Matches are listed and fail the run.
const LEAKS = [
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['local path', /[A-Za-z]:[\\/]+Users[\\/]|\/Users\/[a-z]|\/home\/[a-z]|AppData/gi],
  ['private repository', /es3d-private/gi],
  ['npm token', /npm_[A-Za-z0-9]{36}/g],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}/g],
  ['AWS key', /AKIA[0-9A-Z]{16}/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['secret assignment', /\b(password|passwd|secret|api[_-]?key|auth[_-]?token)\b\s*[:=]/gi],
  ['credentials file', /_authToken|\.npmrc\b/g],
  ['source map', /sourceMappingURL/g],
];
// Names that are personal; extend with anything else that must stay private.
const PERSONAL = /\bilya\b|\bilia\b|kalina|techareaone/gi;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function packInto(cwd, dest) {
  const out = JSON.parse(npmRun(['pack', '--json', '--pack-destination', dest], cwd));
  // npm 11 prints an array of results, npm 12 an object keyed by package name
  return Array.isArray(out) ? out[0] : Object.values(out)[0];
}

// 1-2. pack the repository and unpack it with the package README
fs.mkdirSync(STAGING, { recursive: true });
for (const f of fs.readdirSync(STAGING)) if (f.endsWith('.tgz')) fs.rmSync(path.join(STAGING, f));
fs.rmSync(PKG, { recursive: true, force: true });
const first = packInto(ROOT, STAGING);
// relative paths: GNU tar on Windows reads "C:" as a remote host
run('tar', ['-xzf', first.filename], STAGING);
fs.rmSync(path.join(STAGING, first.filename));
fs.copyFileSync(path.join(ROOT, 'npm/README.md'), path.join(PKG, 'README.md'));

// The packed manifest is the repository's, including the website, benchmark and
// test scripts and their devDependencies. None of those files are in the
// package. Publish the library manifest only. The command stays available
// through "bin".
const KEEP = ['name', 'version', 'description', 'type', 'license', 'homepage', 'repository', 'bugs', 'keywords', 'main', 'exports', 'bin', 'files', 'engines', 'publishConfig'];
const packed = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const manifest = {};
for (const key of KEEP) if (packed[key] !== undefined) manifest[key] = packed[key];
fs.writeFileSync(path.join(PKG, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 3. checks
const problems = [];
const files = walk(PKG);
for (const f of files) {
  const rel = path.relative(PKG, f).split(path.sep).join('/');
  if (/(^|\/)\.|\.(map|env|pem|key|p12|log)$/.test(rel)) problems.push(`${rel}: file type that should not be published`);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [label, re] of [...LEAKS, ['personal name', PERSONAL]]) {
      re.lastIndex = 0;
      const m = line.match(re);
      if (m) problems.push(`${rel}:${i + 1}: ${label}: ${[...new Set(m)].join(', ')}`);
    }
    if (/\.m?js$/.test(rel)) {
      for (const m of line.matchAll(/(?:from\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) {
        if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) problems.push(`${rel}:${i + 1}: import of a file that is not in the package: ${m[1]}`);
      }
    }
  });
}
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
if (pkg.name !== '@es3d/es3d') problems.push(`package name is "${pkg.name}"; the public package is @es3d/es3d`);
if (pkg.publishConfig?.access !== 'public') problems.push('publishConfig.access must be public');
if (pkg.repository?.url !== 'git+https://github.com/bitilia/es3d.git') problems.push(`repository is "${pkg.repository?.url}"; GitHub stays github.com/bitilia/es3d`);
if (pkg.private) problems.push('package.json has "private": true; npm would refuse to stage it');
if (pkg.devDependencies || pkg.dependencies) problems.push('published package.json still lists dependencies');
if (pkg.scripts) problems.push('published package.json still has development scripts');
for (const s of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublishOnly'])
  if (pkg.scripts && pkg.scripts[s]) problems.push(`package.json runs a "${s}" script: check it before staging`);

if (problems.length) {
  console.error(`Not ready to stage: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// 4. the exact tarball `npm stage publish` sends from staging/package
const final = packInto(PKG, STAGING);
console.log(`${pkg.name}@${pkg.version} ready to stage from staging/package/`);
console.log(`  ${final.entryCount} files, ${(final.size / 1024).toFixed(1)} kB packed, ${(final.unpackedSize / 1024).toFixed(1)} kB unpacked`);
console.log(`  tarball: staging/${final.filename}`);
console.log(`  integrity: ${final.integrity}`);
console.log('  checks passed: no personal data, secrets or private links; every import resolves');
console.log('\nNothing was sent to npm.');
