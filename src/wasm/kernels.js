// WebAssembly versions of the reader's hottest loops: number lists, normals,
// sweeps, extrusions, triangulation, primitives and the instance rows of
// <repeat> and <scatter>. They are built from wasm/ by `npm run wasm` and
// compute exactly what the JavaScript versions compute (the same IEEE
// operations in the same order; sin, cos, atan2 and hypot come from this
// page's Math). Where WebAssembly is missing or blocked, for example by a
// content security policy without 'wasm-unsafe-eval', every caller keeps
// using its JavaScript version.

import BINARY, { INSTANCES } from './kernels-binary.js';

let text = ''; // the number list being read, for the rare numbers the kernel hands back to Number()
let material = null; // resolves an instance row's material code (see instancesWasm)

const imports = {
  env: {
    sin: Math.sin,
    cos: Math.cos,
    atan2: Math.atan2,
    tan: Math.tan,
    acos: Math.acos,
    hypot2: Math.hypot,
    hypot3: Math.hypot,
    number: (start, end) => Number(text.slice(start, end)),
    material: (code) => material(code),
  },
};

function decode(base64) {
  // native decoders where there is one (newer browsers, Node); a loop otherwise
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
  if (typeof Buffer === 'function') return Buffer.from(base64, 'base64');
  const s = atob(base64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function instantiate(base64) {
  try {
    if (typeof WebAssembly !== 'object') return null;
    const { instance } = await WebAssembly.instantiate(decode(base64), imports);
    return instance.exports;
  } catch {
    return null;
  }
}

// the instance kernel is a module of its own: it needs WebAssembly SIMD
const [wasm, simd] = await Promise.all([instantiate(BINARY), instantiate(INSTANCES)]);
let enabled = wasm !== null;

/**
 * Whether the module's hypot (V8's algorithm) gives this engine's Math.hypot
 * results. The special cases (infinities, NaN, zeros) are fixed by the
 * language; the rounding of finite values is the engine's, so values over
 * many magnitudes are compared. Where they differ the kernels keep calling
 * Math.hypot, which is slower (every call leaves WebAssembly and allocates).
 */
function hypotMatches() {
  const edge = [0, -0, 3, -4, 5e-324, 1e308, Infinity, NaN];
  for (const x of edge) for (const y of edge) if (!Object.is(wasm.hypot2(x, y), Math.hypot(x, y))) return false;
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed / 4294967296 - 0.5) * 10 ** ((seed % 41) - 20);
  };
  for (let i = 0; i < 100; i++) {
    const x = next(), y = next(), z = next();
    if (!Object.is(wasm.hypot3(x, y, z), Math.hypot(x, y, z)) || !Object.is(wasm.hypot2(x, y), Math.hypot(x, y))) return false;
  }
  return true;
}
if (wasm) wasm.set_native_hypot(hypotMatches() ? 1 : 0);

/** Whether the kernels are in use. */
export function wasmEnabled() {
  return enabled;
}

/** Whether the instance kernel is in use (it needs WebAssembly SIMD as well). */
export function instanceKernelEnabled() {
  return enabled && simd !== null;
}

/** Turn the kernels off (or back on, when they loaded) to compare with the JavaScript versions. */
export function setWasmEnabled(on) {
  enabled = Boolean(on) && wasm !== null;
}

const heap = () => wasm.memory.buffer;

