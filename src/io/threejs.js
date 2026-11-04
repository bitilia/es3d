// three.js r186 module. The script is `import * as THREE from 'three'` and
// `export function createScene()`, which returns a Group. three.js is Y-up,
// the same as ES3D, and Matrix4.fromArray is column-major.
//
// Geometry (r186):
//   BoxGeometry(width, height, depth) is centred.
//   SphereGeometry(radius, widthSegments, heightSegments).
//   CylinderGeometry(radiusTop, radiusBottom, height, radialSegments, 1, openEnded).
//   radiusTop is the +Y end, which is the ES3D top.
//   CapsuleGeometry(radius, length, capSegments, radialSegments). length is the
//   cylindrical middle, not the total height, so length = h − 2r. A capsule
//   with no middle is a SphereGeometry.
//   PlaneGeometry(width, height) lies in XY facing +Z. A rotation of −90°
//   about X, matrix [1, 0, 0, 0, 0, 0, −1, 0, 0, 1, 0, 0, 0, 0, 0, 1] in
//   column-major order, lays it in XZ facing +Y. (x, y, 0) becomes (x, 0, −y);
//   a centred plane is unchanged by the sign.
//   TorusGeometry lies in XY around Z. The same −90° rotation about X puts it around Y.
//   ExtrudeGeometry extrudes a Shape along +Z, which matches an ES3D extrude with no bevel.
//   LatheGeometry revolves Vector2(radius, height) around Y. Its zero angle lies on +Z,
//   so a partial revolve starts at π/2, which is +X, and turns toward −Z.
// MeshStandardMaterial.color is sRGB. The property is metalness, and roughness
// defaults to 1, so 0.5 is always written. metalness defaults to 0.
//
// A repeated single mesh is an InstancedMesh. A repeated group is a loop that
// clones meshes whose geometry was created once. Scatter with a random offset
// inlines mulberry32 and es3dSin, the same functions the flattener uses, so
// the positions match. The script does not import ES3D and it is not minified.

import * as mat4 from '../math/mat4.js';
import { n, trsOf } from './text-encode.js';
import { paint } from './export-model.js';

const RX90 = new Float64Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);

function nums(values) {
  return Array.from(values, (v) => n(v)).join(', ');
}

/**
 * @returns {{text: string, notes: string[]}}
 */
