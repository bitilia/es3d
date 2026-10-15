// Typed attribute value parsers.
//
// Attribute values are kept as raw strings in the AST; the validator converts
// them with the parsers below according to the schema. Every parser either
// returns a value or throws a ValueError whose offset points into the raw
// string, which the validator maps back to a document line/column.

import { ValueError } from './value-error.js';
import { parseColor, NAMED_COLORS } from './colors.js';
import { suggest } from './errors.js';
import { parsePathData, PathError, readNumber, numberValue } from '../path/path-parser.js';
import { parseTransform } from '../transform/transform.js';
import { readNumbersWasm } from '../wasm/kernels.js';

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function describe(raw) {
  const s = raw.length > 24 ? raw.slice(0, 24) + '…' : raw;
  return `'${s}'`;
}

/** Parse a single number (strict). */
export function parseNumber(raw) {
  let i = 0;
  const n = raw.length;
  while (i < n && isWs(raw.charCodeAt(i))) i++;
  if (i >= n) throw new ValueError('Expected a number but the value is empty.', 0, 0);
  const end = readNumber(raw, i);
  if (end < 0) throw new ValueError(`Expected a number but found ${describe(raw.trim())}.`, i, Math.max(1, raw.trim().length));
  const value = numberValue;
  let j = end;
  while (j < n && isWs(raw.charCodeAt(j))) j++;
  if (j < n) {
    if (raw[j] === ',' || isWs(raw.charCodeAt(end))) throw new ValueError(`Expected a single number but found a list ${describe(raw.trim())}.`, j, 1);
    throw new ValueError(`Unexpected '${raw[j]}' after number.`, j, 1);
  }
  return value;
}

// lists at least this long (mesh data) are read by the WebAssembly kernel when it is available
const WASM_LIST = 1024;
const wasmList = (raw, as) => (raw.length >= WASM_LIST ? readNumbersWasm(raw, as) : null);

// numbers of the list being read; short lists reuse this buffer
let scratch = new Float64Array(64);

/**
 * Read a list of numbers separated by whitespace and/or single commas.
 * Returns a view of the values, valid until the next call.
 */
function readNumberList(raw) {
  const n = raw.length;
  let buf = scratch;
  let count = 0;
  let i = 0;
  while (i < n && isWs(raw.charCodeAt(i))) i++;
  while (i < n) {
    const end = readNumber(raw, i);
    if (end < 0) {
      let k = i;
      while (k < n && !isWs(raw.charCodeAt(k)) && raw[k] !== ',') k++;
      throw new ValueError(`Expected a number but found ${describe(raw.slice(i, k) || raw[i])}.`, i, Math.max(1, k - i));
    }
    if (count === buf.length) {
      const grown = new Float64Array(buf.length * 2);
      grown.set(buf);
      buf = grown;
    }
    buf[count++] = numberValue;
    i = end;
    let sep = false;
    while (i < n && isWs(raw.charCodeAt(i))) {
      i++;
      sep = true;
    }
    if (i < n && raw.charCodeAt(i) === 44) {
      i++;
      sep = true;
      while (i < n && isWs(raw.charCodeAt(i))) i++;
      if (i >= n) throw new ValueError('Trailing comma in number list.', i - 1, 1);
    }
    if (i < n && !sep) throw new ValueError(`Expected a separator (space or comma) but found '${raw[i]}'.`, i, 1);
  }
  // keep a grown buffer for the next list unless it is mesh-sized
  if (buf.length <= 4096) scratch = buf;
  return buf.subarray(0, count);
}

/**
 * Parse a list of numbers separated by whitespace and/or single commas.
 * Pushes into `out` (array or growable) and returns it.
 */
export function parseNumberList(raw, out = []) {
  const list = readNumberList(raw);
  for (let k = 0; k < list.length; k++) out.push(list[k]);
  return out;
}

export function parseInteger(raw) {
  const v = parseNumber(raw);
  if (!Number.isInteger(v)) throw new ValueError(`Expected a whole number but found ${describe(raw.trim())}.`, 0, raw.length);
  return v;
}

export function parseBool(raw) {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw new ValueError(`Expected 'true' or 'false' but found ${describe(s)}.`, 0, raw.length, {
    suggestion: suggest(s, ['true', 'false']) || null,
  });
}

