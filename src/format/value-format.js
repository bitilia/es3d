// Formatting of typed values back to text: canonical numbers, quantization,
// number lists, transform lists and a path data minifier (shortest of
// absolute/relative commands, implicit repetition, minimal separators).

import { colorToShortHex } from './colors.js';

/**
 * Shortest decimal representation of x.
 * @param {number} x
 * @param {number|null} precision decimals to keep (quantization), null = exact
 * @param {boolean} compact drop the leading zero ("0.5" -> ".5")
 */
export function formatNumber(x, precision = null, compact = false) {
  if (precision !== null && precision !== undefined) {
    const f = 10 ** precision;
    x = Math.round(x * f) / f;
  }
  if (x === 0 || Object.is(x, -0)) return '0';
  let s = String(x);
  if (s.indexOf('e') >= 0) {
    s = s.replace('e+', 'e');
    // prefer plain notation when it is not longer
    const plain = toPlain(x);
    if (plain && plain.length <= s.length) s = plain;
  }
  if (compact) {
    if (s.startsWith('0.')) s = s.slice(1);
    else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  }
  return s;
}

/**
 * Shortest decimal that converts back to the same float32 value (mesh arrays
 * are float32 data: printing their double expansion would add noise digits).
 */
export function formatFloat32(x, precision = null, compact = false) {
  if (precision !== null && precision !== undefined) return formatNumber(x, precision, compact);
  if (x === 0 || !Number.isFinite(x)) return formatNumber(x, null, compact);
  // toPrecision(9) always round-trips; binary search for the fewest digits
  let lo = 1, hi = 9;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Math.fround(Number(x.toPrecision(mid))) === x) hi = mid;
    else lo = mid + 1;
  }
  return formatNumber(Number(x.toPrecision(lo)), null, compact);
}

function toPlain(x) {
  const abs = Math.abs(x);
  if (abs >= 1e21 || abs < 1e-12) return null;
  let s = abs.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  // guard against binary noise introduced by toFixed
  if (Number(s) !== abs) return null;
  return (x < 0 ? '-' : '') + s;
}

/** Join numbers with the minimal separators allowed by the SVG path grammar. */
export function joinNumbersMinimal(strs, prevLast = null) {
  let out = '';
  let prev = prevLast;
  for (const s of strs) {
    if (prev === null) out += s;
    else if (s[0] === '-' || (s[0] === '.' && (prev.includes('.') || prev.includes('e')))) out += s;
    else out += ' ' + s;
    prev = s;
  }
  return out;
}

/**
 * Format a flat numeric list.
 * group > 1 writes "x,y,z x,y,z" (points); group === 1 with sep writes "a,b,c" or "a b c".
 */
export function formatNumberList(list, { group = 1, sep = ',', precision = null, compact = false } = {}) {
  const parts = new Array(list.length);
  const fmt = list instanceof Float32Array ? formatFloat32 : formatNumber;
  for (let i = 0; i < list.length; i++) parts[i] = fmt(list[i], precision, compact);
  if (group <= 1) return parts.join(sep);
  const groups = [];
  for (let i = 0; i < parts.length; i += group) groups.push(parts.slice(i, i + group).join(','));
  return groups.join(' ');
}

export function formatColor(c) {
  return colorToShortHex(c);
}

/** Transform ops -> "translate(1,2,3) rotate(0,45,0)" */
export function formatTransformOps(ops, precision = null, compact = false) {
  return ops.map((op) => `${op.fn}(${op.args.map((a) => formatNumber(a, precision, compact)).join(',')})`).join(' ');
}

const EPS = 1e-9;

/**
 * Serialize absolute path segments (from parsePathData) as compact path data.
 * @param {object[]} segments
 * @param {{precision?: number|null, minify?: boolean, dim?: 2|3}} opts
 */