export function exportThree(model) {
  const notes = model.notes.slice();
  const tally = new Map();
  const add = (key, k = 1) => tally.set(key, (tally.get(key) || 0) + k);
  const lines = [];
  const geos = new Map();
  const mats = new Map();
  let seq = 0;
  const fresh = (p) => `${p}${seq++}`;
  let needsRandom = false;

  const material = (index, forceDouble = false) => {
    const key = `${index}:${forceDouble ? 1 : 0}`;
    if (mats.has(key)) return mats.get(key);
    const id = fresh('m');
    mats.set(key, id);
    const m = model.materials[index];
    const c = m.baseColorSrgb;
    const side = (m.doubleSided || forceDouble) ? ', side: THREE.DoubleSide' : '';
    if (m.unlit) {
      lines.push(`  const ${id} = new THREE.MeshBasicMaterial({ color: new THREE.Color(${n(c[0])}, ${n(c[1])}, ${n(c[2])}), transparent: ${m.opacity < 0.999}, opacity: ${n(m.opacity)}${side} });`);
      return id;
    }
    lines.push(`  const ${id} = new THREE.MeshStandardMaterial({ color: new THREE.Color(${n(c[0])}, ${n(c[1])}, ${n(c[2])}), metalness: ${n(m.metallic)}, roughness: ${n(m.roughness)}, transparent: ${m.opacity < 0.999}, opacity: ${n(m.opacity)}${side} });`);
    return id;
  };

  const geometry = (solid) => {
    const key = solid.key;
    if (geos.has(key)) return geos.get(key);
    const id = fresh('g');
    geos.set(key, id);
    lines.push(`  const ${id} = ${geometryExpr(solid)};`);
    return id;
  };

  const geometryExpr = (solid) => {
    if (solid.kind === 'box') {
      const s = solid.size;
      return `new THREE.BoxGeometry(${n(s[0])}, ${n(s[1])}, ${n(s[2])})`;
    }
    if (solid.kind === 'sphere') return `new THREE.SphereGeometry(${n(solid.radius)}, ${solid.segments}, ${Math.max(3, Math.round(solid.segments / 2))})`;
    if (solid.kind === 'cylinder' || solid.kind === 'cone' || solid.kind === 'frustum') {
      const top = solid.kind === 'cone' ? 0 : (solid.radiusTop !== undefined ? solid.radiusTop : solid.radius);
      const bottom = solid.radius;
      return `new THREE.CylinderGeometry(${n(top)}, ${n(bottom)}, ${n(solid.height)}, ${solid.segments}, 1, ${solid.caps === false})`;
    }
    if (solid.kind === 'capsule') {
      const mid = solid.height - 2 * solid.radius;
      if (mid <= 1e-6) return `new THREE.SphereGeometry(${n(solid.radius)}, ${solid.segments}, ${Math.max(3, Math.round(solid.segments / 2))})`;
      const caps = Math.max(1, Math.round(solid.segments / 4));
      return `new THREE.CapsuleGeometry(${n(solid.radius)}, ${n(mid)}, ${caps}, ${solid.segments})`;
    }
    if (solid.kind === 'plane') return `new THREE.PlaneGeometry(${n(solid.width)}, ${n(solid.depth)})`;
    if (solid.kind === 'torus') return `new THREE.TorusGeometry(${n(solid.radius)}, ${n(solid.tube)}, ${solid.tubeSegments}, ${solid.segments})`;
    if (solid.kind === 'extrude') return extrudeExpr(solid);
    if (solid.kind === 'revolve') return latheExpr(solid);
    if (solid.kind === 'surface' && solid.regions.length === 1) return shapeExpr(solid.regions[0], 'ShapeGeometry');
    return null;
  };

  const meshOf = (node) => {
    if (node.solid.kind === 'mesh' || node.solid.kind === 'lines' || geometryExpr(node.solid) === null) {
      return baked(node);
    }
    const g = geometry(node.solid);
    const m = material(node.material, node.doubleSided);
    if (node.solid.kind === 'plane') add('plane');
    const id = fresh('o');
    lines.push(`  const ${id} = new THREE.Mesh(${g}, ${m});`);
    apply(id, placed(node));
    return id;
  };

  const baked = (node) => {
    const mesh = node.solid.kind === 'mesh' || node.solid.kind === 'lines' ? node.solid : model.bakedMesh(node.entry);
    add(node.solid.kind === 'mesh' || node.solid.kind === 'lines' ? 'mesh' : node.solid.kind);
    const g = fresh('g');
    const positions = `new Float32Array([${nums(mesh.positions)}])`;
    lines.push(`  const ${g} = new THREE.BufferGeometry();`);
    lines.push(`  ${g}.setAttribute('position', new THREE.BufferAttribute(${positions}, 3));`);
    if (mesh.normals) lines.push(`  ${g}.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([${nums(mesh.normals)}]), 3));`);
    lines.push(`  ${g}.setIndex([${Array.from(mesh.indices).join(', ')}]);`);
    const m = material(node.material, node.doubleSided);
    const id = fresh('o');
    const kind = mesh.kind === 'lines' ? 'LineSegments' : 'Mesh';
    lines.push(`  const ${id} = new THREE.${kind}(${g}, ${m});`);
    const matrix = node.solid.kind === 'mesh' || node.solid.kind === 'lines' ? node.matrix : node.meshMatrix;
    apply(id, matrix);
    return id;
  };

  const apply = (id, matrix) => {
    if (!matrix) return;
    const t = trsOf(matrix);
    if (t && t.plain) {
      lines.push(`  ${id}.position.set(${n(t.translation[0])}, ${n(t.translation[1])}, ${n(t.translation[2])});`);
      return;
    }
    lines.push(`  ${id}.matrix.fromArray([${nums(matrix)}]);`);
    lines.push(`  ${id}.matrixAutoUpdate = false;`);
  };

  const emit = (node, parent) => {
    if (!node) return;
    if (node.kind === 'shape') {
      const id = meshOf(node);
      lines.push(`  ${parent}.add(${id});`);
      return;
    }
    if (node.kind === 'repeat' && node.children.length === 1 && node.children[0].kind === 'shape' && geometryExpr(node.children[0].solid)) {
      instanced(node, parent);
      return;
    }
    if (node.kind === 'repeat' || node.kind === 'scatter') {
      looped(node, parent);
      return;
    }
    const id = fresh('o');
    lines.push(`  const ${id} = new THREE.Group();`);
    apply(id, node.matrix);
    lines.push(`  ${parent}.add(${id});`);
    for (const c of node.children) emit(c, id);
  };

  const instanced = (node, parent) => {
    add('instanced');
    const child = node.children[0];
    if (child.solid.kind === 'plane') add('plane', node.count);
    const g = geometry(child.solid);
    const m = material(child.material, child.doubleSided);
    const id = fresh('o');
    lines.push(`  const ${id} = new THREE.InstancedMesh(${g}, ${m}, ${node.count});`);
    const step = node.step;
    lines.push(`  const step_${id} = new THREE.Matrix4().fromArray([${nums(step)}]);`);
    lines.push(`  const acc_${id} = new THREE.Matrix4();`);
    lines.push(`  const local_${id} = new THREE.Matrix4().fromArray([${nums(placed(child) || mat4.createF64())}]);`);
    lines.push(`  const tmp_${id} = new THREE.Matrix4();`);
    lines.push(`  for (let i = 0; i < ${node.count}; i++) {`);
    lines.push(`    tmp_${id}.multiplyMatrices(acc_${id}, local_${id});`);
    lines.push(`    ${id}.setMatrixAt(i, tmp_${id});`);
    lines.push(`    acc_${id}.multiply(step_${id});`);
    lines.push(`  }`);
    apply(id, node.matrix);
    lines.push(`  ${parent}.add(${id});`);
  };

  const looped = (node, parent) => {
    if (node.kind === 'scatter') {
      needsRandom = !!(node.params.radius || node.params.randomRotation);
      add('scatter', node.params.count);
    } else add('repeat', node.count);
    const holder = fresh('o');
    lines.push(`  const ${holder} = new THREE.Group();`);
    apply(holder, node.matrix);
    lines.push(`  ${parent}.add(${holder});`);
    const materialIds = node.kind === 'scatter' && node.params.randomMaterial && node.params.randomMaterial.length
      ? node.params.randomMaterial
      : [null];
    const factories = materialIds.map((id) => {
      const kids = id ? node.children.map((c) => paint(c, id, null, model.resolve)) : node.children;
      const name = fresh('make');
      lines.push(`  const ${name} = () => {`);
      lines.push(`    const copy = new THREE.Group();`);
      for (const c of kids) emit(c, 'copy');
      lines.push(`    return copy;`);
      lines.push(`  };`);
      return name;
    });
    const callCopy = factories.length === 1
      ? `const copy = ${factories[0]}();`
      : `const choices = [${factories.join(', ')}]; const mi = Math.min(choices.length - 1, Math.floor(u[8] * choices.length)); const copy = choices[mi]();`;
    if (node.kind === 'repeat') {
      lines.push(`  {`);
      lines.push(`    const step = new THREE.Matrix4().fromArray([${nums(node.step)}]);`);
      lines.push(`    const acc = new THREE.Matrix4();`);
      lines.push(`    for (let i = 0; i < ${node.count}; i++) {`);
      lines.push(`      ${callCopy}`);
      lines.push(`      copy.matrix.multiplyMatrices(acc, copy.matrix);`);
      lines.push(`      copy.matrixAutoUpdate = false;`);
      lines.push(`      ${holder}.add(copy);`);
      lines.push(`      acc.multiply(step);`);
      lines.push(`    }`);
      lines.push(`  }`);
    } else {
      needsRandom = true;
      const p = node.params;
      lines.push(`  {`);
      lines.push(`    const rand = mulberry32(${p.seed >>> 0});`);
      lines.push(`    const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;`);
      lines.push(`    for (let i = 0; i < ${p.count}; i++) {`);
      lines.push(`      const u = [rand(), rand(), rand(), rand(), rand(), rand(), rand(), rand(), rand()];`);
      lines.push(`      const pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1];`);
      if (p.grid) {
        lines.push(`      const ix = i % ${p.grid[0]}, iz = Math.floor(i / ${p.grid[0]});`);
        lines.push(`      pos[0] = (ix - ${n((p.grid[0] - 1) / 2)}) * ${n(p.spacing[0])} + (u[0] - 0.5) * ${n(p.jitter)} * ${n(p.spacing[0])};`);
        lines.push(`      pos[2] = (iz - ${n((p.grid[1] - 1) / 2)}) * ${n(p.spacing[1])} + (u[1] - 0.5) * ${n(p.jitter)} * ${n(p.spacing[1])};`);
      } else if (p.radius) {
        lines.push(`      const r = ${n(p.radius)} * Math.sqrt(u[0]);`);
        lines.push(`      const a = u[1] * Math.PI * 2;`);
        lines.push(`      pos[0] = r * es3dCos(a);`);
        lines.push(`      pos[2] = r * es3dSin(a);`);
      } else {
        lines.push(`      pos[0] = (u[0] - 0.5) * ${n(p.area[0])};`);
        lines.push(`      pos[2] = (u[1] - 0.5) * ${n(p.area[1])};`);
      }
      if (p.randomRotation) {
        const rr = p.randomRotation.ranges;
        lines.push(`      rot[0] = lerp([${n(rr[0][0])}, ${n(rr[0][1])}], u[2]);`);
        lines.push(`      rot[1] = lerp([${n(rr[1][0])}, ${n(rr[1][1])}], u[3]);`);
        lines.push(`      rot[2] = lerp([${n(rr[2][0])}, ${n(rr[2][1])}], u[4]);`);
      }
      if (p.randomScale) {
        const rs = p.randomScale.ranges;
        if (p.randomScale.uniform) lines.push(`      scl[0] = scl[1] = scl[2] = lerp([${n(rs[0][0])}, ${n(rs[0][1])}], u[5]);`);
        else {
          lines.push(`      scl[0] = lerp([${n(rs[0][0])}, ${n(rs[0][1])}], u[5]);`);
          lines.push(`      scl[1] = lerp([${n(rs[1][0])}, ${n(rs[1][1])}], u[6]);`);
          lines.push(`      scl[2] = lerp([${n(rs[2][0])}, ${n(rs[2][1])}], u[7]);`);
        }
      }
      lines.push(`      const x = rot[0] * Math.PI / 180, y = rot[1] * Math.PI / 180, z = rot[2] * Math.PI / 180;`);
      lines.push(`      const cx = es3dCos(x), sx = es3dSin(x), cy = es3dCos(y), sy = es3dSin(y), cz = es3dCos(z), sz = es3dSin(z);`);
      lines.push(`      const e = [cz * cy, sz * cy, -sy, 0, cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx, 0, cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx, 0, pos[0], pos[1], pos[2], 1];`);
      lines.push(`      e[0] *= scl[0]; e[1] *= scl[0]; e[2] *= scl[0]; e[4] *= scl[1]; e[5] *= scl[1]; e[6] *= scl[1]; e[8] *= scl[2]; e[9] *= scl[2]; e[10] *= scl[2];`);
      lines.push(`      const placed = new THREE.Matrix4().fromArray(e);`);
      lines.push(`      ${callCopy}`);
      lines.push(`      copy.matrix.multiplyMatrices(placed, copy.matrix);`);
      lines.push(`      copy.matrixAutoUpdate = false;`);
      lines.push(`      ${holder}.add(copy);`);
      lines.push(`    }`);
      lines.push(`  }`);
    }
  };

  emit(model.root, 'root');
  for (const light of model.lights) lines.push(lightLine(light, add));
  for (const camera of model.cameras) lines.push(cameraLine(camera));

  if (tally.get('plane')) notes.push(`${tally.get('plane').toLocaleString('en-US')} plane${tally.get('plane') === 1 ? '' : 's'} rotated from XY into XZ.`);
  if (tally.get('instanced')) notes.push(`${tally.get('instanced').toLocaleString('en-US')} repeat${tally.get('instanced') === 1 ? '' : 's'} written as an InstancedMesh.`);
  if (tally.get('scatter')) notes.push(`${tally.get('scatter').toLocaleString('en-US')} scattered copies placed with the same mulberry32 sequence as ES3D.`);
  const dropped = ['extrude', 'revolve', 'surface', 'torus', 'frustum'].filter((k) => tally.get(k));
  if (dropped.length) notes.push(`Some shapes were written as triangle buffers (${dropped.join(', ')}).`);

  const helper = needsRandom ? RANDOM_HELPER : '';
  const text = `import * as THREE from 'three';
${helper}
export function createScene() {
  const root = new THREE.Group();
${lines.join('\n')}
  return root;
}
`;
  return { text, notes };
}

