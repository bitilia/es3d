// Schema validation and reference resolution.
//
// Converts raw attribute strings into typed values (element.values), checks
// element nesting, numeric ranges and cross-attribute rules, verifies every id
// reference and detects circular <use> chains. All problems are collected (not
// just the first) and reported with exact source positions and suggestions.

import { DiagnosticList, suggest } from './errors.js';
import { indexTree } from './ast.js';
import { ELEMENTS, ROOT_ELEMENTS, SHAPES, CONTAINERS, aliasesFor, elementSpec, ALL_ELEMENT_NAMES } from './schema.js';
import { parseTyped } from './values.js';
import { ValueError } from './value-error.js';

const USABLE = new Set([...SHAPES, ...CONTAINERS, 'use', 'light']);

function elementPath(el) {
  const parts = [];
  for (let e = el; e; e = e.parent) {
    let label = e.name;
    if (e.parent) {
      let index = -1, same = 0;
      for (const c of e.parent.children) {
        if (c.type !== 'element' || c.name !== e.name) continue;
        if (c === e) index = same;
        same++;
      }
      if (same > 1) label += `[${index}]`;
    }
    const id = e.attr && e.attr('id');
    if (id) label += `#${id}`;
    parts.unshift(label);
  }
  return parts.join(' > ');
}

function describeNumber(spec) {
  const parts = [];
  if (spec.exclusiveMin !== undefined) parts.push(`greater than ${spec.exclusiveMin}`);
  else if (spec.min !== undefined) parts.push(`at least ${spec.min}`);
  if (spec.max !== undefined) parts.push(`at most ${spec.max}`);
  return parts.join(' and ');
}

function checkNumeric(spec, value) {
  if (typeof value !== 'number') return null;
  if (spec.exclusiveMin !== undefined && !(value > spec.exclusiveMin)) return describeNumber(spec);
  if (spec.min !== undefined && value < spec.min) return describeNumber(spec);
  if (spec.max !== undefined && value > spec.max) return describeNumber(spec);
  return null;
}

/**
 * Validate a parsed document in place.
 * Sets el.values / el.attrIndex, doc.ids and doc.diagnostics.
 * @returns {import('./ast.js').Document}
 */
const REQUIRED = new WeakMap();

/** Names of an element's required attributes, in schema order (computed once per element type). */
function requiredAttrs(spec) {
  let list = REQUIRED.get(spec);
  if (!list) {
    list = Object.entries(spec.attrs).filter(([, a]) => a.required).map(([name]) => name);
    REQUIRED.set(spec, list);
  }
  return list;
}

