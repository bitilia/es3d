#!/usr/bin/env node
// es3d: command-line companion of the reference implementation.
//
//   npm run es3d -- validate scene.es3d
//   npm run es3d -- fmt scene.es3d -o pretty.es3d
//   npm run es3d -- stats scene.es3d
//   npm run es3d -- glb scene.es3d -o scene.glb
//   npm run es3d -- import drawing.svg -o drawing.es3d
//
// Run without arguments for the full command list. Input "-" reads stdin;
// without -o, text goes to stdout (binary output requires -o).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parse, detectSyntax, formatDiagnostics } from '../src/format/parse.js';
import { serialize } from '../src/format/serializer.js';
import { compile } from '../src/pipeline.js';
import { exportOBJ } from '../src/io/obj.js';
import { exportSTL } from '../src/io/stl.js';
import { exportSTEP } from '../src/io/step.js';
import { detectKind, importFiles } from '../src/io/convert.js';
import { exportableInstances } from '../src/io/external-scene.js';
import { optimize, expandProcedural } from '../src/optimize/optimizer.js';

const HELP = `es3d <command> [options] <input>

Commands
  validate   parse, validate and build the scene; print diagnostics (exit 1 on errors).
             Repeated warnings are grouped; --json lists every one
  fmt        pretty-print, keeping the syntax (markup or compact)
  minify     minified markup (short attribute aliases, no comments)
  compact    convert to the compact syntax           (--min for one line)
  markup     convert to the markup syntax            (--min for minified)
  json       convert to the JsonML form              (--pretty for indentation)
  optimize   run the optimizer and print its report to stderr
  expand     replace <repeat>/<scatter> with explicit elements
  obj        export Wavefront OBJ (+ .mtl next to -o) (--lod <0-3>)
  glb        packed glTF binary                     (instances, LODs, lights, cameras, animation)
  stl        export STL for 3D printing, Z-up        (--lod <0-3>, --ascii)
  step       export tessellated STEP (AP242), Z-up  (--lod <0-3>)
  import     convert SVG, OBJ (+MTL), STL, STEP or glTF (.gltf + .bin, .glb) to ES3D:
             SVG shapes are extruded (--size, --depth, --bevel, --flat, --no-strokes, --plate),
             STEP solids become ES3D shapes (boxes, extrusions, revolves, paths; free-form faces a mesh),
             meshes become <mesh> elements (--precision, --smooth, --up y for Y-up STL or STEP)
  stats      sizes, element / instance / triangle counts and pipeline timings

Options
  -o, --out <file>   output file (default: stdout for text)
  --precision <n>    round numbers to n decimals when writing text
  --lod <n>          level of detail for obj, stl and step (default 0 = finest)
  --instancing       glb always writes EXT_mesh_gpu_instancing
  --quantize         glb always writes KHR_mesh_quantization
  --min / --pretty   force minified / pretty output
  --json             validate/stats: machine readable output
  --ascii            STL: write ASCII instead of binary
  --size <n>         import SVG: length of the drawing's longer side (default 10)
  --depth <percent>  import SVG: extrusion depth in % of the size (default 4)
  --bevel <percent>  import SVG: rounded edge radius in % of the size (default 0)
  --flat             import SVG: flat shapes instead of extrusions
  --no-strokes       import SVG: ignore strokes
  --plate            import SVG: add a backing plate
  --smooth <deg>     import meshes: crease angle for computed normals (default 30)
  --up <z|y>         import STL and STEP: the file's up axis (default z)
  -h, --help         this text`;