function lightLine(light) {
  const c = light.color;
  const color = `new THREE.Color().setRGB(${n(c[0])}, ${n(c[1])}, ${n(c[2])}, THREE.LinearSRGBColorSpace)`;
  if (light.type === 'ambient') return `  root.add(new THREE.AmbientLight(${color}));`;
  if (light.type === 'hemisphere') return `  root.add(new THREE.HemisphereLight(${color}, new THREE.Color().setRGB(${n(light.ground[0])}, ${n(light.ground[1])}, ${n(light.ground[2])}, THREE.LinearSRGBColorSpace)));`;
  const p = light.position, d = light.direction;
  if (light.type === 'directional') return `  { const L = new THREE.DirectionalLight(${color}); L.position.set(${n(p[0] - d[0])}, ${n(p[1] - d[1])}, ${n(p[2] - d[2])}); L.target.position.set(${n(p[0])}, ${n(p[1])}, ${n(p[2])}); root.add(L); root.add(L.target); }`;
  if (light.type === 'spot') {
    const angle = Math.acos(Math.min(1, Math.max(-1, light.outer)));
    return `  { const L = new THREE.SpotLight(${color}); L.position.set(${n(p[0])}, ${n(p[1])}, ${n(p[2])}); L.target.position.set(${n(p[0] + d[0])}, ${n(p[1] + d[1])}, ${n(p[2] + d[2])}); L.angle = ${n(angle)}; root.add(L); root.add(L.target); }`;
  }
  return `  { const L = new THREE.PointLight(${color}); L.position.set(${n(p[0])}, ${n(p[1])}, ${n(p[2])}); root.add(L); }`;
}

