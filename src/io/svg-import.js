// SVG to ES3D: flat vector drawings become 3D relief models.
//
// SVG path data is ES3D path data, so the drawing's curves survive exactly:
// every filled shape becomes an <extrude> of its outline (a flat <path> when
// the depth is 0), every stroke a round tube (<polyline d="…" radius="…">)
// lying on the shape's front face. Shapes are stacked in document order, so
// later shapes sit on top of earlier ones, and colors become shared
// <material>s. Transforms are baked into the coordinates; SVG's y axis points
// down and ES3D's up, so the drawing is flipped, centred and scaled to a
// chosen size.
//
// Supported: path, rect, circle, ellipse, line, polyline, polygon, g, svg, a,
// switch, use/symbol; transform attributes; presentation attributes, style=""
// and <style> sheets with simple selectors (tag, .class, #id, tag.class, *);
// fill, stroke, opacity, fill-opacity, stroke-opacity, fill-rule,
// stroke-width, display, visibility, color; named, hex, rgb() and hsl()
// colors. Gradients and patterns become their average color; text, images,
// filters, masks, clip paths, markers and dashes are skipped with a warning.

import { parseXml } from '../format/xml-parser.js';
import { ES3DError } from '../format/errors.js';
import { parsePathData } from '../path/path-parser.js';
import { arcToCenter } from '../path/path-flatten.js';
import { formatPathData, formatNumber } from '../format/value-format.js';
import { parseColor, colorToHex } from '../format/colors.js';
import { h, Document, Comment } from '../format/ast.js';
import { serialize } from '../format/serializer.js';

// ---------------------------------------------------------------------------
// 2D affine matrices [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f

const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const det = (m) => m[0] * m[3] - m[1] * m[2];

