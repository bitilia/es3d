// The ES3D optimizer: semantic-preserving rewrites that make documents smaller.
//
//   stripDefaults     remove attributes equal to their schema default
//   dedupeMaterials   merge <material>s with identical parameters
//   extractRepeated   identical subtrees -> one definition in <defs> + <use>
//   detectPatterns    sibling copies whose transforms form a progression -> <repeat>
//   collapseGroups    drop empty groups and attribute-less single-child groups
//   weldMeshes        merge duplicate vertices of <mesh> elements
//   removeUnused      drop definitions and materials nothing references
//   precision         quantize numbers when serializing (lossy, opt-in)
//
// plus expandProcedural(), the inverse operation used by the benchmark: it
// bakes <repeat>/<scatter> into explicit <use>/<group> elements.

import { Attr, Comment, Document, Element, cloneElement, h } from '../format/ast.js';
import { parse } from '../format/parse.js';
import { serialize } from '../format/serializer.js';
import { attrSpec, elementSpec, valueOf } from '../format/schema.js';
import { materialKey, paramsFromElement } from '../material/materials.js';
import { formatNumber, formatNumberList, formatPathData } from '../format/value-format.js';
import { matrixToEuler, opsToMatrix } from '../transform/transform.js';
import * as mat4 from '../math/mat4.js';
import { mulberry32 } from '../math/random.js';
import { es3dCos, es3dSin } from '../math/trig.js';

const PLACEMENT = ['transform', 'position', 'rotation', 'scale'];
const SHORT = (n) => formatNumber(n, 6);

function deepEqual(a, b, eps = 1e-12) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.length !== undefined && b.length !== undefined) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], eps)) return false;
      return true;
    }
  }
  return false;
}

/** Clone a validated tree keeping a link to the source element (for typed values). */
function cloneWithOrigin(el) {
  const c = new Element(el.name);
  c.orig = el;
  c.values = el.values;
  c.attrIndex = null;
  for (const a of el.attrs) c.attrs.push(new Attr(a.name, a.value));
  c.text = el.text;
  for (const k of el.children) {
    if (k.type === 'element') c.appendChild(cloneWithOrigin(k));
    else c.appendChild(new Comment(k.text));
  }
  c.selfClosing = c.children.length === 0;
  return c;
}

function canonicalAttr(el, a) {
  const spec = elementSpec(el.name);
  if (!spec) return a.name;
  if (spec.attrs[a.name]) return a.name;
  for (const [k, s] of Object.entries(spec.attrs)) if (s.alias === a.name) return k;
  return a.name;
}

function elementsOf(el) {
  return el.children.filter((c) => c.type === 'element');
}

function walkAll(el, fn, parent = null) {
  fn(el, parent);
  for (const c of elementsOf(el)) walkAll(c, fn, el);
}

/** Structural signature of a subtree, optionally ignoring placement attributes and ids. */
function signature(el, ignorePlacement) {
  const parts = [el.name];
  const attrs = [];
  for (const a of el.attrs) {
    const k = canonicalAttr(el, a);
    if (k === 'id' || k === 'name') continue;
    if (ignorePlacement && PLACEMENT.includes(k)) continue;
    attrs.push(`${k}=${a.value.trim()}`);
  }
  attrs.sort();
  parts.push(attrs.join('&'));
  if (el.text) parts.push('"' + el.text.trim());
  const kids = elementsOf(el).map((c) => signature(c, false));
  return `${parts.join('|')}(${kids.join(',')})`;
}