function cameraLine(camera) {
  const p = camera.position, t = camera.target;
  if (camera.type === 'orthographic') {
    const hh = camera.height / 2, hw = hh * (camera.aspect || 1);
    return `  { const C = new THREE.OrthographicCamera(${n(-hw)}, ${n(hw)}, ${n(hh)}, ${n(-hh)}); C.position.set(${n(p[0])}, ${n(p[1])}, ${n(p[2])}); C.lookAt(${n(t[0])}, ${n(t[1])}, ${n(t[2])}); root.add(C); }`;
  }
  return `  { const C = new THREE.PerspectiveCamera(${n(camera.fov || 45)}, ${n(camera.aspect || 1)}); C.position.set(${n(p[0])}, ${n(p[1])}, ${n(p[2])}); C.lookAt(${n(t[0])}, ${n(t[1])}, ${n(t[2])}); root.add(C); }`;
}

function pathCalls(pts) {
  let text = '';
  for (let i = 0; i < pts.length; i += 2) {
    const call = i === 0 ? 'moveTo' : 'lineTo';
    text += `.${call}(${n(pts[i])}, ${n(pts[i + 1])})`;
  }
  return text + '.closePath()';
}

function shapeExpr(region, ctor) {
  const holes = (region.holes || []).map((h, i) => ` const h${i} = new THREE.Path()${pathCalls(h)}; s.holes.push(h${i});`).join('');
  return `(() => { const s = new THREE.Shape()${pathCalls(region.outer)};${holes} return new THREE.${ctor}(s); })()`;
}

