// The shifting-mesh background written as a proposed ES3D 1.1 document, and the
// reference maths for the three proposed elements. Writes shifting-mesh-1.1.es3d.
//
//   <x-wave   axis amplitude period phase>                  adds a sine to its parent's position
//   <x-pulses axis every depth duration signed seed>        adds sporadic smooth pushes
//   <x-anchors nodes="a b c" inset>                         puts a triangle's corners on three nodes
//
// A 1.0 reader skips all three (W_EXTENSION) and draws each facet's own transform: the
// first frame, still. A 1.1 reader moves the nodes and re-places the facets every frame.

import { writeFileSync } from 'node:fs';
import { createMeshSheet, DEFAULTS } from './triangle-mesh.js';

// --- reference semantics (what a 1.1 reader computes) ------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** <x-wave>: amplitude · sin(360° · t / period + phase). (A reader uses es3dSin, as <scatter> does.) */
export const wave = (w, t) => w.amplitude * Math.sin((2 * Math.PI * t) / w.period + (w.phase * Math.PI) / 180);

/**
 * <x-pulses>: time is cut into slots of `every` seconds. Slot k draws five numbers from
 * mulberry32(seed XOR k·0x9E3779B1): start = (k + u0)·every, duration and depth from their
 * ranges (u1, u2), sign from u3 when signed, u4 reserved. A pulse rises and falls as
 * ½(1 − cos 2πs) over its duration. Any time can be evaluated directly (no history needed),
 * so seeking, scrubbing and scroll timelines work, and every reader gets the same motion.
 */
export function pulses(p, t) {
  let z = 0;
  const first = Math.floor((t - p.duration[1]) / p.every) - 1;
  const last = Math.floor(t / p.every);
  for (let k = first; k <= last; k++) {
    const r = mulberry32((p.seed ^ Math.imul(k, 0x9e3779b1)) >>> 0);
    const u = [r(), r(), r(), r(), r()];
    const start = (k + u[0]) * p.every;
    const dur = p.duration[0] + (p.duration[1] - p.duration[0]) * u[1];
    const s = (t - start) / dur;
    if (s <= 0 || s >= 1) continue;
    const depth = (p.depth[0] + (p.depth[1] - p.depth[0]) * u[2]) * (p.signed && u[3] < 0.5 ? -1 : 1);
    z += depth * 0.5 * (1 - Math.cos(2 * Math.PI * s));
  }
  return z;
}

/** <x-anchors> on a triangle: the matrix taking its points p0 p1 p2 to the anchors A B C, shrunk by inset. */
export function anchorMatrix(A, B, C, inset = 0) {
  const k = 1 - inset;
  const g = [0, 1, 2].map((i) => (A[i] + B[i] + C[i]) / 3);
  const u = [0, 1, 2].map((i) => k * (B[i] - A[i]));
  const v = [0, 1, 2].map((i) => k * (C[i] - A[i]));
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  const o = [0, 1, 2].map((i) => g[i] + k * (A[i] - g[i]));
  // reference triangle (0,0) (1,0) (0,1); a general one multiplies by the inverse of its own frame
  return [...u, 0, ...v, 0, n[0] / l, n[1] / l, n[2] / l, 0, ...o, 1];
}

// --- the document --------------------------------------------------------------------------