export function validate(doc) {
  const diags = new DiagnosticList(doc.lineIndex);
  indexTree(doc);
  doc.ids = new Map();
  const refs = []; // {el, attr, id, kind, list?}

  const locEl = (el) => (el.nameStart >= 0 ? { offset: el.nameStart, length: el.nameEnd - el.nameStart } : { offset: -1, length: 0, path: elementPath(el) });
  const locAttrName = (el, a) => (a && a.nameStart >= 0 ? { offset: a.nameStart, length: a.nameEnd - a.nameStart } : locEl(el));
  const locAttrValue = (el, a, e) => {
    if (!a || a.valueStart < 0) return locEl(el);
    if (e && !a.decoded && e.offset !== undefined) {
      const off = Math.min(a.valueStart + e.offset, a.valueEnd);
      const len = Math.max(1, Math.min(e.length || 1, a.valueEnd - off));
      return { offset: off, length: len };
    }
    return { offset: a.valueStart, length: Math.max(1, a.valueEnd - a.valueStart) };
  };
  const report = (severity, code, message, loc, extra = {}, el = null) => {
    diags.add({ severity, code, message, offset: loc.offset, length: loc.length, path: loc.path || (loc.offset < 0 && el ? elementPath(el) : null), uid: el ? el.uid : 0, ...extra });
  };

  const root = doc.root;
  if (!ROOT_ELEMENTS.includes(root.name)) {
    report('error', 'E_ROOT', `The root element must be <es3d> but found <${root.name}>.`, locEl(root), { suggestion: 'es3d' }, root);
    doc.diagnostics = diags.sorted();
    return doc;
  }
  if (root.name === 'v3d') {
    report('warning', 'W_LEGACY_ROOT', 'The root element <v3d> is a legacy alias; write <es3d>.', locEl(root), {}, root);
  }

  let sceneCount = 0;
  let envCount = 0;
  let controlsCount = 0;

  const visit = (el, parentSpec, inDefs) => {
    const spec = elementSpec(el.name);
    if (!spec) {
      if (el.name.startsWith('x-')) {
        report('warning', 'W_EXTENSION', `Extension element <${el.name}> is not supported by this reader; it and its children are not rendered.`, locEl(el), {}, el);
      } else {
        report('error', 'E_UNKNOWN_ELEMENT', `Unknown element: ${el.name}`, locEl(el), { suggestion: suggest(el.name, ALL_ELEMENT_NAMES.concat(['es3d'])) }, el);
      }
      el.values = {};
      el.attrIndex = {};
      el.unknown = true;
      return;
    }
    el.unknown = false;
    if (el.name === 'scene' && ++sceneCount > 1) report('error', 'E_MULTIPLE_SCENES', 'Only one <scene> element is allowed.', locEl(el), {}, el);
    if (el.name === 'environment' && ++envCount > 1) {
      report('warning', 'W_MULTIPLE_ENVIRONMENTS', 'More than one <environment>: only the first one is used.', locEl(el), {}, el);
    }
    if (el.name === 'controls' && ++controlsCount > 1) {
      report('warning', 'W_MULTIPLE_CONTROLS', 'More than one <controls>: only the first one is used.', locEl(el), {}, el);
    }

    // attributes
    const aliases = aliasesFor(el.name);
    const values = {};
    const attrIndex = {};
    for (const a of el.attrs) {
      const canonical = aliases.get(a.name);
      if (!canonical) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const candidates = [...aliases.keys()];
        const sug = suggest(a.name, candidates);
        let hint = null;
        if (!sug) {
          const own = Object.keys(spec.attrs).filter((k) => !['id', 'name', 'transform', 'position', 'rotation', 'scale', 'visible', 'material', 'color'].includes(k));
          if (own.length) hint = `<${el.name}> accepts: ${own.join(', ')} (plus id, name, transform, position, rotation, scale, material, color).`;
        }
        report('error', 'E_UNKNOWN_ATTRIBUTE', `Unknown attribute: ${a.name}`, locAttrName(el, a), { suggestion: sug, hint }, el);
        continue;
      }
      if (attrIndex[canonical]) {
        report('error', 'E_DUPLICATE_ATTRIBUTE', `Attribute '${canonical}' is given twice (as '${attrIndex[canonical].name}' and '${a.name}').`, locAttrName(el, a), {}, el);
        continue;
      }
      attrIndex[canonical] = a;
      const aspec = spec.attrs[canonical];
      let value;
      try {
        value = a.typed !== undefined ? a.typed : parseTyped(aspec, a.value);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        report('error', e.code || 'E_INVALID_VALUE', `Invalid value for '${a.name}': ${e.message}`, locAttrValue(el, a, e), { suggestion: e.suggestion, hint: e.hint }, el);
        continue;
      }
      const bad = checkNumeric(aspec, value);
      if (bad) {
        report('error', 'E_RANGE', `'${a.name}' must be ${bad}; found ${value}.`, locAttrValue(el, a), {}, el);
        continue;
      }
      values[canonical] = value;
      if (aspec.type === 'id' && canonical === 'id') {
        const prev = doc.ids.get(value);
        if (prev) {
          let where = '';
          if (prev.nameStart >= 0 && doc.lineIndex) {
            const p = doc.lineIndex.position(prev.nameStart);
            where = ` (first defined at line ${p.line})`;
          }
          report('error', 'E_DUPLICATE_ID', `Duplicate id '${value}'${where}.`, locAttrValue(el, a), {}, el);
        } else {
          doc.ids.set(value, el);
        }
      }
      if (aspec.type === 'ref') refs.push({ el, attr: a, canonical, id: value, kind: aspec.ref });
      if (aspec.type === 'idlist' && aspec.ref) for (const id of value) refs.push({ el, attr: a, canonical, id, kind: aspec.ref });
    }
    el.values = values;
    el.attrIndex = attrIndex;

    for (const name of requiredAttrs(spec)) {
      if (values[name] === undefined && !attrIndex[name]) {
        report('error', 'E_MISSING_ATTRIBUTE', `<${el.name}> requires the attribute '${name}'.`, locEl(el), { hint: spec.attrs[name].desc }, el);
      }
    }
    if (spec.check) {
      // attributes that are present but failed to parse count as given, so
      // cross-attribute rules do not cascade into "missing attribute" errors
      const given = (k) => values[k] !== undefined || !!attrIndex[k];
      spec.check(values, (attrName, message, code = 'E_INVALID_VALUE') => {
        const a = attrName ? attrIndex[attrName] : null;
        report('error', code, message, a ? locAttrValue(el, a) : locEl(el), {}, el);
      }, el, given);
    }

    // text content
    if (el.text !== null && el.text.trim() !== '' && spec.children !== 'text') {
      const loc = el.textStart >= 0 ? { offset: el.textStart, length: Math.max(1, Math.min(20, el.textEnd - el.textStart)) } : locEl(el);
      report('error', 'E_TEXT_NOT_ALLOWED', `Text content is not allowed inside <${el.name}>.`, loc, {}, el);
    }

    if (inDefs && el.parent && el.parent.name === 'defs' && values.id === undefined && !attrIndex.id) {
      report('warning', 'W_DEF_WITHOUT_ID', `<${el.name}> inside <defs> has no id, so it can never be used.`, locEl(el), {}, el);
    }
    if (el.name === 'material' && values.id === undefined && !attrIndex.id) {
      report('warning', 'W_MATERIAL_WITHOUT_ID', '<material> without an id can never be referenced.', locEl(el), {}, el);
    }

    // children
    const allowed = spec.children;
    for (const c of el.children) {
      if (c.type !== 'element') continue;
      if (allowed === 'text' || !Array.isArray(allowed) || !allowed.includes(c.name)) {
        const childSpec = elementSpec(c.name);
        if (childSpec || !c.name.startsWith('x-')) {
          if (childSpec) {
            let hint = null;
            if (c.name === 'animate') hint = '<animate> can only be placed inside an element with a transform (shapes, group, use, repeat, scatter, lod, light, camera).';
            else if (c.name === 'scene' || c.name === 'defs') hint = `<${c.name}> is only allowed directly inside <es3d>.`;
            else if (c.name === 'controls') hint = '<controls> is only allowed directly inside <es3d> or <scene>.';
            else if (spec.category === 'shape') hint = 'Shapes cannot contain other shapes; wrap them in a <group>.';
            report('error', 'E_MISPLACED_ELEMENT', `<${c.name}> is not allowed inside <${el.name}>.`, locEl(c), { hint }, c);
          }
        }
      }
      visit(c, spec, inDefs || el.name === 'defs');
    }
  };
  visit(root, null, false);

  // references ---------------------------------------------------------------
  const kindLabel = { material: 'material', path: 'path', node: 'element' };
  for (const r of refs) {
    const target = doc.ids.get(r.id);
    // computed only when reporting: element paths are expensive for large binary documents
    const where = () => (r.attr.valueStart >= 0 ? { offset: r.attr.valueStart, length: Math.max(1, r.attr.valueEnd - r.attr.valueStart) } : locEl(r.el));
    if (!target) {
      const loc = where();
      const candidates = [...doc.ids.entries()]
        .filter(([, t]) => (r.kind === 'material' ? t.name === 'material' : r.kind === 'path' ? t.name === 'path' : USABLE.has(t.name)))
        .map(([id]) => id);
      diags.add({
        phase: 'reference',
        code: 'E_UNKNOWN_REFERENCE',
        message: `Unknown ${kindLabel[r.kind]} '${r.id}' referenced by ${r.attr.name}.`,
        offset: loc.offset,
        length: loc.length,
        path: loc.path || null,
        suggestion: suggest(r.id, candidates),
        uid: r.el.uid,
      });
      continue;
    }
    let ok = true;
    if (r.kind === 'material') ok = target.name === 'material';
    else if (r.kind === 'path') ok = target.name === 'path';
    else if (r.kind === 'node') ok = USABLE.has(target.name);
    if (!ok) {
      const loc = where();
      diags.add({
        phase: 'reference',
        code: 'E_REFERENCE_KIND',
        message: `${r.attr.name}="${r.id}" refers to a <${target.name}>, but a ${r.kind === 'node' ? 'shape, group, use, repeat, scatter, lod or light' : `<${r.kind}>`} is required.`,
        offset: loc.offset,
        length: loc.length,
        path: loc.path || null,
        uid: r.el.uid,
      });
      continue;
    }
    if (r.canonical === 'ref') r.el.target = target;
    if (r.kind === 'path') r.el.pathTarget = target;
  }

  // circular <use> chains ------------------------------------------------------
  const usesInside = new Map();
  const collectUses = (el) => {
    if (usesInside.has(el)) return usesInside.get(el);
    const list = [];
    const stack = [el];
    while (stack.length) {
      const e = stack.pop();
      if (e.name === 'use' && e.target) list.push(e);
      for (const c of e.children) if (c.type === 'element') stack.push(c);
    }
    usesInside.set(el, list);
    return list;
  };
  const state = new Map(); // target -> 1 visiting, 2 done
  const reported = new Set();
  const dfs = (target, chain) => {
    state.set(target, 1);
    for (const u of collectUses(target)) {
      const t = u.target;
      const st = state.get(t);
      if (st === 1) {
        if (!reported.has(u)) {
          reported.add(u);
          const ids = [...chain.map((x) => x.values.id || x.name), t.values.id || t.name];
          const a = u.attrIndex.ref;
          diags.add({
            phase: 'reference',
            code: 'E_CIRCULAR_REFERENCE',
            message: `Circular reference: ${ids.join(' → ')}.`,
            offset: a && a.valueStart >= 0 ? a.valueStart : u.nameStart,
            length: a && a.valueStart >= 0 ? a.valueEnd - a.valueStart : u.nameEnd - u.nameStart,
            path: u.nameStart < 0 ? elementPath(u) : null,
            hint: 'An element cannot (directly or indirectly) contain a <use> of itself.',
            uid: u.uid,
          });
        }
        u.circular = true;
      } else if (!st) {
        dfs(t, [...chain, t]);
      }
    }
    state.set(target, 2);
  };
  for (const target of new Set([...doc.ids.values()])) {
    if (!state.has(target)) dfs(target, [target]);
  }
  // uses outside any referenced subtree (e.g. in the scene) that point into a cycle are covered above.

  doc.diagnostics = diags.sorted();
  return doc;
}

export { elementPath, ELEMENTS };