/** Uniform scale + rotation (+ mirror): arcs can then be transformed exactly. */
function similarity(m) {
  const [a, b, c, d] = m;
  const dt = a * d - b * c;
  if (!(Math.abs(dt) > 1e-300)) return null;
  const s = Math.sqrt(Math.abs(dt));
  const tol = 1e-9 * s;
  const ok = dt > 0 ? Math.abs(a - d) <= tol && Math.abs(b + c) <= tol : Math.abs(a + d) <= tol && Math.abs(b - c) <= tol;
  return ok ? { scale: s, angle: (Math.atan2(b, a) * 180) / Math.PI, flip: dt < 0 } : null;
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
const numbersIn = (s) => (String(s).match(NUMBER) || []).map(Number);

/** SVG transform list; null when the syntax is invalid. */
export function parseSvgTransform(str) {
  let m = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy;
  let match;
  let end = 0;
  while ((match = re.exec(str))) {
    end = re.lastIndex;
    const v = numbersIn(match[2]);
    const rad = (deg) => (deg * Math.PI) / 180;
    let t;
    switch (match[1]) {
      case 'matrix':
        if (v.length !== 6) return null;
        t = v;
        break;
      case 'translate':
        if (v.length < 1 || v.length > 2) return null;
        t = [1, 0, 0, 1, v[0], v[1] || 0];
        break;
      case 'scale':
        if (v.length < 1 || v.length > 2) return null;
        t = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
        break;
      case 'rotate': {
        if (v.length !== 1 && v.length !== 3) return null;
        const c = Math.cos(rad(v[0])), s = Math.sin(rad(v[0]));
        t = [c, s, -s, c, 0, 0];
        if (v.length === 3) t = mul(mul([1, 0, 0, 1, v[1], v[2]], t), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      }
      case 'skewX':
        if (v.length !== 1) return null;
        t = [1, 0, Math.tan(rad(v[0])), 1, 0, 0];
        break;
      case 'skewY':
        if (v.length !== 1) return null;
        t = [1, Math.tan(rad(v[0])), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  if (str.slice(end).trim() !== '') return null;
  return m;
}

// ---------------------------------------------------------------------------
// path segments (the absolute form produced by parsePathData)

function arcToCubics(s) {
  const arc = arcToCenter(s.x0, s.y0, s.rx, s.ry, s.rot, s.large, s.sweep, s.x, s.y);
  if (!arc) return [{ c: 'L', x: s.x, y: s.y }];
  const phi = (s.rot * Math.PI) / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const n = Math.max(1, Math.ceil(Math.abs(arc.dtheta) / (Math.PI / 2) - 1e-9));
  const dt = arc.dtheta / n;
  const k = (4 / 3) * Math.tan(dt / 4);
  const deriv = (t) => [-arc.rx * cosP * Math.sin(t) - arc.ry * sinP * Math.cos(t), -arc.rx * sinP * Math.sin(t) + arc.ry * cosP * Math.cos(t)];
  const out = [];
  let t = arc.theta1;
  let px = s.x0, py = s.y0;
  for (let i = 0; i < n; i++) {
    const t2 = t + dt;
    const [qx, qy] = i === n - 1 ? [s.x, s.y] : arc.pointAt(t2);
    const d1 = deriv(t), d2 = deriv(t2);
    out.push({ c: 'C', x1: px + k * d1[0], y1: py + k * d1[1], x2: qx - k * d2[0], y2: qy - k * d2[1], x: qx, y: qy });
    px = qx;
    py = qy;
    t = t2;
  }
  return out;
}

/** Apply an affine transform to segments; arcs stay arcs under similarity transforms, else become cubics. */
function transformSegments(segs, m) {
  const sim = similarity(m);
  const out = [];
  for (const s of segs) {
    switch (s.c) {
      case 'M':
      case 'L': {
        const [x, y] = apply(m, s.x, s.y);
        out.push({ c: s.c, x, y, implicit: s.implicit });
        break;
      }
      case 'C': {
        const [x1, y1] = apply(m, s.x1, s.y1), [x2, y2] = apply(m, s.x2, s.y2), [x, y] = apply(m, s.x, s.y);
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        break;
      }
      case 'Q': {
        const [x1, y1] = apply(m, s.x1, s.y1), [x, y] = apply(m, s.x, s.y);
        out.push({ c: 'Q', x1, y1, x, y });
        break;
      }
      case 'A': {
        if (sim) {
          const [x0, y0] = apply(m, s.x0, s.y0), [x, y] = apply(m, s.x, s.y);
          let rot = sim.flip ? sim.angle - s.rot : sim.angle + s.rot;
          rot = ((rot % 360) + 360) % 360;
          out.push({ c: 'A', rx: s.rx * sim.scale, ry: s.ry * sim.scale, rot, large: s.large, sweep: sim.flip ? 1 - s.sweep : s.sweep, x0, y0, x, y });
        } else {
          for (const cub of arcToCubics(s)) out.push(...transformSegments([cub], m));
        }
        break;
      }
      case 'Z':
        out.push({ c: 'Z' });
        break;
    }
  }
  return out;
}

/** Control points of the segments (arcs as cubics): a conservative outline for bounds and area. */
function controlPolygons(segs) {
  const polys = [];
  let cur = null;
  for (const s of segs) {
    if (s.c === 'M') {
      cur = [s.x, s.y];
      polys.push(cur);
    } else if (s.c === 'Z') {
      cur = null;
    } else {
      if (!cur) {
        cur = [];
        polys.push(cur);
      }
      const parts = s.c === 'A' ? arcToCubics(s) : [s];
      for (const p of parts) {
        if (p.c === 'C') cur.push(p.x1, p.y1, p.x2, p.y2, p.x, p.y);
        else if (p.c === 'Q') cur.push(p.x1, p.y1, p.x, p.y);
        else cur.push(p.x, p.y);
      }
    }
  }
  return polys;
}

function polygonArea(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

// ---------------------------------------------------------------------------
// styles

const INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'visibility', 'color'];
const STYLE_PROPS = new Set([...INHERITED, 'opacity', 'display', 'transform']);
const DEFAULT_STYLE = { fill: 'black', 'fill-opacity': '1', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-opacity': '1', 'stroke-width': '1', 'stroke-dasharray': 'none', visibility: 'visible', color: 'black' };

function parseDeclarations(text) {
  const out = {};
  for (const decl of String(text).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).replace(/!important/i, '').trim();
    if (prop && value) out[prop] = value;
  }
  return out;
}

const SIMPLE_SELECTOR = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/;

/** CSS rules with simple selectors; anything more complex is counted as unsupported. */
export function parseCss(text) {
  const rules = [];
  let unsupported = 0;
  const src = String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@[\w-]+[^{;]*;/g, '');
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const prelude = src.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < src.length && depth) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith('@')) {
      // @media and friends: use the inner rules, whatever the query says
      const inner = parseCss(body);
      rules.push(...inner.rules);
      unsupported += inner.unsupported;
      continue;
    }
    const decls = parseDeclarations(body);
    for (const raw of prelude.split(',')) {
      const sel = raw.trim();
      const m = SIMPLE_SELECTOR.exec(sel);
      if (!sel || !m) {
        if (sel) unsupported++;
        continue;
      }
      const tag = m[1] && m[1] !== '*' ? m[1].toLowerCase() : null;
      const classes = [], ids = [];
      for (const part of m[2].match(/[.#][\w-]+/g) || []) (part[0] === '.' ? classes : ids).push(part.slice(1));
      rules.push({ tag, classes, ids, specificity: ids.length * 100 + classes.length * 10 + (tag ? 1 : 0), decls });
    }
  }
  rules.forEach((r, k) => (r.order = k));
  return { rules, unsupported };
}

function hslToRgb(hue, s, l) {
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

/** sRGB color [r, g, b, a] or null. */
export function parseSvgColor(value) {
  const v = String(value).trim();
  const c = parseColor(v);
  if (c) return c;
  const m = /^hsla?\(\s*([^)]*)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (p.length < 3) return null;
    const hue = parseFloat(p[0]), s = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
    let a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    if (![hue, s, l, a].every(Number.isFinite)) return null;
    a = Math.max(0, Math.min(1, a));
    return [...hslToRgb(((hue % 360) + 360) % 360, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l))), a];
  }
  return null;
}

// ---------------------------------------------------------------------------

const UNITS = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8, q: 96 / 101.6 };

/** A length in px; `ref` resolves percentages. */
function parseLength(value, ref = 0) {
  if (value === undefined || value === null) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!unit) return n;
  if (unit === '%') return (n / 100) * ref;
  return UNITS[unit] !== undefined ? n * UNITS[unit] : null;
}

const SKIPPED_ELEMENTS = {
  text: 'text (convert text to paths in your drawing program first)',
  image: 'embedded images',
  foreignObject: 'foreign objects',
  video: 'video',
  audio: 'audio',
  canvas: 'canvas',
  iframe: 'iframes',
};
const CONTAINERS = new Set(['g', 'svg', 'a', 'switch']);
const NEVER_RENDERED = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'filter', 'style', 'script', 'title', 'desc', 'metadata', 'font', 'font-face', 'cursor', 'view']);