/** Copy a typed array into a module's memory; returns its address (0 when memory ran out). */
function put(a, module = wasm) {
  const p = module.alloc(Math.max(1, a.byteLength));
  if (p) new Uint8Array(module.memory.buffer, p, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return p;
}

const encoder = new TextEncoder();
const AS = { f64: [0, Float64Array], f32: [1, Float32Array], index: [2, Uint32Array] };

/**
 * A number list read into a typed array (`as`: 'f64', 'f32' or 'index'), or
 * null when the JavaScript reader must handle it (the kernels are off, the
 * text is not ASCII, or it has an error, which JavaScript then reports).
 */
export function readNumbersWasm(raw, as) {
  if (!enabled) return null;
  const [kind, Type] = AS[as];
  const n = raw.length;
  wasm.reset();
  const sp = wasm.alloc(Math.max(1, n));
  const op = sp && wasm.alloc((Math.floor(n / 2) + 1) * Type.BYTES_PER_ELEMENT);
  if (!op) return null;
  const r = encoder.encodeInto(raw, new Uint8Array(heap(), sp, n));
  if (r.read !== n || r.written !== n) return null;
  text = raw;
  const count = wasm.numbers(sp, n, op, kind);
  text = '';
  if (count < 0) return null;
  return new Type(heap(), op, count).slice();
}

/**
 * computeNormals for Float32Array positions and uvs and Uint32Array indices,
 * as {positions, normals, uvs, indices}, or null to use the JavaScript version.
 */
export function computeNormalsWasm(positions, indices, crease, cosCrease, uvs) {
  if (!enabled || !(positions instanceof Float32Array) || !(indices instanceof Uint32Array) || (uvs && !(uvs instanceof Float32Array))) return null;
  wasm.reset();
  const pp = put(positions), ip = put(indices), tp = uvs ? put(uvs) : 0;
  if (!pp || !ip || (uvs && !tp)) return null;
  const res = wasm.normals(pp, positions.length / 3, ip, indices.length, tp, crease, cosCrease);
  if (!res) return null;
  const [vc, ic, p, nrm, t, i] = new Uint32Array(heap(), res, 6);
  return {
    positions: new Float32Array(heap(), p, vc * 3).slice(),
    normals: new Float32Array(heap(), nrm, vc * 3).slice(),
    uvs: new Float32Array(heap(), t, vc * 2).slice(),
    indices: new Uint32Array(heap(), i, ic).slice(),
  };
}

const f64 = (a) => (a instanceof Float64Array ? a : Float64Array.from(a));
const u32 = (a) => (a instanceof Uint32Array ? a : Uint32Array.from(a));
const u8 = (a) => (a instanceof Uint8Array ? a : Uint8Array.from(a));

/**
 * Writes contours ({points, smooth, isWall}) as {n, points, smooth, isWall}
 * records; returns the table's address, or 0 when memory ran out.
 */
function contourTable(list) {
  const rows = new Int32Array(list.length * 4);
  for (let k = 0; k < list.length; k++) {
    const c = list[k];
    const p = put(f64(c.points));
    const sm = c.smooth ? put(u8(c.smooth)) : 0;
    if (!p || (c.smooth && !sm)) return 0;
    rows[k * 4] = c.points.length / 2;
    rows[k * 4 + 1] = p;
    rows[k * 4 + 2] = sm;
    rows[k * 4 + 3] = c.isWall === false ? 0 : 1;
  }
  return put(rows);
}

/** {first contour, contour count} per region, appending each region's contours to `list`. */
function regionRows(regions, list) {
  const rows = new Int32Array(Math.max(1, regions.length * 2));
  regions.forEach((r, k) => {
    rows[k * 2] = list.length;
    rows[k * 2 + 1] = 1 + r.holes.length;
    list.push(r.outer, ...r.holes);
  });
  return rows;
}

/** A kernel's mesh, copied out of kernel memory into one buffer (one allocation instead of four). */
const meshOut = (res, extra) => {
  const [vc, ic, p, nrm, t, i] = new Uint32Array(heap(), res, 6);
  const out = new ArrayBuffer((vc * 8 + ic) * 4);
  const positions = new Float32Array(out, 0, vc * 3);
  const normals = new Float32Array(out, vc * 12, vc * 3);
  const uvs = new Float32Array(out, vc * 24, vc * 2);
  const indices = new Uint32Array(out, vc * 32, ic);
  positions.set(new Float32Array(heap(), p, vc * 3));
  normals.set(new Float32Array(heap(), nrm, vc * 3));
  uvs.set(new Float32Array(heap(), t, vc * 2));
  indices.set(new Uint32Array(heap(), i, ic));
  return { positions, normals, uvs, indices, ...extra };
};

/**
 * sweepMesh after its profile is known: spines [{points, closed}], the
 * profile contours, the circle's points (circle profiles) or the regions to
 * cap (shaped profiles). Returns {positions, normals, uvs, indices, open,
 * degenerate: one flag per spine, errors: triangulation error per cap
 * region}, or null to use the JavaScript version.
 */
export function sweepWasm(spines, contours, circle, regions, twist, taper, caps) {
  if (!enabled) return null;
  wasm.reset();
  const list = [...contours];
  const regionTab = circle ? null : regionRows(regions, list);
  const table = contourTable(list);
  const spineRows = new Int32Array(Math.max(1, spines.length * 3));
  for (let k = 0; k < spines.length; k++) {
    spineRows[k * 3] = put(f64(spines[k].points));
    spineRows[k * 3 + 1] = spines[k].points.length / 3;
    spineRows[k * 3 + 2] = spines[k].closed ? 1 : 0;
    if (!spineRows[k * 3]) return null;
  }
  const profile = put(Int32Array.from(contours, (_, k) => k));
  const spineTab = put(spineRows);
  const capData = circle ? put(f64(circle)) : put(regionTab);
  const header = put(
    Int32Array.of(spines.length, spineTab, list.length, table, contours.length, profile, circle ? 1 : 2, circle ? circle.length / 2 : regions.length, capData, caps ? 1 : 0),
  );
  if (!table || !profile || !spineTab || !capData || !header) return null;
  const res = wasm.sweep(header, twist, taper);
  if (!res) return null;
  const [open, deg, errs] = new Uint32Array(heap(), res + 24, 3);
  return meshOut(res, {
    open: open !== 0,
    degenerate: Array.from(new Uint8Array(heap(), deg, spines.length), (d) => d !== 0),
    errors: circle ? [] : Array.from(new Float64Array(heap(), errs, regions.length)),
  });
}

/**
 * triangulate(data, holeIndices) as an array of vertex indices, or null to
 * use the JavaScript version (also when two holes tie for the sort order).
 */
export function triangulateWasm(data, holeIndices) {
  if (!enabled) return null;
  wasm.reset();
  const dp = put(f64(data));
  const holes = holeIndices && holeIndices.length ? Int32Array.from(holeIndices) : null;
  const hp = holes ? put(holes) : 0;
  if (!dp || (holes && !hp)) return null;
  let res;
  try {
    res = wasm.triangulate(dp, data.length, hp, holes ? holes.length : 0);
  } catch {
    return null; // stack exhausted on pathological input: JavaScript has a deeper stack
  }
  if (!res) return null;
  const [count, p] = new Uint32Array(heap(), res, 2);
  return count ? Array.from(new Uint32Array(heap(), p, count)) : [];
}

/**
 * extrudeMesh from a shape ({regions, walls}) with the bevel profile rings
 * {inset, z, nr, nz} and bounds from JavaScript. Returns {positions,
 * normals, uvs, indices, errors: triangulation error per region}, or null
 * to use the JavaScript version.
 */
export function extrudeWasm(shape, bevel, rings, z0, zTop, minX, minY, S) {
  if (!enabled) return null;
  wasm.reset();
  const list = [];
  const regionTab = put(regionRows(shape.regions, list));
  const walls = put(Int32Array.from(shape.walls, (_, k) => list.length + k));
  list.push(...shape.walls);
  const table = contourTable(list);
  const ringData = new Float64Array(Math.max(1, rings.length * 4));
  rings.forEach((r, k) => ringData.set([r.inset, r.z, r.nr, r.nz], k * 4));
  const ringPtr = put(ringData);
  const header = put(Int32Array.of(list.length, table, shape.regions.length, regionTab, shape.walls.length, walls, rings.length, ringPtr));
  if (!regionTab || !walls || !table || !ringPtr || !header) return null;
  const res = wasm.extrude(header, bevel, z0, zTop, minX, minY, S);
  if (!res) return null;
  const errs = new Uint32Array(heap(), res + 24, 1)[0];
  return meshOut(res, { errors: Array.from(new Float64Array(heap(), errs, shape.regions.length)) });
}

/** measureSphereDeviation(w) for w >= 3, or null to use the JavaScript version. */
export function sphereDeviationWasm(w) {
  if (!enabled) return null;
  wasm.reset();
  const v = wasm.sphere_deviation(w);
  return v < 0 ? null : v;
}

const whole = (...v) => v.every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 30);
const prim = (res) => (res ? meshOut(res) : null);

