// Serializers, I/O formats and the optimizer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, formatDiagnostics } from '../src/format/parse.js';
import { serialize } from '../src/format/serializer.js';
import { compile } from '../src/pipeline.js';
import { exportOBJ, objToScene } from '../src/io/obj.js';
import { exportGLB, glbToScene } from '../src/io/gltf.js';
import { optimize, expandProcedural } from '../src/optimize/optimizer.js';

const examples = new URL('../docs/public/examples/', import.meta.url);
const exampleFiles = fs.readdirSync(examples).filter((f) => f.endsWith('.es3d') && !f.includes('error'));

/** Order-independent signature of the rendered scene. */
function signature(r) {
  const s = r.scene;
  const rows = [];
  for (let i = 0; i < s.count; i++) {
    const mesh = r.cache.mesh(s.geometries[s.geom[i]], 0);
    const m = Array.from(s.matrices.subarray(i * 16, i * 16 + 16), (v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4)).join(',');
    rows.push(`${mesh.vertexCount}/${mesh.indices.length}|${s.materials[s.mat[i]].key}|${m}`);
  }
  return rows.sort().join('\n');
}

test('every example round-trips through every text syntax', () => {
  for (const f of exampleFiles) {
    const text = fs.readFileSync(new URL(f, examples), 'utf8');
    const doc = parse(text);
    assert.ok(doc.ok, `${f}: ${formatDiagnostics(doc)}`);
    const reference = serialize(doc, { syntax: 'xml', pretty: false, aliases: false });
    const variants = {
      'xml-pretty': serialize(doc, { syntax: 'xml', pretty: true }),
      'xml-min': serialize(doc, { syntax: 'xml', pretty: false }),
      'compact-pretty': serialize(doc, { syntax: 'compact', pretty: true }),
      'compact-min': serialize(doc, { syntax: 'compact', pretty: false }),
      json: serialize(doc, { syntax: 'json', pretty: false }),
    };
    for (const [name, data] of Object.entries(variants)) {
      const d2 = parse(data);
      assert.ok(d2.ok, `${f} ${name}: ${formatDiagnostics(d2)}`);
      assert.equal(serialize(d2, { syntax: 'xml', pretty: false, aliases: false }), reference, `${f} ${name}`);
    }
  }
});

test('pretty markup output preserves comments and the original values', () => {
  const src = '<es3d version="1">\n  <!-- keep me -->\n  <box size="1.50" position="0, 1, 0"/>\n</es3d>\n';
  const out = serialize(parse(src), { pretty: true });
  assert.match(out, /<!-- keep me -->/);
  assert.match(out, /size="1.50"/);
  assert.match(out, /position="0, 1, 0"/);
});

test('quantization reduces precision on request only', () => {
  const doc = parse('<es3d version="1"><sphere radius="0.123456789" position="1.000001,2,3"/></es3d>');
  const q = serialize(doc, { pretty: false, precision: 3 });
  assert.match(q, /r="\.123"/);
  assert.match(q, /p="1,2,3"/);
});

test('mesh arrays keep their authored digits', () => {
  const src = '<es3d version="1"><mesh positions="0.12345 -1.3 2 1e-5 0.30001 7 0 0 0.1" indices="0 1 2"/></es3d>';
  const doc = parse(src);
  // float32 storage must not leak noise digits into the output
  assert.match(serialize(doc, { pretty: false }), /positions="\.12345 -1\.3 2 \.00001 \.30001 7 0 0 \.1"/);
  assert.ok(doc.root.children[0].values.positions instanceof Float32Array);
  assert.deepEqual(Array.from(doc.root.children[0].values.indices), [0, 1, 2]);
});

test('OBJ and GLB exports re-import with the same geometry', () => {
  const r = compile(fs.readFileSync(new URL('02-primitives.es3d', examples), 'utf8'));
  const meshOf = (e, l) => r.cache.mesh(e, l);
  const obj = exportOBJ(r.scene, meshOf);
  const o = objToScene(obj.obj, obj.mtl);
  assert.equal(o.parsed.stats.triangles, obj.triangles);
  for (const instancing of [false, true]) {
    const glb = exportGLB(r.scene, meshOf, { instancing });
    const g = glbToScene(glb);
    assert.equal(g.scene.count, r.scene.count, `instancing=${instancing}`);
    let t1 = 0, t2 = 0;
    for (let i = 0; i < r.scene.count; i++) {
      const m = r.cache.mesh(r.scene.geometries[r.scene.geom[i]], 0);
      if (m.kind === 'triangles') t1 += m.primitiveCount;
      const m2 = g.meshOf(g.scene.geometries[g.scene.geom[i]]);
      if (m2.kind === 'triangles') t2 += m2.primitiveCount;
    }
    assert.equal(t2, t1);
  }
});