const localName = (name) => {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
};

/** Remove a DOCTYPE and expand the simple entities it declares.

SVG files from Illustrator often declare a handful of short entities
(`ns_svg`, a style string). Those are expanded once. Nested entity
references inside a value are not expanded: that is the billion-laughs
trick, and SVG spent years paying for it. A single huge value, or a
pile of them, is refused. The external DTD URL is never fetched. */
function preprocess(text, warn) {
  let src = String(text).replace(/^\uFEFF/, '');
  const entities = new Map();
  let stopped = false;
  src = src.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i, (m, subset) => {
    if (subset) {
      for (const e of subset.matchAll(/<!ENTITY\s+([\w.-]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g)) {
        if (entities.size >= 32) {
          warn('This SVG declares more than 32 entities. The extras were ignored.');
          break;
        }
        const value = e[2] ?? e[3];
        if (value.length > 4096) {
          warn(`Entity &${e[1]}; is too long to expand, so it was left out.`);
          continue;
        }
        entities.set(e[1], value);
      }
    }
    return '';
  });
  const XML = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);
  const unknown = new Set();
  let expanded = 0;
  src = src.replace(/&([A-Za-z_][\w.-]*);/g, (m, name) => {
    if (XML.has(name)) return m;
    if (entities.has(name)) {
      if (stopped) return '';
      const value = entities.get(name);
      expanded += value.length;
      if (expanded > 200_000) {
        stopped = true;
        warn('Entity expansion was stopped because it grew past 200 kB.');
        return '';
      }
      // Escape "&" that is not already a predefined or numeric reference,
      // so "&b;" inside an entity value stays text and is not expanded again.
      return value.replace(/&(?!(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    }
    if (name === 'nbsp') return '&#160;';
    unknown.add(name);
    return '';
  });
  if (unknown.size) warn(`Unknown entities were removed: ${[...unknown].map((n) => `&${n};`).join(' ')}.`);
  return src;
}

/**
 * Convert an SVG document to ES3D.
 * @param {string} text SVG source
 * @param {{name?: string, size?: number, depth?: number, bevel?: number, strokes?: boolean, base?: boolean, precision?: number}} [opts]
 *        size: the longer side of the drawing in ES3D units; depth: extrusion depth as a fraction of size
 *        (0 = flat shapes); bevel: rounded edge radius as a fraction of size; strokes: convert strokes to
 *        tubes; base: add a backing plate the size of the viewBox; precision: decimals of the path data
 * @returns {{text: string, warnings: string[], stats: {shapes: number, fills: number, strokes: number, materials: number, skipped: number}}}
 */
export function svgToES3D(text, opts = {}) {
  const { name = 'drawing.svg', size = 10, depth: depthRel = 0.04, bevel: bevelRel = 0, strokes = true, base = false } = opts;
  const warnings = [];
  const warned = new Map();
  const warn = (msg) => warnings.push(msg);
  const warnOnce = (key, msg) => {
    warned.set(key, (warned.get(key) || 0) + 1);
    if (warned.get(key) === 1) warnings.push(msg);
  };

  let doc;
  try {
    doc = parseXml(preprocess(text, warn));
  } catch (e) {
    if (e instanceof ES3DError) {
      const d = e.diagnostics[0];
      throw new Error(`The SVG file is not well-formed XML (line ${d.line}, column ${d.column}): ${d.message}`);
    }
    throw e;
  }
  const svg = doc.root;
  if (localName(svg.name) !== 'svg') throw new Error(`Not an SVG file: the root element is <${svg.name}>, expected <svg>.`);

  // index ids and collect style sheets
  const byId = new Map();
  const sheets = [];
  const index = (el) => {
    const id = el.attr('id');
    if (id && !byId.has(id)) byId.set(id, el);
    if (localName(el.name) === 'style' && el.text) sheets.push(el.text);
    for (const c of el.children) if (c.type === 'element') index(c);
  };
  index(svg);
  const css = parseCss(sheets.join('\n'));
  if (css.unsupported) warn(`${css.unsupported} CSS selector${css.unsupported > 1 ? 's' : ''} more complex than tag, .class or #id ${css.unsupported > 1 ? 'were' : 'was'} ignored.`);

  // viewport: the viewBox, else width/height, else the drawing's own bounds
  const vb = numbersIn(svg.attr('viewBox') || '');
  const rootW = parseLength(svg.attr('width')), rootH = parseLength(svg.attr('height'));
  let frame = null;
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) frame = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  else if (rootW > 0 && rootH > 0) frame = { x: 0, y: 0, w: rootW, h: rootH };
  const refW = frame ? frame.w : 100, refH = frame ? frame.h : 100;
  const refD = Math.hypot(refW, refH) / Math.SQRT2;

  const titleEl = svg.children.find((c) => c.type === 'element' && localName(c.name) === 'title');
  const title = (titleEl && titleEl.text && titleEl.text.trim()) || name.replace(/\.svgz?$/i, '');

  // computed style of an element given its parent's
  const computeStyle = (el, parent) => {
    const tag = localName(el.name);
    const st = {};
    for (const k of INHERITED) st[k] = parent[k];
    st.opacity = parent.opacity; // group opacity multiplies down the tree (approximation)
    st.display = 'inline';
    const own = {};
    for (const a of el.attrs) {
      const k = localName(a.name);
      if (STYLE_PROPS.has(k) && k !== 'transform') own[k] = a.value;
    }
    const classes = (el.attr('class') || '').split(/\s+/).filter(Boolean);
    const id = el.attr('id');
    const matched = css.rules.filter((r) => (!r.tag || r.tag === tag) && r.classes.every((c) => classes.includes(c)) && r.ids.every((i) => i === id));
    matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    for (const r of matched) Object.assign(own, r.decls);
    if (el.attr('style')) Object.assign(own, parseDeclarations(el.attr('style')));
    for (const [k, v] of Object.entries(own)) {
      if (v === 'inherit') continue;
      if (k === 'opacity') st.opacity = parent.opacity * Math.max(0, Math.min(1, parseFloat(v)));
      else if (k in st || INHERITED.includes(k)) st[k] = v;
    }
    if (own.display) st.display = own.display;
    return st;
  };

  /** A paint value → {color, opacity} or null (no paint). */
  const resolvePaint = (value, st) => {
    let v = String(value).trim();
    if (v === 'none' || v === 'transparent') return null;
    if (/^currentcolor$/i.test(v)) v = st.color;
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(v);
    if (url) {
      const ref = byId.get(url[1]);
      const kind = ref && localName(ref.name);
      if (kind === 'linearGradient' || kind === 'radialGradient') {
        const stops = gradientStops(ref);
        if (stops.length) {
          warnOnce('gradient', 'Gradients were replaced by their average color.');
          const n = stops.length;
          const avg = stops.reduce((s, c) => s.map((x, k) => x + c[k] / n), [0, 0, 0, 0]);
          return { color: avg.slice(0, 3), opacity: avg[3] };
        }
        return null;
      }
      if (url[2]) return resolvePaint(url[2], st);
      warnOnce('pattern', 'Patterns and other unsupported paint servers were replaced by gray.');
      return { color: [0.5, 0.5, 0.5], opacity: 1 };
    }
    const c = parseSvgColor(v);
    if (!c) {
      warnOnce(`color:${v}`, `Unrecognized color "${v}" was treated as none.`);
      return null;
    }
    return { color: c.slice(0, 3), opacity: c[3] };
  };

  const gradientStops = (el, seen = new Set()) => {
    if (seen.has(el)) return [];
    seen.add(el);
    const stops = [];
    for (const c of el.children) {
      if (c.type !== 'element' || localName(c.name) !== 'stop') continue;
      const decl = { ...Object.fromEntries(c.attrs.map((a) => [localName(a.name), a.value])), ...parseDeclarations(c.attr('style') || '') };
      const col = parseSvgColor(decl['stop-color'] || 'black');
      if (!col) continue;
      const op = decl['stop-opacity'] !== undefined ? parseFloat(decl['stop-opacity']) : 1;
      stops.push([col[0], col[1], col[2], col[3] * (Number.isFinite(op) ? op : 1)]);
    }
    if (stops.length) return stops;
    const href = el.attr('href') || el.attr('xlink:href');
    const ref = href && href.startsWith('#') ? byId.get(href.slice(1)) : null;
    return ref ? gradientStops(ref, seen) : [];
  };

  /** Outline of a basic shape as absolute segments, or null. */
  const shapeSegments = (el, tag) => {
    const num = (k, ref = refD) => {
      const v = parseLength(el.attr(k), ref);
      return v === null ? 0 : v;
    };
    switch (tag) {
      case 'path': {
        const d = el.attr('d');
        if (!d || !d.trim()) return null;
        try {
          return parsePathData(d).segments;
        } catch (e) {
          warnOnce('pathdata', `A path with invalid path data was skipped (${e.message}).`);
          return null;
        }
      }
      case 'rect': {
        const x = num('x', refW), y = num('y', refH), w = num('width', refW), hh = num('height', refH);
        if (!(w > 0 && hh > 0)) return null;
        let rx = parseLength(el.attr('rx'), refW), ry = parseLength(el.attr('ry'), refH);
        if (rx === null || rx < 0) rx = ry !== null && ry > 0 ? ry : 0;
        if (ry === null || ry < 0) ry = rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, hh / 2);
        if (!(rx > 0 && ry > 0)) return [{ c: 'M', x, y }, { c: 'L', x: x + w, y }, { c: 'L', x: x + w, y: y + hh }, { c: 'L', x, y: y + hh }, { c: 'Z' }];
        const arc = (x0, y0, x1, y1) => ({ c: 'A', rx, ry, rot: 0, large: 0, sweep: 1, x0, y0, x: x1, y: y1 });
        return [
          { c: 'M', x: x + rx, y },
          { c: 'L', x: x + w - rx, y },
          arc(x + w - rx, y, x + w, y + ry),
          { c: 'L', x: x + w, y: y + hh - ry },
          arc(x + w, y + hh - ry, x + w - rx, y + hh),
          { c: 'L', x: x + rx, y: y + hh },
          arc(x + rx, y + hh, x, y + hh - ry),
          { c: 'L', x, y: y + ry },
          arc(x, y + ry, x + rx, y),
          { c: 'Z' },
        ];
      }
      case 'circle':
      case 'ellipse': {
        const cx = num('cx', refW), cy = num('cy', refH);
        const rx = tag === 'circle' ? num('r') : num('rx', refW);
        const ry = tag === 'circle' ? rx : num('ry', refH);
        if (!(rx > 0 && ry > 0)) return null;
        return [
          { c: 'M', x: cx + rx, y: cy },
          { c: 'A', rx, ry, rot: 0, large: 1, sweep: 1, x0: cx + rx, y0: cy, x: cx - rx, y: cy },
          { c: 'A', rx, ry, rot: 0, large: 1, sweep: 1, x0: cx - rx, y0: cy, x: cx + rx, y: cy },
          { c: 'Z' },
        ];
      }
      case 'line':
        return [{ c: 'M', x: num('x1', refW), y: num('y1', refH) }, { c: 'L', x: num('x2', refW), y: num('y2', refH) }];
      case 'polyline':
      case 'polygon': {
        const v = numbersIn(el.attr('points') || '');
        if (v.length % 2) warnOnce('points', 'A points list with an odd number of coordinates was truncated.');
        if (v.length < 4) return null;
        const segs = [{ c: 'M', x: v[0], y: v[1] }];
        for (let i = 2; i + 1 < v.length; i += 2) segs.push({ c: 'L', x: v[i], y: v[i + 1] });
        if (tag === 'polygon') segs.push({ c: 'Z' });
        return segs;
      }
      default:
        return null;
    }
  };

  // ---- walk the tree
  const shapes = [];
  let skipped = 0;
  const rootStyle = { ...DEFAULT_STYLE, opacity: 1 };
  const walk = (el, ctm, parentStyle, depth, useStack) => {
    const tag = localName(el.name);
    if (NEVER_RENDERED.has(tag)) return;
    if (SKIPPED_ELEMENTS[tag]) {
      skipped++;
      warnOnce(`skip:${tag}`, `Skipped ${SKIPPED_ELEMENTS[tag]}.`);
      return;
    }
    const st = computeStyle(el, parentStyle);
    if (st.display === 'none') return;
    let m = ctm;
    const tAttr = el.attr('transform');
    if (tAttr) {
      const t = parseSvgTransform(tAttr);
      if (t) m = mul(m, t);
      else warnOnce('transform', `An invalid transform "${tAttr}" was ignored.`);
    }
    for (const k of ['clip-path', 'mask', 'filter']) {
      if (el.attr(k) || (el.attr('style') || '').includes(`${k}:`)) warnOnce(k, `${k === 'filter' ? 'Filters' : k === 'mask' ? 'Masks' : 'Clip paths'} were ignored.`);
    }
    if (tag === 'use') {
      const href = el.attr('href') || el.attr('xlink:href') || '';
      const ref = href.startsWith('#') ? byId.get(href.slice(1)) : null;
      if (!ref) {
        warnOnce('use', `A <use> pointing to "${href}" was skipped (only references within the file are supported).`);
        return;
      }
      if (useStack.includes(ref) || useStack.length > 16) {
        warnOnce('usecycle', 'A <use> that refers to itself was skipped.');
        return;
      }
      m = mul(m, [1, 0, 0, 1, parseLength(el.attr('x'), refW) || 0, parseLength(el.attr('y'), refH) || 0]);
      if (localName(ref.name) === 'symbol') {
        let sm = m;
        const svb = numbersIn(ref.attr('viewBox') || '');
        const uw = parseLength(el.attr('width'), refW), uh = parseLength(el.attr('height'), refH);
        if (svb.length === 4 && svb[2] > 0 && svb[3] > 0 && uw > 0 && uh > 0) {
          const k = Math.min(uw / svb[2], uh / svb[3]); // xMidYMid meet
          sm = mul(m, [k, 0, 0, k, (uw - svb[2] * k) / 2 - svb[0] * k, (uh - svb[3] * k) / 2 - svb[1] * k]);
        }
        const symStyle = computeStyle(ref, st);
        for (const c of ref.children) if (c.type === 'element') walk(c, sm, symStyle, depth + 1, [...useStack, ref]);
      } else {
        walk(ref, m, st, depth + 1, [...useStack, ref]);
      }
      return;
    }
    if (CONTAINERS.has(tag)) {
      if (tag === 'svg' && el !== svg) m = mul(m, [1, 0, 0, 1, parseLength(el.attr('x'), refW) || 0, parseLength(el.attr('y'), refH) || 0]);
      if (tag === 'switch') {
        const first = el.children.find((c) => c.type === 'element');
        if (first) walk(first, m, st, depth + 1, useStack);
        return;
      }
      for (const c of el.children) if (c.type === 'element') walk(c, m, st, depth + 1, useStack);
      return;
    }
    const segs = shapeSegments(el, tag);
    if (!segs) {
      if (!['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(tag)) warnOnce(`unknown:${tag}`, `Unknown element <${el.name}> was skipped.`);
      return;
    }
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return;
    const op = st.opacity;
    const fill = resolvePaint(st.fill, st);
    const stroke = resolvePaint(st.stroke, st);
    const fillOpacity = parseFloat(st['fill-opacity']);
    const strokeOpacity = parseFloat(st['stroke-opacity']);
    const strokeWidth = parseLength(st['stroke-width'], refD);
    if (st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none' && stroke) warnOnce('dash', 'Dashed strokes were drawn solid.');
    if (tag === 'line' || tag === 'polyline') {
      // never filled with an area in practice; polyline fills are rare
    }
    shapes.push({
      segs,
      ctm: m,
      id: el.attr('id') || null,
      fill: fill && tag !== 'line' ? { ...fill, opacity: fill.opacity * (Number.isFinite(fillOpacity) ? fillOpacity : 1) * op } : null,
      stroke: strokes && stroke && strokeWidth > 0 ? { ...stroke, opacity: stroke.opacity * (Number.isFinite(strokeOpacity) ? strokeOpacity : 1) * op, width: strokeWidth } : null,
      fillRule: st['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
    });
  };
  walk(svg, IDENTITY, rootStyle, 0, []);
  if (!strokes && shapes.some((s) => !s.fill)) warn('Strokes were not converted (the strokes option is off).');

  // ---- bounds and normalization
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    const pad = s.stroke ? (s.stroke.width / 2) * Math.sqrt(Math.abs(det(s.ctm))) : 0;
    for (const poly of controlPolygons(transformSegments(s.segs, s.ctm))) {
      for (let i = 0; i < poly.length; i += 2) {
        minX = Math.min(minX, poly[i] - pad);
        maxX = Math.max(maxX, poly[i] + pad);
        minY = Math.min(minY, poly[i + 1] - pad);
        maxY = Math.max(maxY, poly[i + 1] + pad);
      }
    }
  }
  const box = frame || (minX <= maxX ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 1, h: 1 });
  const longest = Math.max(box.w, box.h) || 1;
  const k = size / longest;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const N = [k, 0, 0, -k, -cx * k, cy * k]; // centre, scale, flip y
  const decimals = opts.precision ?? Math.max(0, Math.min(8, Math.ceil(-Math.log10(size * 1e-4))));
  const f = (v) => formatNumber(v, decimals);
  const depth = Math.max(0, depthRel * size);
  const bevel = depth > 0 ? Math.min(Math.max(0, bevelRel * size), depth / 2) : 0;

  // ---- materials
  const materials = new Map();
  const materialFor = (paint) => {
    const hex = colorToHex([paint.color[0], paint.color[1], paint.color[2], 1]);
    const opacity = Math.round(Math.max(0, Math.min(1, paint.opacity)) * 100) / 100;
    const key = `${hex}:${opacity}`;
    let m = materials.get(key);
    if (!m) {
      const id = `c${hex.slice(1)}${opacity < 1 ? `-${Math.round(opacity * 100)}` : ''}`;
      const attrs = { id, color: hex, roughness: '0.55' };
      if (opacity < 1) attrs.opacity = formatNumber(opacity, 2);
      m = { id, el: h('material', attrs) };
      materials.set(key, m);
    }
    return m.id;
  };

  // ---- output
  const out = [];
  let fills = 0, tubes = 0, zeroArea = 0;
  const visible = shapes.filter((s) => (s.fill && s.fill.opacity > 0) || (s.stroke && s.stroke.opacity > 0));
  const step = depth > 0 ? Math.min(depth * 0.1, (depth * 2) / Math.max(1, visible.length)) : size * Math.min(0.002, 0.2 / Math.max(1, visible.length));
  visible.forEach((s, i) => {
    const m = mul(N, s.ctm);
    const segs = transformSegments(s.segs, m);
    const d = formatPathData(segs, { precision: decimals, minify: true });
    const z = i * step;
    const label = s.id ? { name: s.id } : {};
    if (s.fill && s.fill.opacity > 0) {
      const area = controlPolygons(segs).reduce((a, p) => a + Math.abs(polygonArea(p)), 0);
      if (area > (size * 1e-6) ** 2) {
        const attrs = { ...label, d };
        if (s.fillRule === 'evenodd') attrs.fillRule = 'evenodd';
        if (depth > 0) {
          attrs.depth = f(depth);
          if (bevel > 0) attrs.bevel = f(bevel);
        }
        if (z) attrs.position = `0,0,${f(z)}`;
        attrs.material = materialFor(s.fill);
        out.push(h(depth > 0 ? 'extrude' : 'path', attrs));
        fills++;
      } else zeroArea++;
    }
    if (s.stroke && s.stroke.opacity > 0) {
      const r = (s.stroke.width / 2) * Math.sqrt(Math.abs(det(s.ctm))) * k;
      if (r > 0) {
        const attrs = { ...(s.fill ? {} : label), d, radius: formatNumber(r, decimals + 1) };
        attrs.position = `0,0,${f(z + depth)}`;
        attrs.material = materialFor(s.stroke);
        out.push(h('polyline', attrs));
        tubes++;
      }
    }
  });
  if (zeroArea) warn(`${zeroArea} filled shape${zeroArea > 1 ? 's have' : ' has'} no area and ${zeroArea > 1 ? 'were' : 'was'} skipped.`);
  if (!out.length) warn('The drawing contains no shapes that could be converted.');

  // ---- document
  // a camera slightly above and to the right, far enough to frame the drawing
  // in a 3:2 view (35° vertical field of view)
  const tanHalf = Math.tan((17.5 * Math.PI) / 180);
  const dist = Math.max((box.h * k) / 2 / tanHalf, (box.w * k) / 2 / (tanHalf * 1.5)) * 1.1 + depth;
  const dir = [0.17, 0.13, 1];
  const dl = Math.hypot(...dir);
  const root = h(
    'es3d',
    { version: '1' },
    h('title', {}, title),
    h('environment', { background: '#dfe3e8', sky: '#ffffff', ground: '#8a8f99', intensity: '0.65' }),
    h('camera', { position: `${f((dir[0] / dl) * dist)},${f((dir[1] / dl) * dist)},${f((dir[2] / dl) * dist + depth / 2)}`, target: `0,0,${f(depth / 2)}`, fov: '35' }),
    h('light', { type: 'directional', direction: '-0.35,-0.45,-1', intensity: '1.3' }),
  );
  const defs = h('defs');
  if (base) defs.appendChild(h('material', { id: 'plate', color: '#f4f4f4', roughness: '0.8' }));
  for (const m of materials.values()) defs.appendChild(m.el);
  if (defs.children.length) root.appendChild(defs);
  if (base) {
    const bd = Math.max(depth * 0.5, size * 0.01);
    root.appendChild(h('box', { size: `${f(box.w * k)},${f(box.h * k)},${f(bd)}`, position: `0,0,${f(-bd / 2)}`, material: 'plate' }));
  }
  const group = h('group', { name: title });
  for (const el of out) group.appendChild(el);
  root.appendChild(group);
  const comment = new Comment(` Converted from ${name.replace(/--/g, '- -')} by the ES3D converter: ${fills} filled shape${fills === 1 ? '' : 's'}, ${tubes} stroke${tubes === 1 ? '' : 's'}. `);
  const es3d = serialize(new Document({ root, syntax: 'xml', leading: [comment] }), { pretty: true, comments: true });
  return { text: es3d, warnings, stats: { shapes: shapes.length, fills, strokes: tubes, materials: materials.size, skipped } };
}