const o = { ...DEFAULTS };
const sheet = createMeshSheet(o); // same lattice, camera, lights and look as the JavaScript version
const { X, Y, corners } = sheet._state;
const n = X.length;
const rnd = mulberry32(o.seed + 101);
const TAU = Math.PI * 2;
const num = (x, d = 3) => {
  const s = (Math.round(x * 10 ** d) / 10 ** d).toFixed(d).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

// two swells crossing the sheet: one <x-wave> each, phase from the node's position
const swells = [0, 1].map(() => {
  const dir = rnd() * TAU;
  return { dx: Math.cos(dir), dy: Math.sin(dir), period: o.swellPeriod[0] + (o.swellPeriod[1] - o.swellPeriod[0]) * rnd(), p: rnd() * 360 };
});
const nodes = [];
for (let i = 0; i < n; i++) {
  nodes.push({
    base: (rnd() - 0.5) * 0.12,
    waves: swells.map((s) => ({ amplitude: o.swell, period: s.period, phase: (s.p + (X[i] * s.dx + Y[i] * s.dy) * 40.5) % 360 })),
    pulses: { every: o.pushEvery, depth: o.pushDepth, duration: o.pushTime, signed: true, seed: (o.seed * 7919 + i) >>> 0 },
  });
}
const depthAt = (i, t) => nodes[i].base + nodes[i].waves.reduce((z, w) => z + wave(w, t), 0) + pulses(nodes[i].pulses, t);

// first frame, for the facets' fallback transforms (1.0 readers show exactly this)
const T0 = 0;
const P = (i) => [X[i], Y[i], depthAt(i, T0)];

const L = [];
L.push('<es3d version="1.1" name="Shifting triangular mesh">');
L.push('  <title>Shifting triangular mesh</title>');
L.push('  <desc>ES3D 1.1: nodes move with x-wave and x-pulses, facets follow them with x-anchors. ES3D 1.0 readers skip those and show this first frame.</desc>');
L.push(`  <environment background="${o.background}" sky="#33427a" ground="#04060d" intensity="0.18" exposure="1"/>`);
L.push('  <controls mode="none"/>');
L.push('  <camera position="0,0,9" target="0,0,0" fov="40" aspect="1.778" fit="cover"/>');
L.push(`  <light type="directional" direction="${o.lightDirection.join(',')}" color="${o.light}" intensity="${o.lightIntensity}"/>`);
L.push(`  <light type="directional" direction="-0.3,0.6,-0.5" color="${o.fill}" intensity="${o.fillIntensity}"/>`);
L.push(`  <material id="facet" color="${o.facet}" roughness="${o.roughness}" metallic="0"/>`);
L.push('  <defs><polygon id="tri" points="0,0 1,0 0,1" material="facet"/></defs>');
L.push(`  <group name="sheet" rotation="${o.tilt},0,0">`);
for (let i = 0; i < n; i++) {
  const nd = nodes[i];
  L.push(`    <group id="n${i}" position="${num(X[i])},${num(Y[i])},${num(nd.base)}">`);
  for (const w of nd.waves) L.push(`      <x-wave axis="0,0,1" amplitude="${num(w.amplitude)}" period="${num(w.period, 2)}s" phase="${num(w.phase, 1)}"/>`);
  const p = nd.pulses;
  L.push(`      <x-pulses axis="0,0,1" every="${p.every}s" depth="${p.depth[0]}..${p.depth[1]}" duration="${p.duration[0]}s..${p.duration[1]}s" signed="true" seed="${p.seed}"/>`);
  L.push('    </group>');
}
for (let f = 0; f < sheet.facets; f++) {
  const [a, b, c] = [corners[f * 3], corners[f * 3 + 1], corners[f * 3 + 2]];
  const m = anchorMatrix(P(a), P(b), P(c), o.gap);
  L.push(`    <use ref="tri" transform="matrix(${m.map((v) => num(v, 4)).join(',')})"><x-anchors nodes="n${a} n${b} n${c}" inset="${o.gap}"/></use>`);
}
L.push('  </group>');
L.push('</es3d>');
const source = L.join('\n');
writeFileSync('shifting-mesh-1.1.es3d', source);

// how a 1.0 reader takes it
const { compile } = await import('@es3d/es3d');
const { gzipSync } = await import('node:zlib');
const t0 = performance.now();
const r = compile(source);
const ms = performance.now() - t0;
const codes = {};
for (const d of r.diagnostics) codes[d.code] = (codes[d.code] || 0) + 1;
console.log(`1.1 document: ${source.length} bytes, ${gzipSync(source).length} gzipped, ${n} nodes, ${sheet.facets} facets`);
console.log(`ES3D 1.0.1 reader: ok=${r.ok}, ${r.scene.count} instances drawn, ${ms.toFixed(0)} ms, diagnostics ${JSON.stringify(codes)}`);
// the reference maths is seekable: evaluating out of order gives the same answer
const a1 = pulses(nodes[5].pulses, 123.4), a2 = (pulses(nodes[5].pulses, 10), pulses(nodes[5].pulses, 123.4));
console.log('pulses seekable:', a1 === a2, '| sample depths at t=0,5,10 s:', [0, 5, 10].map((t) => depthAt(5, t).toFixed(3)).join(', '));