function extrudeExpr(solid) {
  const bodies = solid.regions.map((region, i) => {
    const holes = (region.holes || []).map((h, k) => ` const h${i}${k} = new THREE.Path()${pathCalls(h)}; s${i}.holes.push(h${i}${k});`).join('');
    return `const s${i} = new THREE.Shape()${pathCalls(region.outer)};${holes}`;
  }).join(' ');
  const list = solid.regions.map((_, i) => `s${i}`).join(', ');
  const center = solid.center ? `.translate(0, 0, ${n(-solid.depth / 2)})` : '';
  return `(() => { ${bodies} return new THREE.ExtrudeGeometry([${list}], { depth: ${n(solid.depth)}, bevelEnabled: false })${center}; })()`;
}

function latheExpr(solid) {
  const pts = [];
  for (let i = 0; i < solid.points.length; i += 2) pts.push(`new THREE.Vector2(${n(solid.points[i])}, ${n(solid.points[i + 1])})`);
  const full = !(solid.angle < 360 - 1e-6);
  // phi 0 sits on +Z. ES3D starts on +X and turns toward −Z, which is phi = π/2.
  const sweep = full ? '' : `, ${n(Math.PI / 2)}, ${n(solid.angle * Math.PI / 180)}`;
  return `new THREE.LatheGeometry([${pts.join(', ')}], ${solid.segments}${sweep})`;
}

