// Serialization of the ES3D AST to text.
//
//   serialize(doc, { syntax: 'xml' | 'compact' | 'json', pretty, aliases, precision, comments })
//
// pretty   : indentation, one element per line, comments kept (default true)
// aliases  : use the short attribute aliases (p, r, s, m, ...) (default !pretty)
// precision: quantize numbers to this many decimals (null = keep source values)
// normalize: re-format typed values canonically (implied by precision / !pretty)
//
// Without precision/normalize the original attribute strings are written
// unchanged, so load -> save is lossless.

import { elementSpec, attrSpec } from './schema.js';
import { formatNumber, formatNumberList, formatColor, formatTransformOps, formatPathData } from './value-format.js';
import { toJsonTree } from './json.js';

const PRESETS = {
  pretty: { pretty: true, aliases: false, precision: null, normalize: false, comments: true },
  minified: { pretty: false, aliases: true, precision: null, normalize: true, comments: false },
};

function resolveOptions(opts = {}) {
  const base = opts.pretty === false ? PRESETS.minified : PRESETS.pretty;
  const o = { syntax: 'xml', indent: '  ', wrap: 100, ...base, ...opts };
  if (o.precision !== null && o.precision !== undefined) o.normalize = true;
  return o;
}

/** Canonical (or aliased) attribute name for output. */
function outName(elName, canonical, opts) {
  if (!opts.aliases) return canonical;
  const spec = attrSpec(elName, canonical);
  return spec && spec.alias ? spec.alias : canonical;
}

function canonicalName(el, a) {
  if (el.attrIndex) {
    for (const [k, v] of Object.entries(el.attrIndex)) if (v === a) return k;
  }
  const spec = elementSpec(el.name);
  if (!spec) return a.name;
  if (spec.attrs[a.name]) return a.name;
  for (const [k, s] of Object.entries(spec.attrs)) if (s.alias === a.name) return k;
  return a.name;
}

const allEqual = (v) => v.every((x) => x === v[0]);

/** Format an attribute value, re-encoding typed values when normalizing. */
export function formatAttrValue(el, canonical, raw, opts) {
  if (!opts.normalize) return raw;
  const spec = attrSpec(el.name, canonical);
  const v = el.values ? el.values[canonical] : undefined;
  if (!spec || v === undefined) return raw.trim();
  const p = opts.precision;
  const c = !opts.pretty;
  switch (spec.type) {
    case 'number':
    case 'angle':
      return formatNumber(v, p, c);
    case 'int':
      return String(v);
    case 'vec2':
    case 'vec3':
    case 'vec4':
    case 'numbers':
    case 'animValue':
      return formatNumberList(v, { sep: ',', precision: p, compact: c });
    case 'keyframes':
      return v.map((k) => formatNumberList(k, { sep: ',', precision: p, compact: c })).join(c ? ';' : '; ');
    case 'size2':
    case 'size3':
    case 'scale3':
      return allEqual(v) ? formatNumber(v[0], p, c) : formatNumberList(v, { sep: ',', precision: p, compact: c });
    case 'count2':
      return v.join(',');
    case 'points2':
      return formatNumberList(v, { group: 2, precision: p, compact: c });
    case 'points3':
      return formatNumberList(v, { group: 3, precision: p, compact: c });
    case 'floats':
      return formatNumberList(v, { sep: ' ', precision: p, compact: c });
    case 'indices':
      return Array.from(v).join(' ');
    case 'color': {
      const hex = formatColor(v);
      const r = raw.trim();
      return r.length < hex.length ? r : hex;
    }
    case 'ref':
    case 'id':
    case 'enum':
    case 'string':
      return String(v);
    case 'bool':
      return v ? 'true' : 'false';
    case 'transform':
      return formatTransformOps(v.ops, p, c);
    case 'path2d':
      return formatPathData(v.segments, { precision: p, minify: c, dim: 2 });
    case 'spine':
      if (v.kind === 'path') return formatPathData(v.segments, { precision: p, minify: c, dim: 3 });
      if (v.kind === 'points') return formatNumberList(v.points, { group: 3, precision: p, compact: c });
      return `helix(${[v.radius, v.pitch, v.turns, ...(v.segmentsPerTurn ? [v.segmentsPerTurn] : [])].map((x) => formatNumber(x, p, c)).join(',')})`;
    case 'range': {
      const [a, b] = v;
      return a === b ? formatNumber(a, p, c) : `${formatNumber(a, p, c)}..${formatNumber(b, p, c)}`;
    }
    case 'range3': {
      const f = ([a, b]) => (a === b ? formatNumber(a, p, c) : `${formatNumber(a, p, c)}..${formatNumber(b, p, c)}`);
      return v.ranges.map(f).join(',');
    }
    case 'idlist':
      return v.join(',');
    case 'duration':
      return formatNumber(v, p, c) + 's';
    case 'repeatCount':
      return v === Infinity ? 'indefinite' : formatNumber(v, p, c);
    default:
      return raw.trim();
  }
}