function parseArgs(argv) {
  const o = { cmd: null, input: null, out: null, precision: null, lod: 0, instancing: false, quantize: 0, min: false, pretty: false, json: false, ascii: false, svg: {}, mesh: {}, stl: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-o' || a === '--out') o.out = val();
    else if (a === '--precision') o.precision = Number(val());
    else if (a === '--lod') o.lod = Number(val());
    else if (a === '--instancing') o.instancing = true;
    else if (a === '--quantize') o.quantize = true;
    else if (a === '--min') o.min = true;
    else if (a === '--pretty') o.pretty = true;
    else if (a === '--json') o.json = true;
    else if (a === '--ascii') o.ascii = true;
    else if (a === '--size') o.svg.size = Number(val());
    else if (a === '--depth') o.svg.depth = Number(val()) / 100;
    else if (a === '--bevel') o.svg.bevel = Number(val()) / 100;
    else if (a === '--flat') o.svg.depth = 0;
    else if (a === '--no-strokes') o.svg.strokes = false;
    else if (a === '--plate') o.svg.base = true;
    else if (a === '--smooth') o.mesh.smooth = Number(val());
    else if (a === '--up') o.stl.up = val() === 'y' ? 'y' : 'z';
    else if (a.startsWith('-') && a !== '-') fail(`unknown option ${a}`);
    else if (!o.cmd) o.cmd = a;
    else if (!o.input) o.input = a;
    else fail(`unexpected argument ${a}`);
  }
  return o;
}

function fail(msg, code = 2) {
  process.stderr.write(`es3d: ${msg}\n`);
  process.exit(code);
}