/** Local placement matrix of an element from its raw attributes (re-parsed when needed). */
function placementMatrix(el) {
  const get = (k) => {
    const a = el.attrs.find((x) => canonicalAttr(el, x) === k);
    return a ? a.value : undefined;
  };
  const parseVec = (s, n, def) => {
    if (s === undefined) return def;
    const v = s.split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.length === 1 && n === 3) return [v[0], v[0], v[0]];
    return v;
  };
  const m = mat4.compose(mat4.createF64(), parseVec(get('position'), 3, [0, 0, 0]), parseVec(get('rotation'), 3, [0, 0, 0]), parseVec(get('scale'), 3, [1, 1, 1]));
  const t = get('transform');
  if (t !== undefined) {
    const doc = parse(`<es3d version="1"><group transform="${t.replace(/"/g, '&quot;')}"/></es3d>`);
    const g = doc.root.children.find((c) => c.type === 'element');
    if (g && g.values && g.values.transform) mat4.multiply(m, g.values.transform.matrix, m);
  }
  return m;
}

function setPlacement(el, m) {
  el.attrs = el.attrs.filter((a) => !PLACEMENT.includes(canonicalAttr(el, a)));
  const e = matrixToEuler(m);
  if (!e) {
    el.attrs.push(new Attr('transform', `matrix(${Array.from(m, SHORT).join(',')})`));
    return;
  }
  if (e.translation.some((v) => Math.abs(v) > 1e-9)) el.attrs.push(new Attr('position', e.translation.map(SHORT).join(',')));
  if (e.rotation.some((v) => Math.abs(v) > 1e-9)) el.attrs.push(new Attr('rotation', e.rotation.map(SHORT).join(',')));
  if (e.scale.some((v) => Math.abs(v - 1) > 1e-9)) {
    const [a, b, c] = e.scale;
    el.attrs.push(new Attr('scale', Math.abs(a - b) < 1e-9 && Math.abs(b - c) < 1e-9 ? SHORT(a) : e.scale.map(SHORT).join(',')));
  }
}

function transformString(m) {
  const e = matrixToEuler(m);
  if (!e) return `matrix(${Array.from(m, SHORT).join(',')})`;
  const parts = [];
  if (e.translation.some((v) => Math.abs(v) > 1e-9)) parts.push(`translate(${e.translation.map(SHORT).join(',')})`);
  if (e.rotation.some((v) => Math.abs(v) > 1e-9)) parts.push(`rotate(${e.rotation.map(SHORT).join(',')})`);
  if (e.scale.some((v) => Math.abs(v - 1) > 1e-9)) {
    const [a, b, c] = e.scale;
    parts.push(Math.abs(a - b) < 1e-9 && Math.abs(b - c) < 1e-9 ? `scale(${SHORT(a)})` : `scale(${e.scale.map(SHORT).join(',')})`);
  }
  return parts.join(' ') || 'translate(0,0,0)';
}

// ---------------------------------------------------------------------------
// passes

function stripDefaults(root, report) {
  let n = 0;
  walkAll(root, (el) => {
    const spec = elementSpec(el.name);
    if (!spec || !el.values) return;
    el.attrs = el.attrs.filter((a) => {
      const k = canonicalAttr(el, a);
      const s = spec.attrs[k];
      if (!s || s.default === undefined || s.required) return true;
      const v = el.values[k];
      if (v === undefined) return true;
      if (deepEqual(v, s.default)) {
        n++;
        return false;
      }
      return true;
    });
  });
  if (n) report.push({ pass: 'stripDefaults', detail: `removed ${n} attribute${n === 1 ? '' : 's'} equal to the default` });
}