function placed(node) {
  if (!node.solid || (node.solid.kind !== 'plane' && node.solid.kind !== 'torus')) return node.matrix;
  if (!node.matrix) return RX90;
  const out = mat4.createF64();
  mat4.multiply(out, node.matrix, RX90);
  return out;
}

const RANDOM_HELPER = `function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PI = Math.PI, TWO_PI = PI * 2, HALF_PI = PI * 0.5, QUARTER_PI = PI * 0.25;
const S1 = -1.66666666666666324348e-1, S2 = 8.33333333332248946124e-3, S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6, S5 = -2.50507602534068634195e-8, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2, C2 = -1.38888888888741095749e-3, C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7, C5 = 2.0875723212981748279e-9, C6 = -1.13596475577881948265e-11;
function kernelSin(x) {
  const z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}
function kernelCos(x) {
  const z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  return 1 - 0.5 * z + z * r;
}
function es3dSin(x) {
  if (!Number.isFinite(x)) return x;
  let y = x - TWO_PI * Math.round(x / TWO_PI);
  let sign = 1;
  if (y < 0) { sign = -1; y = -y; }
  if (y > HALF_PI) y = PI - y;
  if (y < 0) y = 0;
  const s = y > QUARTER_PI ? kernelCos(HALF_PI - y) : kernelSin(y);
  return sign < 0 ? -s : s;
}
function es3dCos(x) { return es3dSin(x + HALF_PI); }
`;
