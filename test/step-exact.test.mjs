// STEP solids from a CAD kernel become ES3D shapes. The fixtures were made
// with OpenCascade (fixtures/step/make.py), and expected.json holds that
// kernel's exact bounds and surface area of each part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/pipeline.js';
import { stepToExact } from '../src/io/step-exact.js';
import { importFiles } from '../src/io/convert.js';

const dir = fileURLToPath(new URL('./fixtures/step/', import.meta.url));
const expected = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8'));
const read = (name) => readFileSync(`${dir}${name}`);

/** Bounds and area of the triangles the document draws. */
function measure(c) {
  const sc = c.scene;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let area = 0;
  for (let i = 0; i < sc.count; i++) {
    const m = sc.matrices.subarray(i * 16, i * 16 + 16);
    const mesh = c.cache.mesh(sc.geometries[sc.geom[i]], 0);
    const P = (k) => {
      const x = mesh.positions[k * 3], y = mesh.positions[k * 3 + 1], z = mesh.positions[k * 3 + 2];
      return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    };
    for (let k = 0; k < mesh.positions.length / 3; k++) {
      const w = P(k);
      for (let j = 0; j < 3; j++) {
        min[j] = Math.min(min[j], w[j]);
        max[j] = Math.max(max[j], w[j]);
      }
    }
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const p = P(mesh.indices[k]), q = P(mesh.indices[k + 1]), r = P(mesh.indices[k + 2]);
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
  }
  return { min, max, area };
}

// what each part becomes: the elements it is written with
const SHAPES = {
  'sphere.step': { sphere: 1 },
  'torus.step': { torus: 1 },
  'cone.step': { cylinder: 1 },
  'shaft.step': { revolve: 1 },
  'ellipse.step': { extrude: 1 },
  'bracket.step': { path: 8, revolve: 2 },
  'plate.step': { path: 11, revolve: 14 },
  'rounded_box.step': { path: 6, revolve: 20 },
  'cross_holes.step': { path: 2, mesh: 1 },
  'loft.step': { path: 2, mesh: 1 },
};

for (const [name, e] of Object.entries(expected)) {
  test(`${name}: the same solid as the CAD kernel's, written as ES3D shapes`, () => {
    const r = stepToExact(read(name), { name });
    const c = compile(r.text);
    assert.ok(c.ok, c.diagnostics.map((d) => d.message).join('\n'));
    assert.deepEqual(c.diagnostics, []);
    const counts = {};
    for (const m of r.text.matchAll(/<(sphere|torus|cylinder|cone|box|revolve|extrude|path|mesh)\b/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    assert.deepEqual(counts, SHAPES[name]);
    // the file is Z-up and in millimetres; a group turns it Y-up and every number stays the CAD tool's
    assert.match(r.text, /<es3d version="1" unit="mm">/);
    assert.match(r.text, /<group name="z-up" rotation="-90,0,0">/);
    const got = measure(c);
    const min = [e.min[0], e.min[2], -e.max[1]];
    const max = [e.max[0], e.max[2], -e.min[1]];
    const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(got.min[k] - min[k]) < size * 1e-6 && Math.abs(got.max[k] - max[k]) < size * 1e-6, `${name}: bounds ${got.min} .. ${got.max}, expected ${min} .. ${max}`);
    }
    // tessellating curved faces loses a little area, never more
    assert.ok(Math.abs(got.area - e.area) < e.area * 5e-3, `${name}: area ${got.area}, expected ${e.area}`);
    assert.equal(r.stats.faces, e.faces);
    if (counts.mesh) assert.match(r.note, /tessellated from the exact surface/);
    else assert.match(r.note, /nothing is a mesh/);
  });
}

test('exact edges: elliptical arcs, circular arcs, and splines written as circles', () => {
  // the elliptical prism keeps its ellipse as two half arcs
  const ellipse = stepToExact(read('ellipse.step'), { name: 'ellipse.step' }).text;
  assert.match(ellipse, /d="M[^"]*A20,10 0 0,[01] [^"]*A20,10 0 0,[01] [^"]*Z"/);
  // a part the kernel calls COMPOUND takes the file's name
  assert.match(ellipse, /<title>ellipse<\/title>/);
  // the plate's holes and corners are arcs; OpenCascade wrote some of them as rational splines
  const plate = stepToExact(read('plate.step')).text;
  assert.match(plate, /A3,3 0 0,[01] /);
  assert.match(plate, /fillRule="evenodd"/);
  // a full turn of the sphere and of the torus is one element
  assert.match(stepToExact(read('sphere.step')).text, /<sphere radius="10"\/>/);
  assert.match(stepToExact(read('torus.step')).text, /<torus [^>]*radius="20" tube="5"\/>/);
  // the frustum is a cylinder with a top radius
  assert.match(stepToExact(read('cone.step')).text, /<cylinder [^>]*radius="10" radiusTop="4" height="20"\/>/);
});

test('the converter uses the exact path for STEP, and says what it did', async () => {
  const r = await importFiles([{ name: 'rounded_box.step', bytes: new Uint8Array(read('rounded_box.step')) }]);
  assert.doesNotMatch(r.text, /<mesh/);
  assert.match(r.notes.join('\n'), /STEP B-rep: 6 flat faces, 20 revolves\. All 26 faces are ES3D shapes; nothing is a mesh\. Coordinates are in millimetres/);
  const loft = await importFiles([{ name: 'loft.step', bytes: new Uint8Array(read('loft.step')) }]);
  assert.match(loft.notes.join('\n'), /2 of 7 faces are ES3D shapes; 5 faces are free-form or cross-cut surfaces ES3D cannot describe/);
});

test("the Parcel demo is the STEP converter's output, kept up to date", async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/make-parcel.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const parts = readFileSync(fileURLToPath(new URL('../docs/demo/parcel/models/parcel.es3d', import.meta.url)), 'utf8');
  assert.doesNotMatch(parts, /<mesh/);
  const c = compile(parts);
  assert.ok(c.ok);
  assert.deepEqual(c.diagnostics, []);
});