/** unitSphere, unitCylinder, unitCapsule, unitTorus and roundedBox ({positions, normals, uvs, indices}), or null. */
export const primitivesWasm = {
  sphere: (segments) => (enabled && whole(segments) ? (wasm.reset(), prim(wasm.sphere(segments))) : null),
  cylinder: (top, segments, caps) => (enabled && whole(segments) ? (wasm.reset(), prim(wasm.cylinder(top, segments, caps ? 1 : 0))) : null),
  capsule: (L, segments) => (enabled && whole(segments) ? (wasm.reset(), prim(wasm.capsule(L, segments))) : null),
  torus: (t, arcDeg, segments, tubeSegments) => (enabled && whole(segments, tubeSegments) ? (wasm.reset(), prim(wasm.torus(t, arcDeg, segments, tubeSegments))) : null),
  roundedBox: (w, h, d, r, seg) => (enabled && whole(seg) && seg >= 1 ? (wasm.reset(), prim(wasm.rounded_box(w, h, d, r, seg))) : null),
};

/** catmullRom for two or more points (a Float64Array), or null. */
export function catmullRomWasm(points, closed, subdivisions) {
  if (!enabled || !whole(subdivisions) || points.length < 6 || points.length % 3) return null;
  wasm.reset();
  const p = put(f64(points));
  const res = p && wasm.catmull_rom(p, points.length / 3, closed ? 1 : 0, subdivisions);
  if (!res) return null;
  const [count, out] = new Uint32Array(heap(), res, 2);
  return new Float64Array(heap(), out, count * 3).slice();
}

