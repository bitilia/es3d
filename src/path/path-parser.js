// SVG-style path data parser.
//
// 2D paths accept the full SVG grammar: M L H V C S Q T A Z (absolute and
// relative), implicit command repetition, optional separators ("M10-5"),
// compact arc flags ("a1,1 0 00 1,1") and closepath semantics.
//
// 3D paths (sweep spines) use the same letters with three coordinates per
// point: M L C S Q T Z (H, V and A have no unambiguous 3D meaning).
//
// The result is a list of absolute segments; H/V become L, S becomes C and
// T becomes Q. Each segment remembers its source offset for error reporting.

import { MAX_PATH_COMMANDS } from '../format/limits.js';

export class PathError extends Error {
  constructor(message, offset, length = 1, code = null) {
    super(message);
    this.name = 'PathError';
    this.offset = offset;
    this.length = length;
    this.code = code;
  }
}

const ARG_COUNT_2D = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const ARG_COUNT_3D = { M: 3, L: 3, C: 9, S: 6, Q: 6, T: 3, Z: 0 };

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

/** Scan a number at i; returns the end index or -1. */
export function scanNumber(s, i) {
  return readNumber(s, i);
}

const POW10 = Array.from({ length: 23 }, (_, k) => Number(`1e${k}`));

/** Value of the number that readNumber last read. */
export let numberValue = 0;

/**
 * Read the number at i: returns its end index (or -1 when no number starts
 * there) and leaves its value in `numberValue`, exactly as Number() would give
 * it for s.slice(i, end). When the digits form an integer of at most 2^53 and
 * the decimal exponent is within ±22, both are exact in binary64, so one IEEE
 * multiply or divide is correctly rounded (Clinger's fast path) and no
 * substring is made; anything else goes through Number(). Mesh data is
 * hundreds of thousands of such numbers, so this is one pass over the digits.
 */
export function readNumber(s, i) {
  const start = i;
  let c = s.charCodeAt(i);
  const neg = c === 45;
  if (c === 43 || c === 45) c = s.charCodeAt(++i);
  // the mantissa only grows, so it is exact whenever it ends at most 2^53
  let m = 0;
  const intStart = i;
  while (c >= 48 && c <= 57) {
    m = m * 10 + (c - 48);
    c = s.charCodeAt(++i);
  }
  let digits = i - intStart, frac = 0;
  if (c === 46) {
    const fracStart = ++i;
    c = s.charCodeAt(i);
    while (c >= 48 && c <= 57) {
      m = m * 10 + (c - 48);
      c = s.charCodeAt(++i);
    }
    frac = i - fracStart;
    digits += frac;
  }
  if (!digits) return -1;
  let e = 0;
  if (c === 101 || c === 69) {
    // the exponent belongs to the number only when digits follow
    let j = i + 1;
    let c2 = s.charCodeAt(j);
    const eneg = c2 === 45;
    if (c2 === 43 || c2 === 45) c2 = s.charCodeAt(++j);
    if (c2 >= 48 && c2 <= 57) {
      while (c2 >= 48 && c2 <= 57) {
        e = e * 10 + (c2 - 48);
        c2 = s.charCodeAt(++j);
      }
      if (eneg) e = -e;
      i = j;
    }
  }
  e -= frac;
  if (m > 9007199254740992 || e > 22 || e < -22) numberValue = Number(s.slice(start, i));
  else {
    const v = e >= 0 ? m * POW10[e] : m / POW10[-e];
    numberValue = neg ? -v : v;
  }
  return i;
}

/**
 * @param {string} s path data
 * @param {2|3} dim
 * @returns {{segments: object[], subpaths: number}}
 */