function rewriteRefs(root, mapping, kinds) {
  walkAll(root, (el) => {
    for (const a of el.attrs) {
      const k = canonicalAttr(el, a);
      const s = attrSpec(el.name, k);
      if (!s) continue;
      if (s.type === 'ref' && kinds.includes(s.ref)) {
        const id = a.value.trim().replace(/^#/, '');
        if (mapping.has(id)) a.value = mapping.get(id);
      } else if (s.type === 'idlist' && kinds.includes(s.ref)) {
        a.value = a.value
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((id) => mapping.get(id.replace(/^#/, '')) || id)
          .join(',');
      }
    }
  });
}

function removeElement(el) {
  const p = el.parent;
  const i = p.children.indexOf(el);
  if (i >= 0) p.children.splice(i, 1);
  // drop a comment directly describing the removed element? keep comments: they may describe other things
}

function dedupeMaterials(root, report) {
  const byKey = new Map();
  const mapping = new Map();
  const remove = [];
  walkAll(root, (el) => {
    if (el.name !== 'material' || !el.values || el.values.id === undefined) return;
    const key = materialKey(paramsFromElement(el.orig || el));
    const first = byKey.get(key);
    if (first) {
      mapping.set(el.values.id, first);
      remove.push(el);
    } else byKey.set(key, el.values.id);
  });
  if (!mapping.size) return;
  rewriteRefs(root, mapping, ['material']);
  for (const el of remove) removeElement(el);
  report.push({ pass: 'dedupeMaterials', detail: `merged ${mapping.size} duplicate material${mapping.size === 1 ? '' : 's'}` });
}

function collectReferences(root) {
  const used = new Set();
  walkAll(root, (el) => {
    for (const a of el.attrs) {
      const s = attrSpec(el.name, canonicalAttr(el, a));
      if (!s) continue;
      if (s.type === 'ref') used.add(a.value.trim().replace(/^#/, ''));
      else if (s.type === 'idlist') for (const id of a.value.split(/[\s,]+/)) if (id) used.add(id.replace(/^#/, ''));
    }
  });
  return used;
}

function removeUnused(root, report) {
  let removed = 0;
  for (;;) {
    const used = collectReferences(root);
    const victims = [];
    walkAll(root, (el, parent) => {
      if (!parent) return;
      const id = el.attrs.find((a) => canonicalAttr(el, a) === 'id');
      const inDefs = parent.name === 'defs';
      if ((inDefs || el.name === 'material') && (!id || !used.has(id.value.trim()))) victims.push(el);
    });
    if (!victims.length) break;
    for (const v of victims) removeElement(v);
    removed += victims.length;
  }
  // empty <defs>
  for (const d of elementsOf(root).filter((e) => e.name === 'defs' && !elementsOf(e).length)) removeElement(d);
  if (removed) report.push({ pass: 'removeUnused', detail: `removed ${removed} unreferenced definition${removed === 1 ? '' : 's'}` });
}

function collapseGroups(root, report) {
  let n = 0;
  const visit = (el) => {
    for (const c of elementsOf(el)) visit(c);
    if (el.name !== 'group' || !el.parent) return;
    const kids = elementsOf(el);
    const attrs = el.attrs.filter((a) => canonicalAttr(el, a) !== 'name');
    if (!kids.length && !attrs.length) {
      removeElement(el);
      n++;
    } else if (kids.length === 1 && !attrs.length && !el.children.some((c) => c.type === 'comment')) {
      const p = el.parent;
      const i = p.children.indexOf(el);
      kids[0].parent = p;
      p.children.splice(i, 1, kids[0]);
      n++;
    }
  };
  visit(root);
  if (n) report.push({ pass: 'collapseGroups', detail: `collapsed ${n} redundant group${n === 1 ? '' : 's'}` });
}

function sceneContainers(root) {
  const out = [root];
  walkAll(root, (el) => {
    if (el !== root && ['scene', 'group', 'repeat', 'scatter', 'lod'].includes(el.name)) out.push(el);
  });
  return out.filter((c) => {
    for (let p = c; p; p = p.parent) if (p.name === 'defs') return false;
    return true;
  });
}

function ensureDefs(root) {
  let defs = elementsOf(root).find((e) => e.name === 'defs');
  if (!defs) {
    defs = h('defs');
    defs.parent = root;
    // place after title/desc/materials at the top
    let i = 0;
    while (i < root.children.length && root.children[i].type === 'element' && ['title', 'desc'].includes(root.children[i].name)) i++;
    root.children.splice(i, 0, defs);
    root.selfClosing = false;
  }
  return defs;
}

function usedIds(root) {
  const ids = new Set();
  walkAll(root, (el) => {
    const a = el.attrs.find((x) => canonicalAttr(el, x) === 'id');
    if (a) ids.add(a.value.trim());
  });
  return ids;
}

function freshId(ids, base) {
  let i = 1;
  while (ids.has(`${base}${i}`)) i++;
  const id = `${base}${i}`;
  ids.add(id);
  return id;
}

function extractRepeated(root, report) {
  const groups = new Map();
  for (const container of sceneContainers(root)) {
    for (const el of elementsOf(container)) {
      if (!['group', 'box', 'sphere', 'cylinder', 'cone', 'capsule', 'torus', 'extrude', 'revolve', 'sweep', 'gear', 'mesh', 'path', 'polygon'].includes(el.name)) continue;
      if (el.attrs.some((a) => canonicalAttr(el, a) === 'id')) continue;
      const sig = signature(el, true);
      let g = groups.get(sig);
      if (!g) groups.set(sig, (g = []));
      g.push(el);
    }
  }
  const ids = usedIds(root);
  let extracted = 0;
  let uses = 0;
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    const proto = list[0];
    const body = cloneWithOrigin(proto.orig || proto);
    body.attrs = body.attrs.filter((a) => !PLACEMENT.includes(canonicalAttr(body, a)) && canonicalAttr(body, a) !== 'name');
    const bodySize = serialize(new Document({ root: body, syntax: 'xml' }), { pretty: false }).length;
    const useOverhead = 18;
    if ((list.length - 1) * bodySize <= list.length * useOverhead) continue;
    const id = freshId(ids, proto.name === 'group' ? 'part' : proto.name);
    body.attrs.unshift(new Attr('id', id));
    const defs = ensureDefs(root);
    defs.appendChild(body);
    for (const el of list) {
      const use = new Element('use');
      use.attrs.push(new Attr('ref', id));
      for (const a of el.attrs) {
        const k = canonicalAttr(el, a);
        if (PLACEMENT.includes(k) || k === 'name') use.attrs.push(new Attr(k, a.value));
      }
      const p = el.parent;
      const i = p.children.indexOf(el);
      use.parent = p;
      p.children.splice(i, 1, use);
      uses++;
    }
    extracted++;
  }
  if (extracted) report.push({ pass: 'extractRepeated', detail: `moved ${extracted} repeated subtree${extracted === 1 ? '' : 's'} into <defs> (${uses} <use> elements)` });
}

function detectPatterns(root, report) {
  let found = 0;
  let replaced = 0;
  for (const container of sceneContainers(root)) {
    const kids = container.children;
    let i = 0;
    while (i < kids.length) {
      const a = kids[i];
      if (a.type !== 'element' || a.name === 'animate' || a.attrs.some((x) => canonicalAttr(a, x) === 'id')) {
        i++;
        continue;
      }
      const sig = signature(a, true);
      let j = i + 1;
      while (j < kids.length && kids[j].type === 'element' && !kids[j].attrs.some((x) => canonicalAttr(kids[j], x) === 'id') && signature(kids[j], true) === sig) j++;
      const run = kids.slice(i, j);
      if (run.length >= 3) {
        const M = run.map(placementMatrix);
        const inv0 = mat4.invert(mat4.createF64(), M[0]);
        const step = inv0 ? mat4.multiply(mat4.createF64(), M[1], inv0) : null;
        let ok = !!step;
        const tmp = mat4.createF64();
        for (let k = 2; ok && k < M.length; k++) {
          mat4.multiply(tmp, step, M[k - 1]);
          if (!mat4.equals(tmp, M[k], 1e-6)) ok = false;
        }
        if (ok && !mat4.isIdentity(step, 1e-12)) {
          const rep = new Element('repeat');
          rep.attrs.push(new Attr('count', String(run.length)), new Attr('step', transformString(step)));
          const first = run[0];
          rep.appendChild(first);
          rep.parent = container;
          kids.splice(i, run.length, rep);
          found++;
          replaced += run.length;
          i++;
          continue;
        }
      }
      i = j;
    }
  }
  if (found) report.push({ pass: 'detectPatterns', detail: `replaced ${replaced} elements by ${found} <repeat> pattern${found === 1 ? '' : 's'}` });
}

function weldMeshes(root, report) {
  let removedVerts = 0;
  walkAll(root, (el) => {
    if (el.name !== 'mesh' || !el.values || !el.values.positions) return;
    const v = el.values;
    if (v.normals || v.uvs) return; // per-vertex attributes would have to be compared too
    const p = v.positions;
    const n = p.length / 3;
    const idx = v.indices || Uint32Array.from({ length: n }, (_, k) => k);
    const map = new Map();
    const remap = new Uint32Array(n);
    const out = [];
    for (let k = 0; k < n; k++) {
      const key = `${p[k * 3]},${p[k * 3 + 1]},${p[k * 3 + 2]}`;
      let r = map.get(key);
      if (r === undefined) {
        r = out.length / 3;
        map.set(key, r);
        out.push(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]);
      }
      remap[k] = r;
    }
    if (out.length === p.length && v.indices) return;
    removedVerts += n - out.length / 3;
    const set = (name, value) => {
      const a = el.attrs.find((x) => canonicalAttr(el, x) === name);
      if (a) a.value = value;
      else el.attrs.push(new Attr(name, value));
    };
    set('positions', formatNumberList(out, { sep: ' ' }));
    set('indices', Array.from(idx, (k) => remap[k]).join(' '));
  });
  if (removedVerts) report.push({ pass: 'weldMeshes', detail: `welded ${removedVerts} duplicate mesh vertices` });
}

function minifyPaths(root, report) {
  let n = 0;
  walkAll(root, (el) => {
    for (const a of el.attrs) {
      const k = canonicalAttr(el, a);
      const s = attrSpec(el.name, k);
      if (!s || s.type !== 'path2d' || !el.values || !el.values[k]) continue;
      const m = formatPathData(el.values[k].segments, { minify: true });
      if (m.length < a.value.length) {
        a.value = m;
        n++;
      }
    }
  });
  if (n) report.push({ pass: 'minifyPaths', detail: `rewrote ${n} path${n === 1 ? '' : 's'} with shorter commands` });
}

export const DEFAULT_OPTIONS = {
  stripDefaults: true,
  dedupeMaterials: true,
  extractRepeated: true,
  detectPatterns: true,
  collapseGroups: true,
  weldMeshes: true,
  minifyPaths: true,
  removeUnused: true,
};

/**
 * Optimize a validated document.
 * @returns {{doc: Document, report: {pass:string, detail:string}[], text: string}}
 */
export function optimize(doc, options = {}) {
  if (!doc.ok) throw new Error('Cannot optimize a document with errors.');
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const report = [];
  const root = cloneWithOrigin(doc.root);
  if (opts.stripDefaults) stripDefaults(root, report);
  if (opts.minifyPaths) minifyPaths(root, report);
  if (opts.weldMeshes) weldMeshes(root, report);
  if (opts.dedupeMaterials) dedupeMaterials(root, report);
  if (opts.detectPatterns) detectPatterns(root, report);
  if (opts.extractRepeated) extractRepeated(root, report);
  if (opts.collapseGroups) collapseGroups(root, report);
  if (opts.removeUnused) removeUnused(root, report);
  const out = new Document({ root, syntax: doc.syntax, leading: doc.leading, trailing: doc.trailing });
  const text = serialize(out, { syntax: doc.syntax === 'compact' ? 'compact' : 'xml', pretty: true });
  const reparsed = parse(text);
  if (!reparsed.ok) {
    throw new Error(`Optimizer produced an invalid document: ${reparsed.errors[0].message}`);
  }
  return { doc: reparsed, report, text };
}

// ---------------------------------------------------------------------------
// expansion (the inverse of procedural compression)

/**
 * Replace every <repeat> and <scatter> outside <defs> by explicit copies.
 * The result renders identically but stores one element per instance.
 */
export function expandProcedural(doc) {
  const root = cloneWithOrigin(doc.root);
  const expandNode = (el) => {
    for (const c of elementsOf(el)) expandNode(c);
    if (el.name !== 'repeat' && el.name !== 'scatter') return;
    for (let p = el.parent; p; p = p.parent) if (p.name === 'defs') return;
    const src = el.orig || el;
    const group = new Element('group');
    for (const a of el.attrs) {
      const k = canonicalAttr(el, a);
      if (PLACEMENT.includes(k) || k === 'material' || k === 'color' || k === 'visible') group.attrs.push(new Attr(k, a.value));
    }
    const kids = elementsOf(el).filter((c) => c.name !== 'animate');
    const anims = elementsOf(el).filter((c) => c.name === 'animate');
    const emit = (m, material) => {
      for (const k of kids) {
        const copy = cloneElement(k);
        // wrap when the copy has its own placement or style, so both are kept
        const hasPlacement = k.attrs.some((a) => PLACEMENT.includes(canonicalAttr(k, a)));
        const hasStyle = k.attrs.some((a) => ['material', 'color'].includes(canonicalAttr(k, a)));
        let node = copy;
        if (hasPlacement || (material && hasStyle)) {
          node = new Element('group');
          node.appendChild(copy);
        }
        setPlacement(node, m);
        if (material) node.attrs.push(new Attr('material', material));
        group.appendChild(node);
      }
    };
    if (el.name === 'repeat') {
      const count = valueOf(src, 'count');
      const step = src.values.step ? src.values.step.matrix : opsToMatrix([]);
      const acc = mat4.createF64();
      for (let i = 0; i < count; i++) {
        emit(acc, null);
        mat4.multiply(acc, acc, step);
      }
    } else {
      const v = src.values;
      const grid = v.grid || null;
      const count = grid ? grid[0] * grid[1] : v.count || 0;
      const spacing = valueOf(src, 'spacing');
      const jitter = valueOf(src, 'jitter');
      const rand = mulberry32(valueOf(src, 'seed'));
      const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;
      const u = new Float64Array(9);
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < 9; k++) u[k] = rand();
        const pos = [0, 0, 0];
        if (grid) {
          const ix = i % grid[0], iz = Math.floor(i / grid[0]);
          pos[0] = (ix - (grid[0] - 1) / 2) * spacing[0] + (u[0] - 0.5) * jitter * spacing[0];
          pos[2] = (iz - (grid[1] - 1) / 2) * spacing[1] + (u[1] - 0.5) * jitter * spacing[1];
        } else if (v.radius) {
          const r = v.radius * Math.sqrt(u[0]);
          const a = u[1] * Math.PI * 2;
          pos[0] = r * es3dCos(a);
          pos[2] = r * es3dSin(a);
        } else {
          pos[0] = (u[0] - 0.5) * v.area[0];
          pos[2] = (u[1] - 0.5) * v.area[1];
        }
        const rot = [0, 0, 0];
        if (v.randomRotation) for (let k = 0; k < 3; k++) rot[k] = lerp(v.randomRotation.ranges[k], u[2 + k]);
        let scl = [1, 1, 1];
        if (v.randomScale) {
          const r = v.randomScale.ranges;
          scl = v.randomScale.uniform ? [lerp(r[0], u[5]), lerp(r[0], u[5]), lerp(r[0], u[5])] : [lerp(r[0], u[5]), lerp(r[1], u[6]), lerp(r[2], u[7])];
        }
        let material = null;
        if (v.randomMaterial) material = v.randomMaterial[Math.min(v.randomMaterial.length - 1, Math.floor(u[8] * v.randomMaterial.length))];
        emit(mat4.compose(mat4.createF64(), pos, rot, scl), material);
      }
    }
    for (const a of anims) group.appendChild(a);
    const p = el.parent;
    const i = p.children.indexOf(el);
    group.parent = p;
    p.children.splice(i, 1, group);
  };
  expandNode(root);
  const out = new Document({ root, syntax: 'xml' });
  return serialize(out, { pretty: true });
}