// ---------------------------------------------------------------------------
// markup syntax

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
function escText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlComment(text) {
  return `<!--${text.replace(/--/g, '- -').replace(/-$/, '- ')}-->`;
}

function attrPairs(el, opts) {
  const out = [];
  for (const a of el.attrs) {
    const canonical = canonicalName(el, a);
    out.push([outName(el.name, canonical, opts), formatAttrValue(el, canonical, a.value, opts), canonical]);
  }
  return out;
}

function serializeXml(doc, opts) {
  const lines = [];
  const ind = (d) => opts.indent.repeat(d);
  if (opts.pretty) {
    if (opts.comments) for (const c of doc.leading) lines.push(xmlComment(c.text));
    const emit = (el, depth) => {
      const pairs = attrPairs(el, opts);
      const attrsInline = pairs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
      const kids = el.children.filter((c) => c.type === 'element' || opts.comments);
      const hasText = el.text !== null && el.text !== undefined && el.text.trim() !== '';
      let open = `${ind(depth)}<${el.name}${attrsInline}`;
      if (open.length + 2 > opts.wrap && pairs.length > 1) {
        open = `${ind(depth)}<${el.name}` + pairs.map(([k, v]) => `\n${ind(depth + 2)}${k}="${escAttr(v)}"`).join('');
      }
      if (!kids.length && !hasText) {
        lines.push(open + '/>');
        return;
      }
      if (hasText && !kids.length) {
        lines.push(`${open}>${escText(el.text.trim())}</${el.name}>`);
        return;
      }
      lines.push(open + '>');
      if (hasText) lines.push(ind(depth + 1) + escText(el.text.trim()));
      for (const c of kids) {
        if (c.type === 'comment') lines.push(ind(depth + 1) + xmlComment(c.text));
        else emit(c, depth + 1);
      }
      lines.push(`${ind(depth)}</${el.name}>`);
    };
    emit(doc.root, 0);
    if (opts.comments) for (const c of doc.trailing) lines.push(xmlComment(c.text));
    return lines.join('\n') + '\n';
  }
  // minified
  let out = '';
  const emit = (el) => {
    out += '<' + el.name;
    for (const [k, v] of attrPairs(el, opts)) out += ` ${k}="${escAttr(v)}"`;
    const kids = el.children.filter((c) => c.type === 'element' || opts.comments);
    const hasText = el.text !== null && el.text !== undefined && el.text.trim() !== '';
    if (!kids.length && !hasText) {
      out += '/>';
      return;
    }
    out += '>';
    if (hasText) out += escText(el.text.trim());
    for (const c of kids) {
      if (c.type === 'comment') out += xmlComment(c.text);
      else emit(c);
    }
    out += `</${el.name}>`;
  };
  emit(doc.root);
  return out;
}

