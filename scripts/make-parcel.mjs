#!/usr/bin/env node
// Converts the Parcel demo's Shapr3D STEP parts (docs/demo/parcel/models/)
// into ES3D shapes with the STEP converter, and writes them as definitions
// in docs/demo/parcel/models/parcel.es3d: one <group> per part, in the
// CAD tool's millimetres, turned Y-up. The demo's scene uses them with
// <use>, painting each with the wrap's paper or ribbon.
//
//   npm run parcel              convert and write parcel.es3d
//   npm run parcel -- --check   exit 1 if parcel.es3d is out of date (CI)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepToExact } from '../src/io/step-exact.js';
import { parse } from '../src/format/parse.js';
import { h, Document, Comment, cloneElement } from '../src/format/ast.js';
import { serialize } from '../src/format/serializer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'docs/demo/parcel/models');
const OUT = path.join(DIR, 'parcel.es3d');
const PARTS = [
  ['box', 'the box'],
  ['box_top', 'the lid'],
  ['side_ties', 'the ribbon round the sides'],
  ['top_bowtie', 'the ribbon and bow on the lid'],
];

const defs = h('defs');
const notes = [];
for (const [id] of PARTS) {
  const r = stepToExact(fs.readFileSync(path.join(DIR, `${id}.step`)), { name: `${id}.step` });
  if (r.stats.tessellated) throw new Error(`${id}.step: ${r.stats.tessellated} faces were tessellated; the demo wants shapes only.`);
  notes.push(`${id}: ${r.note.replace(/^STEP B-rep: /, '').split('.')[0]}`);
  const doc = parse(r.text);
  // the converter's Z-up group holds one group per shell; the part keeps the turn and drops the colours
  const zup = doc.root.children.find((c) => c.type === 'element' && c.name === 'group');
  const part = h('group', { id, rotation: zup.attr('rotation') });
  for (const shell of zup.children.filter((c) => c.type === 'element')) {
    for (const el of shell.children.filter((c) => c.type === 'element')) {
      const copy = cloneElement(el);
      copy.removeAttr('material');
      part.appendChild(copy);
    }
  }
  defs.appendChild(part);
}

const root = h('es3d', { version: '1', unit: 'mm' }, h('title', {}, 'Parcel: the gift box from Shapr3D'), defs);
for (const [id] of PARTS) root.appendChild(h('use', { ref: id }));
const header = new Comment(
  ` The Parcel gift box: ${PARTS.map(([id, what]) => `${what} (${id})`).join(', ')}. Converted from the STEP files in this folder by scripts/make-parcel.mjs (npm run parcel); do not edit by hand. `,
);
const text = serialize(new Document({ root, syntax: 'xml', leading: [header] }), { pretty: true, comments: true });
const check = parse(text);
if (!check.ok) throw new Error(check.diagnostics.map((d) => d.message).join('\n'));

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    console.error('docs/demo/parcel/models/parcel.es3d is out of date. Run: npm run parcel');
    process.exit(1);
  }
  console.log('docs/demo/parcel/models/parcel.es3d is up to date');
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${Buffer.byteLength(text)} bytes)\n  ${notes.join('\n  ')}`);
}
