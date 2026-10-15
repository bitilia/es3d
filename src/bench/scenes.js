// Benchmark scene catalogue shared by the Node benchmark (scripts/bench.mjs)
// and the LAN benchmark (benchmark/).
//
// Every scene starts as an ES3D document. The OBJ and glTF versions are
// exported from the compiled ES3D scene, so all formats describe exactly the
// same rendered triangles, materials and transforms.

import { parse } from '../format/parse.js';
import { formatNumber } from '../format/value-format.js';
import { expandProcedural } from '../optimize/optimizer.js';
import { mulberry32 } from '../math/random.js';

export const BENCH_SCENES = [
  { id: 'cube', label: 'Rotating cube', file: '01-rotating-cube.es3d', note: 'One object: fixed costs dominate.' },
  { id: 'primitives', label: 'Primitive test', file: '02-primitives.es3d', note: 'Every primitive type once; curved surfaces.' },
  { id: 'logo', label: 'Extruded logo', file: '03-logo.es3d', note: 'SVG-style path data extruded with bevels.' },
  { id: 'gearbox', label: 'Gearbox', file: '05-gearbox.es3d', note: 'Procedural gears, sweeps and revolved profiles.' },
  { id: 'forest', label: 'Forest (scatter)', file: '04-forest.es3d', note: '7,401 instances placed by three <scatter> elements.' },
  {
    id: 'forest-explicit',
    label: 'Forest (explicit)',
    file: '04-forest.es3d',
    expand: true,
    note: 'The same forest with every instance written out as an element (what a DCC exporter would write).',
  },
  { id: 'city', label: 'City', file: '06-city.es3d', note: '10,926 instances on grids.' },
  { id: 'lod-stress', label: 'LOD stress', file: '12-lod-stress.es3d', note: '25,728 instances, curved primitives with automatic LOD.' },
  { id: 'scan', label: 'Scanned mesh', generate: 'scan', note: 'An irregular 81,920-triangle mesh with no procedural structure: the ES3D worst case.' },
];

export const DEFAULT_BENCH_IDS = BENCH_SCENES.map((s) => s.id);

/**
 * ES3D source text of a benchmark scene.
 * @param {object} scene entry of BENCH_SCENES
 * @param {(file: string) => Promise<string>} readExample loads docs/public/examples/<file>
 */
export async function benchSceneSource(scene, readExample) {
  if (scene.generate === 'scan') return scanSceneSource();
  const text = await readExample(scene.file);
  if (!scene.expand) return text;
  const doc = parse(text);
  if (!doc.ok) throw new Error(`${scene.file} does not parse`);
  return expandProcedural(doc);
}

/**
 * A "scanned" object: a subdivided icosahedron displaced by deterministic
 * noise, written as an explicit <mesh>. Nothing about it is procedural, so it
 * measures ES3D used purely as a mesh container.
 * @param {number} [subdivisions] 6 -> 40,962 vertices / 81,920 triangles
 * @param {number} [digits] decimals written per coordinate (same as the OBJ export)
 */
export function scanSceneSource(subdivisions = 6, digits = 5) {
  const { positions, indices } = displacedIcosphere(subdivisions, 7);
  const pos = new Array(positions.length);
  for (let i = 0; i < positions.length; i++) pos[i] = formatNumber(positions[i], digits);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Benchmark scene: an irregular mesh without procedural structure (${indices.length / 3} triangles). -->
<es3d version="1">
  <title>Scanned mesh</title>
  <environment background="#20242b" intensity="0.6"/>
  <camera position="2.3,1.3,2.7" target="0,0,0" fov="40"/>
  <light type="directional" direction="-0.5,-1,-0.4" intensity="1.3"/>
  <material id="stone" color="#a39b8b" roughness="0.85"/>
  <mesh material="stone" smooth="180" positions="${pos.join(' ')}" indices="${Array.from(indices).join(' ')}"/>
</es3d>
`;
}

/** Subdivided icosahedron with smooth pseudo-random bumps (deterministic). */
export function displacedIcosphere(subdivisions, seed) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const verts = [];
  const addVertex = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    verts.push(x / l, y / l, z / l);
    return verts.length / 3 - 1;
  };
  for (const [x, y, z] of [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ]) addVertex(x, y, z);
  let faces = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  for (let level = 0; level < subdivisions; level++) {
    const mids = new Map();
    const mid = (a, b) => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      let m = mids.get(key);
      if (m === undefined) {
        m = addVertex(verts[a * 3] + verts[b * 3], verts[a * 3 + 1] + verts[b * 3 + 1], verts[a * 3 + 2] + verts[b * 3 + 2]);
        mids.set(key, m);
      }
      return m;
    };
    const next = [];
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i], b = faces[i + 1], c = faces[i + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  // displacement: a sum of smooth bumps and dents at random directions
  const rand = mulberry32(seed);
  const bumps = [];
  for (let k = 0; k < 48; k++) {
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    const width = 0.15 + rand() * 0.5;
    bumps.push([s * Math.cos(a), s * Math.sin(a), z, (rand() - 0.4) * 0.16 * width * 3, 1 / (width * width)]);
  }
  const n = verts.length / 3;
  const positions = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    let r = 1;
    for (const [bx, by, bz, amp, inv] of bumps) {
      const d2 = (x - bx) ** 2 + (y - by) ** 2 + (z - bz) ** 2;
      r += amp * Math.exp(-d2 * inv);
    }
    // fine surface detail
    r += 0.006 * Math.sin(x * 23 + 1.3) * Math.sin(y * 19 + 0.7) * Math.sin(z * 21 + 2.1);
    positions[i * 3] = x * r * 0.95;
    positions[i * 3 + 1] = y * r * 0.72;
    positions[i * 3 + 2] = z * r;
  }
  return { positions, indices: Uint32Array.from(faces) };
}