export function parsePathData(s, dim = 2) {
  const counts = dim === 3 ? ARG_COUNT_3D : ARG_COUNT_2D;
  const n = s.length;
  let i = 0;
  const segs = [];
  let cx = 0, cy = 0, cz = 0;
  let sx = 0, sy = 0, sz = 0;
  // previous control point for S/T reflection
  let pcx = 0, pcy = 0, pcz = 0;
  let prev = '';
  let cmd = '';
  let subpaths = 0;
  let pendingMoveAfterZ = false;

  const skipWs = () => {
    while (i < n && isWs(s.charCodeAt(i))) i++;
  };
  const skipSep = () => {
    skipWs();
    if (s.charCodeAt(i) === 44) {
      i++;
      skipWs();
    }
  };
  const num = () => {
    skipSep();
    const end = readNumber(s, i);
    if (end < 0) {
      if (i >= n) throw new PathError(`Command '${cmd}' expects ${counts[cmd.toUpperCase()]} numbers but the path data ended.`, Math.max(0, n - 1), 1);
      throw new PathError(`Expected a number in '${cmd}' command but found '${s[i]}'.`, i, 1);
    }
    i = end;
    return numberValue;
  };
  const flag = () => {
    skipSep();
    const c = s.charCodeAt(i);
    if (c !== 48 && c !== 49) throw new PathError("Arc flags must be '0' or '1'.", i, 1);
    i++;
    return c === 49 ? 1 : 0;
  };
  const startsNumber = () => {
    let j = i;
    while (j < n && isWs(s.charCodeAt(j))) j++;
    if (s.charCodeAt(j) === 44) {
      j++;
      while (j < n && isWs(s.charCodeAt(j))) j++;
    }
    const c = s.charCodeAt(j);
    return (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46;
  };

  skipWs();
  if (i >= n) return { segments: segs, subpaths: 0 };

  while (true) {
    skipWs();
    if (i >= n) break;
    if (segs.length >= MAX_PATH_COMMANDS) {
      throw new PathError(`Path data has more than ${MAX_PATH_COMMANDS.toLocaleString('en-US')} commands.`, i, 1, 'E_PATH_LIMIT');
    }
    const c = s[i];
    const code = s.charCodeAt(i);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const segStart = i;
    if (isLetter) {
      const up = c.toUpperCase();
      if (!(up in ARG_COUNT_2D)) throw new PathError(`Unknown path command '${c}'. Valid commands: M L H V C S Q T A Z.`, i, 1);
      if (!(up in counts)) throw new PathError(`Command '${c}' is not available in 3D path data (use M L C S Q T Z).`, i, 1);
      if (!cmd && up !== 'M') throw new PathError('Path data must begin with a moveto command (M or m).', i, 1);
      cmd = c;
      i++;
      if (up === 'Z') {
        // closepath
        segs.push({ c: 'Z', o: segStart });
        cx = sx;
        cy = sy;
        cz = sz;
        prev = 'Z';
        pendingMoveAfterZ = true;
        continue;
      }
      if (!startsNumber()) {
        skipWs();
        throw new PathError(`Command '${c}' expects ${counts[up]} numbers.`, Math.min(i, n - 1), 1);
      }
    } else {
      if (!cmd) throw new PathError('Path data must begin with a moveto command (M or m).', i, 1);
      if (cmd === 'Z' || cmd === 'z') throw new PathError(`Unexpected '${c}' after closepath; start a new command.`, i, 1);
      if (!startsNumber()) throw new PathError(`Unexpected character '${c}' in path data.`, i, 1);
      // implicit repetition: subsequent moveto pairs are lineto
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
    }

    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    if (pendingMoveAfterZ && up !== 'M') {
      // a subpath that continues after Z starts at the previous subpath's start point
      segs.push({ c: 'M', x: sx, y: sy, z: sz, o: segStart, implicit: true });
      subpaths++;
    }
    pendingMoveAfterZ = false;
    const ox = rel ? cx : 0, oy = rel ? cy : 0, oz = rel ? cz : 0;

    switch (up) {
      case 'M': {
        const x = num() + ox, y = num() + oy;
        const z = dim === 3 ? num() + oz : 0;
        segs.push({ c: 'M', x, y, z, o: segStart });
        cx = sx = x;
        cy = sy = y;
        cz = sz = z;
        subpaths++;
        break;
      }
      case 'L': {
        const x = num() + ox, y = num() + oy;
        const z = dim === 3 ? num() + oz : 0;
        segs.push({ c: 'L', x, y, z, o: segStart });
        cx = x;
        cy = y;
        cz = z;
        break;
      }
      case 'H': {
        const x = num() + ox;
        segs.push({ c: 'L', x, y: cy, z: 0, o: segStart });
        cx = x;
        break;
      }
      case 'V': {
        const y = num() + oy;
        segs.push({ c: 'L', x: cx, y, z: 0, o: segStart });
        cy = y;
        break;
      }
      case 'C': {
        const x1 = num() + ox, y1 = num() + oy, z1 = dim === 3 ? num() + oz : 0;
        const x2 = num() + ox, y2 = num() + oy, z2 = dim === 3 ? num() + oz : 0;
        const x = num() + ox, y = num() + oy, z = dim === 3 ? num() + oz : 0;
        segs.push({ c: 'C', x1, y1, z1, x2, y2, z2, x, y, z, o: segStart });
        pcx = x2; pcy = y2; pcz = z2;
        cx = x; cy = y; cz = z;
        break;
      }
      case 'S': {
        let x1 = cx, y1 = cy, z1 = cz;
        if (prev === 'C' || prev === 'S') {
          x1 = 2 * cx - pcx;
          y1 = 2 * cy - pcy;
          z1 = 2 * cz - pcz;
        }
        const x2 = num() + ox, y2 = num() + oy, z2 = dim === 3 ? num() + oz : 0;
        const x = num() + ox, y = num() + oy, z = dim === 3 ? num() + oz : 0;
        segs.push({ c: 'C', x1, y1, z1, x2, y2, z2, x, y, z, o: segStart });
        pcx = x2; pcy = y2; pcz = z2;
        cx = x; cy = y; cz = z;
        break;
      }
      case 'Q': {
        const x1 = num() + ox, y1 = num() + oy, z1 = dim === 3 ? num() + oz : 0;
        const x = num() + ox, y = num() + oy, z = dim === 3 ? num() + oz : 0;
        segs.push({ c: 'Q', x1, y1, z1, x, y, z, o: segStart });
        pcx = x1; pcy = y1; pcz = z1;
        cx = x; cy = y; cz = z;
        break;
      }
      case 'T': {
        let x1 = cx, y1 = cy, z1 = cz;
        if (prev === 'Q' || prev === 'T') {
          x1 = 2 * cx - pcx;
          y1 = 2 * cy - pcy;
          z1 = 2 * cz - pcz;
        }
        const x = num() + ox, y = num() + oy, z = dim === 3 ? num() + oz : 0;
        segs.push({ c: 'Q', x1, y1, z1, x, y, z, o: segStart });
        pcx = x1; pcy = y1; pcz = z1;
        cx = x; cy = y; cz = z;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const x = num() + ox, y = num() + oy;
        if (rx < 0 || ry < 0) throw new PathError('Arc radii must not be negative.', segStart, i - segStart);
        segs.push({ c: 'A', rx, ry, rot, large, sweep, x0: cx, y0: cy, x, y, z: 0, o: segStart });
        cx = x;
        cy = y;
        break;
      }
      default:
        throw new PathError(`Unsupported command '${cmd}'.`, segStart, 1);
    }
    prev = up;
  }
  return { segments: segs, subpaths };
}

/** Axis-aligned bounds of the control polygon (a conservative bound for curves; arcs use their endpoints and radii). */
export function pathControlBounds(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const s of segments) {
    if (s.c === 'Z') continue;
    add(s.x, s.y);
    if (s.c === 'C') {
      add(s.x1, s.y1);
      add(s.x2, s.y2);
    } else if (s.c === 'Q') add(s.x1, s.y1);
    else if (s.c === 'A') {
      const r = Math.max(s.rx, s.ry);
      add(s.x - r, s.y - r);
      add(s.x + r, s.y + r);
      add(s.x0 - r, s.y0 - r);
      add(s.x0 + r, s.y0 + r);
    }
  }
  return { minX, minY, maxX, maxY };
}