export function formatPathData(segments, { precision = null, minify = true, dim = 2 } = {}) {
  const fmt = (v) => formatNumber(v, precision, minify);
  const q = (v) => (precision === null || precision === undefined ? v : Math.round(v * 10 ** precision) / 10 ** precision);
  if (!minify) return formatPathPretty(segments, fmt, dim);

  let out = '';
  let lastCmd = '';
  let lastNum = null;
  // reconstructed (decoder side) current point and subpath start
  let cx = 0, cy = 0, cz = 0;
  let sx = 0, sy = 0, sz = 0;
  let prevC2 = null; // reflected control point candidates
  let prevQ1 = null;
  let prevType = '';

  const emit = (cmd, nums) => {
    const strs = nums.map(fmt);
    // a repeated command (other than moveto/closepath) can omit its letter, and
    // so can a lineto directly after a moveto of the same relativity
    const omit =
      (cmd === lastCmd && cmd !== 'M' && cmd !== 'm') ||
      (lastCmd === 'M' && cmd === 'L') ||
      (lastCmd === 'm' && cmd === 'l');
    out += omit ? joinNumbersMinimal(strs, lastNum) : cmd + joinNumbersMinimal(strs, null);
    if (strs.length) lastNum = strs[strs.length - 1];
    lastCmd = cmd;
  };
  const pick = (absCmd, absNums, relCmd, relNums) => {
    const a = absCmd + absNums.map(fmt).join(' ');
    const r = relCmd + relNums.map(fmt).join(' ');
    return r.length < a.length ? [relCmd, relNums] : [absCmd, absNums];
  };

  for (const s of segments) {
    switch (s.c) {
      case 'M': {
        if (s.implicit) break;
        const x = q(s.x), y = q(s.y), z = q(s.z || 0);
        const abs = dim === 3 ? [x, y, z] : [x, y];
        const rel = dim === 3 ? [q(x - cx), q(y - cy), q(z - cz)] : [q(x - cx), q(y - cy)];
        const [cmd, nums] = out === '' ? ['M', abs] : pick('M', abs, 'm', rel);
        emit(cmd, nums);
        if (cmd === 'm') {
          cx = cx + nums[0];
          cy = cy + nums[1];
          if (dim === 3) cz = cz + nums[2];
        } else {
          cx = x;
          cy = y;
          cz = z;
        }
        sx = cx; sy = cy; sz = cz;
        prevType = 'M';
        break;
      }
      case 'L': {
        const x = q(s.x), y = q(s.y), z = q(s.z || 0);
        let cmd, nums;
        if (dim === 2 && Math.abs(y - cy) < EPS && Math.abs(x - cx) >= EPS) {
          [cmd, nums] = pick('H', [x], 'h', [q(x - cx)]);
        } else if (dim === 2 && Math.abs(x - cx) < EPS && Math.abs(y - cy) >= EPS) {
          [cmd, nums] = pick('V', [y], 'v', [q(y - cy)]);
        } else {
          const abs = dim === 3 ? [x, y, z] : [x, y];
          const rel = dim === 3 ? [q(x - cx), q(y - cy), q(z - cz)] : [q(x - cx), q(y - cy)];
          [cmd, nums] = pick('L', abs, 'l', rel);
        }
        emit(cmd, nums);
        const up = cmd.toUpperCase();
        const relative = cmd !== up;
        if (up === 'H') cx = relative ? cx + nums[0] : nums[0];
        else if (up === 'V') cy = relative ? cy + nums[0] : nums[0];
        else if (relative) {
          cx += nums[0];
          cy += nums[1];
          if (dim === 3) cz += nums[2];
        } else {
          cx = nums[0];
          cy = nums[1];
          if (dim === 3) cz = nums[2];
        }
        prevType = 'L';
        break;
      }
      case 'C': {
        const p1 = [q(s.x1), q(s.y1), q(s.z1 || 0)];
        const p2 = [q(s.x2), q(s.y2), q(s.z2 || 0)];
        const p = [q(s.x), q(s.y), q(s.z || 0)];
        const d = dim;
        const take = (v) => v.slice(0, d);
        const rel = (v) => [q(v[0] - cx), q(v[1] - cy), q(v[2] - cz)].slice(0, d);
        let reflect = false;
        if (prevC2 && (prevType === 'C')) {
          const rx = 2 * cx - prevC2[0], ry = 2 * cy - prevC2[1], rz = 2 * cz - prevC2[2];
          reflect = Math.abs(rx - p1[0]) < 1e-7 && Math.abs(ry - p1[1]) < 1e-7 && (d === 2 || Math.abs(rz - p1[2]) < 1e-7);
        } else if (prevType !== 'C') {
          reflect = Math.abs(cx - p1[0]) < 1e-7 && Math.abs(cy - p1[1]) < 1e-7 && (d === 2 || Math.abs(cz - p1[2]) < 1e-7);
        }
        let cmd, nums;
        if (reflect) [cmd, nums] = pick('S', [...take(p2), ...take(p)], 's', [...rel(p2), ...rel(p)]);
        else [cmd, nums] = pick('C', [...take(p1), ...take(p2), ...take(p)], 'c', [...rel(p1), ...rel(p2), ...rel(p)]);
        emit(cmd, nums);
        const relative = cmd === 'c' || cmd === 's';
        const k = nums.length;
        // reconstruct as the decoder will
        const base = relative ? [cx, cy, cz] : [0, 0, 0];
        const endP = [base[0] + nums[k - d], base[1] + nums[k - d + 1], d === 3 ? base[2] + nums[k - 1] : 0];
        const c2 = [base[0] + nums[k - 2 * d], base[1] + nums[k - 2 * d + 1], d === 3 ? base[2] + nums[k - d - 1] : 0];
        prevC2 = c2;
        cx = endP[0];
        cy = endP[1];
        cz = endP[2];
        prevType = 'C';
        break;
      }
      case 'Q': {
        const p1 = [q(s.x1), q(s.y1), q(s.z1 || 0)];
        const p = [q(s.x), q(s.y), q(s.z || 0)];
        const d = dim;
        const take = (v) => v.slice(0, d);
        const rel = (v) => [q(v[0] - cx), q(v[1] - cy), q(v[2] - cz)].slice(0, d);
        let reflect = false;
        if (prevQ1 && prevType === 'Q') {
          const rx = 2 * cx - prevQ1[0], ry = 2 * cy - prevQ1[1], rz = 2 * cz - prevQ1[2];
          reflect = Math.abs(rx - p1[0]) < 1e-7 && Math.abs(ry - p1[1]) < 1e-7 && (d === 2 || Math.abs(rz - p1[2]) < 1e-7);
        }
        let cmd, nums;
        if (reflect) [cmd, nums] = pick('T', take(p), 't', rel(p));
        else [cmd, nums] = pick('Q', [...take(p1), ...take(p)], 'q', [...rel(p1), ...rel(p)]);
        emit(cmd, nums);
        const relative = cmd === 'q' || cmd === 't';
        const base = relative ? [cx, cy, cz] : [0, 0, 0];
        const k = nums.length;
        const endP = [base[0] + nums[k - d], base[1] + nums[k - d + 1], d === 3 ? base[2] + nums[k - 1] : 0];
        prevQ1 = reflect ? [2 * cx - prevQ1[0], 2 * cy - prevQ1[1], 2 * cz - prevQ1[2]] : [base[0] + nums[0], base[1] + nums[1], d === 3 ? base[2] + nums[2] : 0];
        cx = endP[0];
        cy = endP[1];
        cz = endP[2];
        prevType = 'Q';
        break;
      }
      case 'A': {
        const x = q(s.x), y = q(s.y);
        const absNums = [s.rx, s.ry, s.rot, s.large, s.sweep, x, y];
        const relNums = [s.rx, s.ry, s.rot, s.large, s.sweep, q(x - cx), q(y - cy)];
        const a = 'A' + absNums.map(fmt).join(' ');
        const r = 'a' + relNums.map(fmt).join(' ');
        const useRel = r.length < a.length;
        const cmd = useRel ? 'a' : 'A';
        const nums = useRel ? relNums : absNums;
        // arc flags can be packed: radii, rotation, then flags without separators
        const strs = [fmt(nums[0]), fmt(nums[1]), fmt(nums[2])];
        const head = joinNumbersMinimal(strs, cmd === lastCmd ? lastNum : null);
        const tail = joinNumbersMinimal([fmt(nums[5]), fmt(nums[6])], null);
        const body = `${head} ${nums[3]}${nums[4]}${tail}`;
        out += cmd === lastCmd ? body : cmd + body;
        lastCmd = cmd;
        lastNum = fmt(nums[6]);
        if (useRel) {
          cx += nums[5];
          cy += nums[6];
        } else {
          cx = x;
          cy = y;
        }
        prevType = 'A';
        break;
      }
      case 'Z':
        out += 'Z';
        lastCmd = 'Z';
        lastNum = null;
        cx = sx;
        cy = sy;
        cz = sz;
        prevType = 'Z';
        break;
      default:
        break;
    }
  }
  return out;
}

function formatPathPretty(segments, fmt, dim) {
  const parts = [];
  const pt = (x, y, z) => (dim === 3 ? `${fmt(x)},${fmt(y)},${fmt(z || 0)}` : `${fmt(x)},${fmt(y)}`);
  for (const s of segments) {
    switch (s.c) {
      case 'M':
        if (!s.implicit) parts.push('M' + pt(s.x, s.y, s.z));
        break;
      case 'L':
        parts.push('L' + pt(s.x, s.y, s.z));
        break;
      case 'C':
        parts.push(`C${pt(s.x1, s.y1, s.z1)} ${pt(s.x2, s.y2, s.z2)} ${pt(s.x, s.y, s.z)}`);
        break;
      case 'Q':
        parts.push(`Q${pt(s.x1, s.y1, s.z1)} ${pt(s.x, s.y, s.z)}`);
        break;
      case 'A':
        parts.push(`A${fmt(s.rx)},${fmt(s.ry)} ${fmt(s.rot)} ${s.large},${s.sweep} ${pt(s.x, s.y)}`);
        break;
      case 'Z':
        parts.push('Z');
        break;
      default:
        break;
    }
  }
  return parts.join(' ');
}