test('quantized GLB (KHR_mesh_quantization) re-imports within int16 precision', () => {
  const r = compile(fs.readFileSync(new URL('05-gearbox.es3d', examples), 'utf8'));
  const meshOf = (e, l) => r.cache.mesh(e, l);
  const plain = exportGLB(r.scene, meshOf);
  const q = exportGLB(r.scene, meshOf, { quantize: true });
  assert.ok(q.length < plain.length * 0.75);
  const g = glbToScene(q);
  assert.deepEqual(g.json.extensionsRequired, ['KHR_mesh_quantization']);
  assert.equal(g.scene.count, r.scene.count);
  // world-space vertex positions agree to a fraction of the mesh size
  let worst = 0;
  const a = [0, 0, 0], b = [0, 0, 0];
  for (let i = 0; i < r.scene.count; i++) {
    const m0 = meshOf(r.scene.geometries[r.scene.geom[i]], 0);
    const m1 = g.meshOf(g.scene.geometries[g.scene.geom[i]]);
    if (m0.kind !== 'triangles') continue;
    const W0 = r.scene.matrices.subarray(i * 16, i * 16 + 16), W1 = g.scene.matrices.subarray(i * 16, i * 16 + 16);
    for (let v = 0; v < m0.vertexCount; v += 11) {
      const p = (W, m, out) => {
        const x = m.positions[v * 3], y = m.positions[v * 3 + 1], z = m.positions[v * 3 + 2];
        for (let k = 0; k < 3; k++) out[k] = W[k] * x + W[4 + k] * y + W[8 + k] * z + W[12 + k];
      };
      p(W0, m0, a);
      p(W1, m1, b);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  assert.ok(worst < 1e-3, `max position error ${worst}`);
});

function extensions(doc) {
  const out = [];
  const walk = (el) => {
    if (el.name.startsWith('x-')) {
      const attrs = el.attrs.map((a) => `${a.name}=${a.value.trim()}`).sort();
      out.push(`${el.parent.name}>${el.name} ${attrs.join(' ')}`);
    }
    for (const c of el.children) if (c.type === 'element') walk(c);
  };
  walk(doc.root);
  return out.sort();
}

test('extension elements round-trip in every syntax and the fallback still draws', () => {
  const src = `<es3d version="1.1">
    <defs><polygon id="tri" points="0,0 1,0 0,1"/></defs>
    <polygon points="0,0 1,0 0,1"><x-anchors nodes="a b c" inset="0.2"/></polygon>
    <line from="0,0,0" to="1,0,0"><x-anchors nodes="a b"/></line>
    <use ref="tri"><x-anchors nodes="a b c"/></use>
    <box><animate attr="position" to="1,0,0" dur="1s"><x-wave axis="x" amplitude="1" period="2" phase="0"/></animate></box>
  </es3d>`;
  const doc = parse(src);
  assert.ok(doc.ok, formatDiagnostics(doc));
  const reference = extensions(doc);
  assert.deepEqual(reference, [
    'animate>x-wave amplitude=1 axis=x period=2 phase=0',
    'line>x-anchors nodes=a b',
    'polygon>x-anchors inset=0.2 nodes=a b c',
    'use>x-anchors nodes=a b c',
  ]);
  for (const syntax of ['xml', 'compact', 'json']) {
    const again = parse(serialize(doc, { syntax, pretty: true }));
    assert.ok(again.ok, `${syntax}: ${formatDiagnostics(again)}`);
    assert.equal(again.root.values.version, '1.1', syntax);
    assert.deepEqual(extensions(again), reference, syntax);
  }
  const drawn = compile(src);
  assert.ok(drawn.ok, formatDiagnostics(drawn));
  assert.equal(drawn.scene.count, 4);
});

test('the optimizer keeps extension elements and the ids they name', () => {
  const src = `<es3d version="1.1">
    <material id="paint" color="#112233"/>
    <material id="same" color="#112233"/>
    <defs>
      <group id="keep"/>
      <group id="drop"/>
      <polygon id="tri" points="0,0 1,0 0,1"/>
    </defs>
    <polygon points="0,0 1,0 0,1"><x-anchors nodes="keep drop-not"/></polygon>
    <line from="0,0,0" to="1,0,0"><x-anchors nodes="#keep b"/></line>
    <use ref="tri"><x-note tint="same"/></use>
    <box>
      <animate attr="position" to="1,0,0" dur="1s"><x-pulses axis="y" every="2"/></animate>
    </box>
  </es3d>`;
  const doc = parse(src);
  assert.ok(doc.ok, formatDiagnostics(doc));
  const before = compile(src);
  const out = optimize(doc);
  assert.match(out.text, /<x-anchors\b[^>]*nodes="keep drop-not"/);
  assert.match(out.text, /<x-anchors\b[^>]*nodes="#keep b"/);
  assert.match(out.text, /id="keep"/);
  assert.match(out.text, /id="paint"/);
  assert.match(out.text, /<x-pulses\b/);
  assert.match(out.text, /tint="paint"/);
  assert.doesNotMatch(out.text, /id="drop"/);
  assert.doesNotMatch(out.text, /id="same"/);
  const after = compile(out.text);
  assert.ok(after.ok, formatDiagnostics(after));
  assert.equal(signature(after), signature(before));
});

test('the optimizer preserves the rendered scene', () => {
  for (const f of ['02-primitives.es3d', '05-gearbox.es3d', '07-staircases.es3d', '09-compact-syntax.es3d']) {
    const r0 = compile(fs.readFileSync(new URL(f, examples), 'utf8'));
    const out = optimize(r0.doc);
    const r1 = compile(out.text);
    assert.ok(r1.ok, f);
    assert.equal(signature(r1), signature(r0), f);
  }
});

test('the optimizer finds repeated parts and linear patterns', () => {
  const src = `<es3d version="1">
    <box position="0,0,0" size="1,2,3" color="#123456"/><box position="2,0,0" size="1,2,3" color="#123456"/>
    <box position="4,0,0" size="1,2,3" color="#123456"/><box position="6,0,0" size="1,2,3" color="#123456"/>
    <group position="0,5,0"><sphere radius="0.4"/><cylinder radius="0.1" height="2" position="0,1,0"/></group>
    <group position="9,5,1" rotation="0,40,0"><sphere radius="0.4"/><cylinder radius="0.1" height="2" position="0,1,0"/></group>
  </es3d>`;
  const r0 = compile(src);
  const out = optimize(r0.doc);
  const passes = out.report.map((p) => p.pass);
  assert.ok(passes.includes('detectPatterns'));
  assert.ok(passes.includes('extractRepeated'));
  assert.match(out.text, /<repeat count="4" step="translate\(2,0,0\)">/);
  assert.equal(signature(compile(out.text)), signature(r0));
});

test('procedural expansion is equivalent and much larger', () => {
  const r0 = compile(fs.readFileSync(new URL('04-forest.es3d', examples), 'utf8'));
  const expanded = expandProcedural(r0.doc);
  const r1 = compile(expanded);
  assert.ok(r1.ok);
  assert.equal(r1.scene.count, r0.scene.count);
  // expansion keeps the traversal order; positions are written with 6 decimals
  for (let i = 0; i < r0.scene.count; i++) {
    assert.equal(r1.scene.materials[r1.scene.mat[i]].key, r0.scene.materials[r0.scene.mat[i]].key);
    assert.equal(r1.scene.geometries[r1.scene.geom[i]].key, r0.scene.geometries[r0.scene.geom[i]].key);
    for (let k = 0; k < 16; k++) {
      assert.ok(Math.abs(r1.scene.matrices[i * 16 + k] - r0.scene.matrices[i * 16 + k]) < 1e-4, `instance ${i}`);
    }
  }
  assert.ok(expanded.length > 50 * r0.doc.source.length);
});