/** gearOutline ({outline: {points, smooth, closed}, outerRadius, rootRadius}), or null. */
export function gearOutlineWasm(teeth, pressureAngleDeg, flankSamples, arcSamples) {
  if (!enabled || !whole(teeth, flankSamples, arcSamples) || teeth < 1) return null;
  wasm.reset();
  const res = wasm.gear_outline(teeth, pressureAngleDeg, flankSamples, arcSamples);
  if (!res) return null;
  const [count, pts, smooth, radii] = new Uint32Array(heap(), res, 4);
  const [outerRadius, rootRadius] = new Float64Array(heap(), radii, 2);
  return {
    outline: { points: new Float64Array(heap(), pts, count * 2).slice(), smooth: new Uint8Array(heap(), smooth, count).slice(), closed: true },
    outerRadius,
    rootRadius,
  };
}

// Header layouts of the instance kernel (the enums in wasm/simd/instances.c).
export const INSTANCE_HEADER = {
  KIND: 0, FIRST: 1, COUNT: 2, STATE: 3, MODE: 4, NX: 5, NZ: 6, RANDOM: 7, CHOICES: 8,
  OPS: 9, NOPS: 10, MATS: 11, ROWS: 12, NROWS: 13, BOUNDS: 14, MATERIALS: 15, LODS: 16, OUTER_LOD: 17, SWITCH: 18, SLOTS: 19,
  OUT: 20, SIZE: 29,
};
export const INSTANCE_PARAMS = { WORLD: 0, ACC: 16, STEP: 32, SPACING: 48, JITTER: 50, RADIUS: 51, AREA: 52, ROTATION: 54, SCALE: 60, BOUNDS: 66, SIZE: 72 };

/**
 * Instance rows of placements [FIRST, FIRST + COUNT) of a <repeat> or
 * <scatter> whose subtree was recorded as `template` ({ops, mats, table,
 * bounds}, see recordTemplate in src/scene/flatten.js). The headers `h`
 * (Int32Array) and `f` (Float64Array) and the table `materials` (material
 * index per material code, -1 until resolveMaterial(code) has given it)
 * carry the generator state, the accumulated repeat step, the scene bounds
 * and the materials from one call to the next. Returns views of kernel
 * memory, valid until the next kernel call, or null.
 */
export function instancesWasm(h, f, template, materials, resolveMaterial) {
  if (!enabled || !simd) return null;
  simd.reset();
  const H = INSTANCE_HEADER;
  h[H.OPS] = put(template.ops, simd);
  h[H.MATS] = put(template.mats, simd);
  h[H.ROWS] = put(template.table, simd);
  h[H.BOUNDS] = put(template.bounds, simd);
  h[H.MATERIALS] = put(materials, simd);
  const hp = put(h, simd), fp = put(f, simd);
  if (!h[H.OPS] || !h[H.MATS] || !h[H.ROWS] || !h[H.BOUNDS] || !h[H.MATERIALS] || !hp || !fp) return null;
  material = resolveMaterial;
  try {
    if (!simd.instances(hp, fp)) return null;
  } finally {
    material = null;
  }
  const buf = simd.memory.buffer;
  h.set(new Int32Array(buf, hp, H.SIZE));
  f.set(new Float64Array(buf, fp, INSTANCE_PARAMS.SIZE));
  materials.set(new Int32Array(buf, h[H.MATERIALS], materials.length));
  const n = h[H.COUNT] * h[H.NROWS];
  const o = H.OUT;
  return {
    matrices: new Float32Array(buf, h[o], n * 16),
    spheres: new Float32Array(buf, h[o + 1], n * 4),
    geom: new Uint32Array(buf, h[o + 2], n),
    mat: new Uint32Array(buf, h[o + 3], n),
    uid: new Uint32Array(buf, h[o + 4], n),
    lodNode: new Int32Array(buf, h[o + 5], n),
    lodChild: new Uint16Array(buf, h[o + 6], n),
    flags: new Uint8Array(buf, h[o + 7], n),
    switches: new Float64Array(buf, h[o + 8], h[H.COUNT] * h[H.LODS] * 4),
  };
}

/** es3dCos(x) and es3dSin(x) as the instance kernel computes them (for the tests), or null. */
export function cosSinWasm(x) {
  if (!enabled || !simd) return null;
  simd.reset();
  const p = simd.alloc(16);
  simd.cos_sin(x, p);
  return Array.from(new Float64Array(simd.memory.buffer, p, 2));
}