function readInput(file) {
  let bytes;
  try {
    bytes = file === '-' ? fs.readFileSync(0) : fs.readFileSync(file);
  } catch (e) {
    fail(`cannot read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
  }
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** ES3D input as text (markup, compact or JSON). */
function es3dInput(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

function write(opts, data) {
  if (opts.out) {
    fs.writeFileSync(opts.out, data);
    const n = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    process.stderr.write(`wrote ${opts.out} (${n.toLocaleString('en-US')} bytes)\n`);
  } else if (typeof data === 'string') {
    process.stdout.write(data.endsWith('\n') ? data : data + '\n');
  } else {
    fail('binary output needs -o <file>');
  }
}

function report(doc) {
  return formatDiagnostics(doc);
}

/** Parse and validate, or exit with the diagnostics. */
function parsed(input) {
  const doc = parse(input);
  if (!doc.ok) {
    process.stderr.write(report(doc) + '\n');
    process.exit(1);
  }
  const warnings = formatDiagnostics(doc.warnings || [], doc.lineIndex);
  if (warnings) process.stderr.write(warnings + '\n\n');
  return doc;
}

function compiled(input) {
  const r = compile(input);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) {
    process.stderr.write(formatDiagnostics(r) + '\n');
    process.exit(1);
  }
  return r;
}

/** Material library of an OBJ file: its mtllib, else <name>.mtl next to it. */
function mtlFor(objPath, text) {
  if (objPath === '-') return '';
  const dir = path.dirname(objPath);
  const m = /^mtllib\s+(.+)$/m.exec(text);
  const candidates = [m ? path.join(dir, m[1].trim()) : null, objPath.replace(/\.obj$/i, '') + '.mtl'].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  return '';
}

/** External buffers of a .gltf file, read from next to it. */
function gltfCompanions(gltfPath, bytes) {
  if (gltfPath === '-') return [];
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  const out = [];
  for (const b of json.buffers || []) {
    if (!b.uri || b.uri.startsWith('data:')) continue;
    const name = decodeURIComponent(b.uri);
    const file = path.join(path.dirname(gltfPath), name);
    if (fs.existsSync(file)) out.push({ name, bytes: new Uint8Array(fs.readFileSync(file)) });
  }
  return out;
}

const sizes = (data) => {
  const b = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return { raw: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length, brotli: zlib.brotliCompressSync(b).length };
};

function stats(input, opts) {
  const t0 = performance.now();
  const r = compiled(input);
  const t1 = performance.now();
  const meshOf = (e, l) => r.cache.mesh(e, l);
  const lods = [0, 1, 2, 3].map((lod) => {
    let tris = 0;
    for (const i of exportableInstances(r.scene)) {
      const e = r.scene.geometries[r.scene.geom[i]];
      const m = meshOf(e, Math.min(lod, e.lods - 1));
      if (m.kind === 'triangles') tris += m.primitiveCount;
    }
    return tris;
  });
  const t2 = performance.now();
  const elements = new Map();
  for (const el of r.doc.byUid.values()) elements.set(el.name, (elements.get(el.name) || 0) + 1);
  const out = {
    syntax: r.doc.syntax,
    size: sizes(input),
    elements: Object.fromEntries([...elements].sort((a, b) => b[1] - a[1])),
    instances: r.scene.count,
    uniqueGeometries: r.scene.geometries.length,
    materials: r.scene.materials.length,
    lights: r.scene.lights.length,
    cameras: r.scene.cameras.length,
    trianglesPerLod: lods,
    bounds: r.scene.bounds,
    // single cold run (includes JIT warm-up); see npm run bench for steady-state figures
    timingsMs: { parse: r.timings.parse, build: r.timings.build, flatten: r.timings.flatten, total: t1 - t0, geometryAllLods: t2 - t1 },
    diagnostics: r.diagnostics.length,
  };
  if (opts.json) return JSON.stringify(out, null, 2);
  const kb = (n) => (n < 1e4 ? `${n} B` : n < 1e7 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(2)} MB`);
  const f = (n) => n.toLocaleString('en-US');
  const b = out.bounds;
  return [
    `syntax        ${out.syntax}`,
    `size          ${kb(out.size.raw)} (gzip ${kb(out.size.gzip)}, brotli ${kb(out.size.brotli)})`,
    `elements      ${Object.entries(out.elements).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `instances     ${f(out.instances)} from ${f(out.uniqueGeometries)} unique geometries, ${out.materials} materials, ${out.lights} lights, ${out.cameras} cameras`,
    `triangles     ${lods.map((t, i) => `LOD${i} ${f(t)}`).join('  ')}`,
    `bounds        [${b.min.map((v) => +v.toFixed(3)).join(', ')}] .. [${b.max.map((v) => +v.toFixed(3)).join(', ')}]`,
    `timings       (cold) parse ${out.timingsMs.parse.toFixed(2)} ms, build ${out.timingsMs.build.toFixed(2)} ms, flatten ${out.timingsMs.flatten.toFixed(2)} ms, meshes (all LODs) ${out.timingsMs.geometryAllLods.toFixed(1)} ms`,
    `diagnostics   ${out.diagnostics}`,
  ].join('\n');
}

const COMMANDS = ['validate', 'fmt', 'minify', 'compact', 'markup', 'xml', 'json', 'optimize', 'expand', 'obj', 'glb', 'stl', 'step', 'import', 'stats'];

async function main() {
  // output piped into head & co.: stop quietly when the reader goes away
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.cmd) {
    console.log(HELP);
    process.exit(opts.cmd || opts.help ? 0 : 2);
  }
  if (!COMMANDS.includes(opts.cmd)) fail(`unknown command '${opts.cmd}' (try --help)`);
  if (!opts.input) fail(`${opts.cmd}: missing input file (use - for stdin)`);
  const bytes = readInput(opts.input);
  const textOpts = (syntax, pretty) => ({ syntax, pretty, precision: Number.isFinite(opts.precision) ? opts.precision : null });
  switch (opts.cmd) {
    case 'validate': {
      const r = compile(es3dInput(bytes));
      const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
      const warnings = r.diagnostics.length - errors;
      if (opts.json) console.log(JSON.stringify({ ok: errors === 0, diagnostics: r.diagnostics.map((d) => d.toJSON()) }, null, 2));
      else {
        const text = formatDiagnostics(r);
        if (text) process.stderr.write(text + '\n\n');
        console.log(`${opts.input}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}${errors ? '' : `, ${r.scene.count.toLocaleString('en-US')} instances`}`);
      }
      process.exit(errors ? 1 : 0);
      break;
    }
    case 'fmt': {
      const input = es3dInput(bytes);
      const doc = parsed(input);
      const syntax = typeof input === 'string' && detectSyntax(input) === 'compact' ? 'compact' : 'xml';
      write(opts, serialize(doc, textOpts(syntax, !opts.min)));
      break;
    }
    case 'minify':
      write(opts, serialize(parsed(es3dInput(bytes)), textOpts('xml', false)));
      break;
    case 'compact':
      write(opts, serialize(parsed(es3dInput(bytes)), textOpts('compact', !opts.min)));
      break;
    case 'markup':
    case 'xml':
      write(opts, serialize(parsed(es3dInput(bytes)), textOpts('xml', !opts.min)));
      break;
    case 'json':
      write(opts, serialize(parsed(es3dInput(bytes)), textOpts('json', opts.pretty)));
      break;
    case 'optimize': {
      const out = optimize(parsed(es3dInput(bytes)));
      for (const p of out.report) process.stderr.write(`${p.pass}: ${p.detail}\n`);
      write(opts, out.text);
      break;
    }
    case 'expand':
      write(opts, expandProcedural(parsed(es3dInput(bytes))));
      break;
    case 'obj': {
      const r = compiled(es3dInput(bytes));
      const name = opts.out ? path.basename(opts.out).replace(/\.obj$/i, '') : 'scene';
      const o = exportOBJ(r.scene, (e, l) => r.cache.mesh(e, l), { lod: opts.lod, name });
      write(opts, o.obj);
      if (opts.out) {
        const mtl = opts.out.replace(/\.obj$/i, '') + '.mtl';
        fs.writeFileSync(mtl, o.mtl);
        process.stderr.write(`wrote ${mtl}\n${o.vertices.toLocaleString('en-US')} vertices, ${o.triangles.toLocaleString('en-US')} triangles\n`);
      }
      break;
    }
    case 'glb': {
      let exportPackedGLB;
      try {
        ({ exportPackedGLB } = await import('../src/io/gltf-pack.js'));
      } catch (e) {
        fail(`glb could not load the packer (${e.message})`, 1);
      }
      const baseDir = opts.input === '-' ? '' : path.dirname(path.resolve(opts.input));
      const sourceName = opts.input === '-' ? 'stdin' : `${path.basename(path.dirname(opts.input))}/${path.basename(opts.input)}`;
      let file;
      try {
        file = await exportPackedGLB(es3dInput(bytes), { baseDir, sourceName });
      } catch (e) {
        fail(e.message, 1);
      }
      write(opts, file);
      break;
    }
    case 'stl': {
      const r = compiled(es3dInput(bytes));
      const name = opts.out ? path.basename(opts.out).replace(/\.stl$/i, '') : 'es3d';
      let out;
      try {
        out = exportSTL(r.scene, (e, l) => r.cache.mesh(e, Math.min(l, e.lods - 1)), { lod: opts.lod, binary: !opts.ascii, name });
      } catch (e) {
        fail(e.message, 1);
      }
      if (!opts.ascii && !opts.out) fail('binary STL needs -o <file> (or use --ascii)');
      write(opts, out.data);
      process.stderr.write(`${out.triangles.toLocaleString('en-US')} triangles\n`);
      break;
    }
    case 'step': {
      const r = compiled(es3dInput(bytes));
      const name = opts.out ? path.basename(opts.out).replace(/\.stp$/i, '').replace(/\.step$/i, '') : 'es3d';
      let out;
      try {
        out = exportSTEP(r.scene, (e, l) => r.cache.mesh(e, Math.min(l, e.lods - 1)), { lod: opts.lod, name });
      } catch (e) {
        fail(e.message, 1);
      }
      write(opts, out.data);
      process.stderr.write(`${out.triangles.toLocaleString('en-US')} triangles\n`);
      break;
    }
    case 'import': {
      const name = opts.input === '-' ? 'stdin' : path.basename(opts.input);
      const files = [{ name, bytes }];
      const kind = detectKind(name, bytes);
      if (kind === 'obj') {
        const text = new TextDecoder().decode(bytes);
        const mtl = mtlFor(opts.input, text);
        if (mtl) files.push({ name: ((/^mtllib\s+(.+?)\s*$/m.exec(text) || [])[1] || name.replace(/\.obj$/i, '.mtl')).split(/[\\/]/).pop(), bytes: new TextEncoder().encode(mtl) });
      }
      if (kind === 'gltf') files.push(...gltfCompanions(opts.input, bytes));
      const mesh = { ...opts.mesh };
      if (Number.isFinite(opts.precision)) mesh.precision = opts.precision;
      let r;
      try {
        r = await importFiles(files, { svg: opts.svg, mesh, stl: opts.stl });
      } catch (e) {
        fail(e.message, 1);
      }
      for (const n of r.notes) process.stderr.write(`${n}\n`);
      for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
      write(opts, r.text);
      break;
    }
    case 'stats':
      console.log(stats(es3dInput(bytes), opts));
      break;
    default:
      fail(`unknown command '${opts.cmd}' (try --help)`);
  }
}

main().catch((e) => fail(e.stack || e.message, 1));