// ---------------------------------------------------------------------------
// compact syntax

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function quoteCompact(v) {
  if (v !== '' && !/[\s{};"\\]/.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function compactComment(text, pretty) {
  if (pretty && !text.includes('\n')) return '//' + (text.startsWith(' ') ? '' : ' ') + text.replace(/\s+$/, '');
  return '/*' + text.replace(/\*\//g, '* /') + '*/';
}

function compactHeader(el, opts) {
  let s = el.name;
  const rest = [];
  for (const [k, v, canonical] of attrPairs(el, opts)) {
    if (canonical === 'id' && NAME_RE.test(v)) s += '#' + v;
    else if (canonical === 'ref' && NAME_RE.test(v)) rest.unshift('@' + v);
    else rest.push(`${k}=${quoteCompact(v)}`);
  }
  const hasText = el.text !== null && el.text !== undefined && el.text.trim() !== '';
  if (hasText) {
    const t = el.text.trim();
    rest.unshift('"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"');
  }
  return rest.length ? s + ' ' + rest.join(' ') : s;
}

function serializeCompact(doc, opts) {
  if (opts.pretty) {
    const lines = [];
    const ind = (d) => opts.indent.repeat(d);
    if (opts.comments) for (const c of doc.leading) lines.push(compactComment(c.text, true));
    const emitChildren = (el, depth) => {
      for (const c of el.children) {
        if (c.type === 'comment') {
          if (opts.comments) lines.push(ind(depth) + compactComment(c.text, true));
          continue;
        }
        const kids = c.children.filter((k) => k.type === 'element' || opts.comments);
        const head = ind(depth) + compactHeader(c, opts);
        if (!kids.length) lines.push(head);
        else {
          lines.push(head + ' {');
          emitChildren(c, depth + 1);
          lines.push(ind(depth) + '}');
        }
      }
    };
    lines.push(compactHeader(doc.root, opts));
    emitChildren(doc.root, 0);
    if (opts.comments) for (const c of doc.trailing) lines.push(compactComment(c.text, true));
    return lines.join('\n') + '\n';
  }
  const parts = [];
  const emit = (el) => {
    let s = compactHeader(el, opts);
    const kids = el.children.filter((k) => k.type === 'element' || opts.comments);
    if (kids.length) {
      const inner = [];
      for (const c of kids) inner.push(c.type === 'comment' ? compactComment(c.text, false) : emit(c));
      s += '{' + joinStatements(inner) + '}';
    }
    return s;
  };
  parts.push(compactHeader(doc.root, opts));
  for (const c of doc.root.children) {
    if (c.type === 'comment') {
      if (opts.comments) parts.push(compactComment(c.text, false));
    } else parts.push(emit(c));
  }
  return joinStatements(parts);
}

/** Join compact statements; a separator is needed only between two plain headers. */
function joinStatements(items) {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      if (!prev.endsWith('}') && !prev.endsWith('*/')) out += ';';
    }
    out += s;
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Serialize a document.
 * @param {import('./ast.js').Document} doc
 * @param {object} [options]
 * @returns {string}
 */
export function serialize(doc, options = {}) {
  const opts = resolveOptions(options);
  if (!doc.root) throw new Error('Cannot serialize a document without a root element.');
  if (opts.syntax === 'compact') return serializeCompact(doc, opts);
  if (opts.syntax === 'json') {
    const workDoc = opts.normalize ? normalizedCopy(doc, opts) : doc;
    const tree = toJsonTree(workDoc, { comments: opts.comments });
    return opts.pretty ? JSON.stringify(tree, null, 1) + '\n' : JSON.stringify(tree);
  }
  return serializeXml(doc, opts);
}

/** Copy of the AST where attribute values are already formatted per opts. */
function normalizedCopy(doc, opts) {
  const clone = (el) => {
    const pairs = attrPairs(el, opts);
    return {
      ...el,
      attrs: pairs.map(([k, v]) => ({ name: k, value: v })),
      children: el.children.map((c) => (c.type === 'element' ? clone(c) : c)),
    };
  };
  return { ...doc, root: clone(doc.root) };
}

export const SERIALIZE_PRESETS = {
  'xml-pretty': { syntax: 'xml', pretty: true },
  'xml-min': { syntax: 'xml', pretty: false },
  'compact-pretty': { syntax: 'compact', pretty: true },
  'compact-min': { syntax: 'compact', pretty: false },
  'json-min': { syntax: 'json', pretty: false },
};
