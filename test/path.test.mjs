// Path data, flattening, fill rules and triangulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePathData, PathError } from '../src/path/path-parser.js';
import { flattenPath, signedArea, arcToCenter } from '../src/path/path-flatten.js';
import { buildRegions, triangulateRegion } from '../src/path/shapes.js';
import { triangulate, triangulationError } from '../src/path/triangulate.js';
import { formatPathData } from '../src/format/value-format.js';

test('parses every SVG path command, relative forms and implicit repetition', () => {
  const p = parsePathData('M10-5l5,5h10v10C1,2 3,4 5,6s1 1 2 2Q0 0 1 1t2 2a1,1 0 00 1,1z m1 1 2 2');
  // "m1 1 2 2" is a moveto followed by one implicit lineto
  assert.deepEqual(p.segments.map((s) => s.c).join(''), 'MLLLCCQQAZML');
  const l = p.segments[1];
  assert.deepEqual([l.x, l.y], [15, 0]);
  assert.equal(p.segments[2].x, 25);
  const s = p.segments[5];
  // S reflects the previous control point (3,4) about (5,6) -> (7,8)
  assert.deepEqual([s.x1, s.y1], [7, 8]);
});

test('path errors carry offsets', () => {
  for (const [src, off] of [['L1,1', 0], ['M1', 1], ['M1,1 X', 5], ['M1 1 A1 1 0 2 0 3 3', 12]]) {
    try {
      parsePathData(src);
      assert.fail('expected an error for ' + src);
    } catch (e) {
      assert.ok(e instanceof PathError);
      assert.equal(e.offset, off, src);
    }
  }
});

test('3D path data and rejection of 2D-only commands', () => {
  const p = parsePathData('M0,0,0 L1,2,3 C1,0,0 1,1,0 1,1,1', 3);
  assert.equal(p.segments[1].z, 3);
  assert.throws(() => parsePathData('M0,0,0 H1', 3), /not available in 3D/);
});

test('flattening: tolerance controls segment counts and corners are detected', () => {
  const segs = parsePathData('M0,0 L10,0 A5,5 0 0,1 10,10 L0,10 Z').segments;
  const fine = flattenPath(segs, { tolerance: 0.001 })[0];
  const coarse = flattenPath(segs, { tolerance: 0.5 })[0];
  assert.ok(fine.points.length > coarse.points.length);
  assert.ok(fine.closed);
  // (0,0) and (0,10) are corners; the arc joins the lines tangentially
  assert.equal(fine.smooth[0], 0);
  const iArcStart = 1;
  assert.equal(fine.smooth[iArcStart], 1);
});

test('arc center parameterization matches the SVG reference', () => {
  const a = arcToCenter(0, 0, 5, 5, 0, 0, 1, 10, 0);
  assert.ok(Math.abs(a.cx - 5) < 1e-9 && Math.abs(a.cy) < 1e-9);
  assert.ok(Math.abs(Math.abs(a.dtheta) - Math.PI) < 1e-9);
});

test('fill rules: evenodd vs nonzero holes', () => {
  const d = 'M0,0 L10,0 L10,10 L0,10 Z M2,2 L8,2 L8,8 L2,8 Z';
  const c = flattenPath(parsePathData(d).segments, { tolerance: 0.1 });
  const eo = buildRegions(c, 'evenodd');
  assert.equal(eo.regions.length, 1);
  assert.equal(eo.regions[0].holes.length, 1);
  const nz = buildRegions(c, 'nonzero');
  // same orientation: the inner contour is filled under nonzero
  assert.equal(nz.regions.length, 2);
  assert.equal(nz.walls.length, 1);
  const reversed = flattenPath(parsePathData('M0,0 L10,0 L10,10 L0,10 Z M2,2 L2,8 L8,8 L8,2 Z').segments, { tolerance: 0.1 });
  assert.equal(buildRegions(reversed, 'nonzero').regions[0].holes.length, 1);
});

test('triangulation covers the polygon area exactly and is counter-clockwise', () => {
  const sq = [0, 0, 1, 0, 1, 1, 0, 1];
  const t = triangulate(sq);
  assert.equal(t.length, 6);
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 2, t[i + 1] * 2, t[i + 2] * 2];
    const cross = (sq[b] - sq[a]) * (sq[c + 1] - sq[a + 1]) - (sq[b + 1] - sq[a + 1]) * (sq[c] - sq[a]);
    assert.ok(cross > 0);
  }
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 200; k++) {
    const n = 3 + Math.floor(rnd() * 50);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const r = 5 + rnd() * 10;
      pts.push(Math.cos(ang) * r, Math.sin(ang) * r);
    }
    const hole = [];
    for (let i = 0; i < 6; i++) {
      const ang = (-i / 6) * Math.PI * 2;
      hole.push(Math.cos(ang) * 2, Math.sin(ang) * 2);
    }
    const data = [...pts, ...hole];
    const tri = triangulate(data, [n]);
    assert.ok(triangulationError(data, [n], tri) < 1e-9, `polygon ${k}`);
  }
});

test('self-intersecting input is detected by the area check', () => {
  const bow = [0, 0, 10, 10, 10, 0, 0, 10];
  const r = triangulateRegion({ outer: { points: Float64Array.from(bow), smooth: new Uint8Array(4) }, holes: [] });
  assert.ok(r.error > 0.01);
});

test('signed area sign convention', () => {
  assert.ok(signedArea([0, 0, 1, 0, 1, 1, 0, 1]) > 0);
  assert.ok(signedArea([0, 0, 0, 1, 1, 1, 1, 0]) < 0);
});

test('path minifier output re-parses to the same geometry', () => {
  const src = 'M 10 10 L 20 10 L 20 20 C 25 25 30 25 35 20 S 45 15 50 20 Q 55 30 60 20 T 70 20 A 5 5 0 0 1 80 20 Z M 0 0 L 1 1';
  const a = parsePathData(src).segments;
  const min = formatPathData(a, { minify: true });
  assert.ok(min.length < src.length);
  const b = parsePathData(min).segments;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
      if (a[i][k] !== undefined) assert.ok(Math.abs(a[i][k] - b[i][k]) < 1e-9, `${i}.${k}: ${min}`);
    }
  }
});