function vec(raw, count, name) {
  const list = parseNumberList(raw);
  if (list.length !== count) {
    throw new ValueError(`${name} needs ${count} numbers (e.g. ${Array.from({ length: count }, (_, i) => i + 1).join(',')}) but ${list.length} ${list.length === 1 ? 'was' : 'were'} given.`, 0, raw.length);
  }
  return list;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export function parseId(raw) {
  const s = raw.trim();
  if (!ID_RE.test(s)) {
    throw new ValueError(`Invalid id ${describe(s)}: ids start with a letter or '_' and contain letters, digits, '_', '-', '.' or ':'.`, 0, raw.length);
  }
  return s;
}

export function parseRef(raw) {
  let s = raw.trim();
  if (s.startsWith('url(#') && s.endsWith(')')) s = s.slice(5, -1);
  if (s[0] === '#') s = s.slice(1);
  return parseId(s);
}

/** "a" or "a..b" */
export function parseRange(raw) {
  const s = raw.trim();
  const k = s.indexOf('..');
  if (k < 0) {
    const v = parseNumber(s);
    return [v, v];
  }
  const a = parseNumber(s.slice(0, k));
  let b;
  try {
    b = parseNumber(s.slice(k + 2));
  } catch (e) {
    throw new ValueError(e.message, k + 2 + e.offset, e.length);
  }
  if (b < a) throw new ValueError(`Range ${describe(s)} is reversed: the lower bound must come first.`, 0, raw.length);
  return [a, b];
}

/** Per-axis ranges "x,y,z" where each part is a number or a range; or a single (uniform) range. */
export function parseRange3(raw, allowUniform) {
  const parts = raw.split(',');
  if (parts.length === 1) {
    if (!allowUniform) throw new ValueError('Expected three comma-separated components, e.g. 0,0..360,0.', 0, raw.length);
    return { uniform: true, ranges: [parseRange(parts[0])] };
  }
  if (parts.length !== 3) throw new ValueError(`Expected three comma-separated components but found ${parts.length}.`, 0, raw.length);
  const ranges = [];
  let off = 0;
  for (const p of parts) {
    try {
      ranges.push(parseRange(p));
    } catch (e) {
      throw new ValueError(e.message, off + (e.offset || 0), e.length || p.length);
    }
    off += p.length + 1;
  }
  return { uniform: false, ranges };
}

export function parseIdList(raw) {
  const ids = raw.split(/[\s,]+/).filter(Boolean);
  if (!ids.length) throw new ValueError('Expected at least one id.', 0, raw.length);
  let off = 0;
  return ids.map((id) => {
    const at = raw.indexOf(id, off);
    off = at + id.length;
    try {
      return parseRef(id);
    } catch (e) {
      throw new ValueError(e.message, at, id.length);
    }
  });
}

export function parseColorValue(raw) {
  const c = parseColor(raw);
  if (c) return c;
  const s = raw.trim();
  let sug = null;
  if (/^[a-z]+$/i.test(s)) sug = suggest(s.toLowerCase(), [...NAMED_COLORS.keys()]);
  throw new ValueError(`Invalid color ${describe(s)}.`, 0, raw.length, {
    suggestion: sug,
    hint: 'Colors are written #rgb, #rrggbb, #rrggbbaa, rgb(r,g,b), rgba(r,g,b,a) or as a CSS color name.',
  });
}

/** Seconds: "4", "4s", "250ms" */
export function parseDuration(raw) {
  const s = raw.trim();
  let scale = 1;
  let body = s;
  if (s.endsWith('ms')) {
    scale = 0.001;
    body = s.slice(0, -2);
  } else if (s.endsWith('s')) {
    body = s.slice(0, -1);
  }
  const v = parseNumber(body);
  return v * scale;
}

/** Function-call syntax used by textures and helix(): name(arg, arg, ...) */
export function parseCall(raw) {
  const s = raw.trim();
  const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*\(([\s\S]*)\)$/.exec(s);
  if (!m) return null;
  const argStr = m[2].trim();
  const args = argStr ? argStr.split(/\s*,\s*/) : [];
  return { name: m[1], args, argOffset: raw.indexOf('(') + 1 };
}

export const TEXTURE_FUNCTIONS = {
  checker: [['count', 'number', 8], ['color1', 'color', '#ffffff'], ['color2', 'color', '#1a1a1a']],
  grid: [['count', 'number', 8], ['width', 'number', 0.06], ['line', 'color', '#222222'], ['background', 'color', '#ffffff']],
  stripes: [['count', 'number', 8], ['color1', 'color', '#ffffff'], ['color2', 'color', '#1a1a1a']],
  noise: [['scale', 'number', 8], ['color1', 'color', '#ffffff'], ['color2', 'color', '#000000'], ['seed', 'number', 1]],
  bricks: [['count', 'number', 6], ['brick', 'color', '#b5543a'], ['mortar', 'color', '#d8d0c4']],
};

export const NORMAL_FUNCTIONS = {
  bumps: [['count', 'number', 8], ['strength', 'number', 1]],
  tiles: [['count', 'number', 4], ['strength', 'number', 1], ['gap', 'number', 0.06]],
  noise: [['scale', 'number', 8], ['strength', 'number', 1], ['seed', 'number', 1]],
  waves: [['count', 'number', 6], ['strength', 'number', 1]],
  bricks: [['count', 'number', 6], ['strength', 'number', 1]],
};

function parseTextureSpec(raw, table, label) {
  const call = parseCall(raw);
  if (call) {
    const spec = table[call.name];
    if (!spec) {
      throw new ValueError(`Unknown procedural ${label} '${call.name}'.`, 0, call.name.length, {
        suggestion: suggest(call.name, Object.keys(table)),
        hint: `Available: ${Object.keys(table).map((k) => k + '()').join(', ')}. Any other value is treated as an image URL.`,
      });
    }
    if (call.args.length > spec.length) {
      throw new ValueError(`${call.name}() takes at most ${spec.length} arguments but ${call.args.length} were given.`, 0, raw.length);
    }
    const params = {};
    spec.forEach(([name, type, def], i) => {
      const a = call.args[i];
      const v = a === undefined || a === '' ? def : a;
      try {
        params[name] = type === 'number' ? parseNumber(String(v)) : parseColorValue(String(v));
      } catch (e) {
        throw new ValueError(`${call.name}(): argument '${name}': ${e.message}`, call.argOffset, raw.length - call.argOffset - 1);
      }
    });
    return { kind: 'procedural', fn: call.name, params, key: raw.trim() };
  }
  const url = raw.trim();
  if (!url) throw new ValueError('Expected an image URL or a procedural texture such as checker(8).', 0, 0);
  if (/\s/.test(url) && !url.startsWith('data:')) throw new ValueError('Image URLs must not contain spaces (escape them as %20).', url.search(/\s/), 1);
  return { kind: 'url', url, key: url };
}

/** Sweep spine: helix(r,pitch,turns[,segmentsPerTurn]) | 3D path data | point list */
export function parseSpine(raw) {
  const s = raw.trim();
  const call = parseCall(s);
  if (call) {
    if (call.name !== 'helix') {
      throw new ValueError(`Unknown spine function '${call.name}'.`, 0, call.name.length, { suggestion: suggest(call.name, ['helix']) });
    }
    if (call.args.length < 3 || call.args.length > 4) {
      throw new ValueError('helix() takes (radius, pitch, turns[, segmentsPerTurn]).', 0, s.length);
    }
    const nums = call.args.map((a) => parseNumber(a));
    if (nums[0] <= 0) throw new ValueError('helix(): radius must be positive.', call.argOffset, call.args[0].length);
    if (nums[2] <= 0) throw new ValueError('helix(): turns must be positive.', call.argOffset, s.length - call.argOffset);
    if (nums[3] !== undefined && (!Number.isInteger(nums[3]) || nums[3] < 3)) throw new ValueError('helix(): segmentsPerTurn must be an integer of at least 3.', call.argOffset, s.length - call.argOffset);
    return { kind: 'helix', radius: nums[0], pitch: nums[1], turns: nums[2], segmentsPerTurn: nums[3] || 0 };
  }
  if (/^[Mm]/.test(s)) {
    try {
      const p = parsePathData(raw, 3);
      if (!p.segments.length) throw new ValueError('Empty 3D path.', 0, raw.length);
      return { kind: 'path', segments: p.segments };
    } catch (e) {
      if (e instanceof PathError) throw new ValueError(e.message, e.offset, e.length, { code: e.code });
      throw e;
    }
  }
  const pts = parseNumberList(raw);
  if (pts.length % 3 !== 0) throw new ValueError(`Point lists need 3 numbers per point; found ${pts.length} numbers.`, 0, raw.length);
  if (pts.length < 6) throw new ValueError('A spine needs at least 2 points.', 0, raw.length);
  return { kind: 'points', points: Float64Array.from(pts) };
}

/** Key values of an animation: number lists separated by semicolons, e.g. "0,1,0; 2,1,0". */
export function parseKeyframes(raw) {
  const out = [];
  let start = 0;
  for (const part of raw.split(';')) {
    if (part.trim() === '') {
      // a trailing semicolon is harmless; an empty key value in the middle is not
      if (start + part.length < raw.length || !out.length) throw new ValueError('Empty key value between semicolons.', start, Math.max(1, part.length));
    } else {
      try {
        out.push(parseNumberList(part));
      } catch (e) {
        if (e instanceof ValueError) throw new ValueError(e.message, start + e.offset, e.length, { suggestion: e.suggestion, hint: e.hint });
        throw e;
      }
    }
    start += part.length + 1;
  }
  return out;
}

/**
 * Parse a raw value according to a schema attribute spec.
 * Returns the typed value; throws ValueError.
 */
export function parseTyped(spec, raw) {
  switch (spec.type) {
    case 'number':
    case 'angle':
      return parseNumber(raw);
    case 'int':
      return parseInteger(raw);
    case 'bool':
      return parseBool(raw);
    case 'string':
      return raw;
    case 'id':
      return parseId(raw);
    case 'ref':
      return parseRef(raw);
    case 'vec2':
      return vec(raw, 2, 'A 2D vector');
    case 'vec3':
      return vec(raw, 3, 'A 3D vector');
    case 'vec4':
      return vec(raw, 4, 'A 4D vector');
    case 'size2': {
      const l = parseNumberList(raw);
      if (l.length === 1) return [l[0], l[0]];
      if (l.length === 2) return l;
      throw new ValueError(`Expected 1 or 2 numbers but found ${l.length}.`, 0, raw.length);
    }
    case 'size3':
    case 'scale3': {
      const l = parseNumberList(raw);
      if (l.length === 1) return [l[0], l[0], l[0]];
      if (l.length === 3) return l;
      throw new ValueError(`Expected 1 or 3 numbers but found ${l.length}.`, 0, raw.length);
    }
    case 'count2': {
      const l = parseNumberList(raw);
      if (l.length !== 2 || !l.every((v) => Number.isInteger(v) && v >= 1)) {
        throw new ValueError('Expected two positive whole numbers, e.g. 10,10.', 0, raw.length);
      }
      return l;
    }
    case 'numbers':
      return parseNumberList(raw);
    case 'color':
      return parseColorValue(raw);
    case 'enum': {
      const s = raw.trim();
      if (spec.values.includes(s)) return s;
      throw new ValueError(`Invalid value ${describe(s)}. Expected one of: ${spec.values.join(', ')}.`, 0, raw.length, {
        suggestion: suggest(s, spec.values),
      });
    }
    case 'transform':
      return parseTransform(raw);
    case 'path2d':
      try {
        const p = parsePathData(raw, 2);
        if (!p.segments.length) throw new ValueError('Empty path data.', 0, raw.length);
        return { segments: p.segments, subpaths: p.subpaths };
      } catch (e) {
        if (e instanceof PathError) throw new ValueError(e.message, e.offset, e.length, { code: e.code });
        throw e;
      }
    case 'spine':
      return parseSpine(raw);
    case 'points2':
    case 'points3': {
      const dim = spec.type === 'points2' ? 2 : 3;
      const w = wasmList(raw, 'f64');
      const l = w || readNumberList(raw);
      if (l.length % dim !== 0) throw new ValueError(`Point lists need ${dim} numbers per point; found ${l.length} numbers.`, 0, raw.length);
      return w || l.slice();
    }
    case 'floats': {
      const w = wasmList(raw, 'f32');
      if (w) return w;
      const l = readNumberList(raw);
      const out = new Float32Array(l.length);
      out.set(l);
      return out;
    }
    case 'indices': {
      const w = wasmList(raw, 'index');
      if (w) return w;
      const l = readNumberList(raw);
      const out = new Uint32Array(l.length);
      for (let i = 0; i < l.length; i++) {
        const v = l[i];
        if (!Number.isInteger(v) || v < 0) throw new ValueError(`Indices must be non-negative whole numbers; found ${v} at position ${i}.`, 0, raw.length);
        out[i] = v;
      }
      return out;
    }
    case 'range':
      return parseRange(raw);
    case 'range3':
      return parseRange3(raw, spec.uniform !== false);
    case 'idlist':
      return parseIdList(raw);
    case 'texture':
      return parseTextureSpec(raw, TEXTURE_FUNCTIONS, 'texture');
    case 'normalTexture':
      return parseTextureSpec(raw, NORMAL_FUNCTIONS, 'normal map');
    case 'duration':
      return parseDuration(raw);
    case 'repeatCount': {
      const s = raw.trim();
      if (s === 'indefinite') return Infinity;
      const v = parseNumber(s);
      if (v <= 0) throw new ValueError("repeat must be positive or 'indefinite'.", 0, raw.length);
      return v;
    }
    case 'animValue':
      return parseNumberList(raw);
    case 'keyframes':
      return parseKeyframes(raw);
    case 'text':
      return raw;
    default:
      throw new Error(`Unknown schema type '${spec.type}'`);
  }
}
