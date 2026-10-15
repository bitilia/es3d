// Contours -> fill regions (polygons with holes) following SVG fill rules.
//
// Closed contours are organised into a containment tree. A contour's interior
// (minus its children) is filled when its nesting depth is even ("evenodd") or
// when the accumulated winding number is non-zero ("nonzero", SVG default).
// Side walls for extrusions/sweeps exist exactly where the fill state changes
// across a contour; walls are oriented with the filled side on the left so the
// right-hand perpendicular of each edge is the outward normal.

import { signedArea, reverseContour } from './path-flatten.js';
import { triangulate, triangulationError } from './triangulate.js';

function pointInPolygon(points, x, y) {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2], yi = points[i * 2 + 1];
    const xj = points[j * 2], yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** A sample point strictly inside the contour near its first vertex (robust against shared vertices). */
function samplePoint(points) {
  const n = points.length / 2;
  // centroid of a small triangle at a convex-ish vertex works for most inputs;
  // fall back to the first vertex.
  for (let k = 0; k < Math.min(n, 8); k++) {
    const i0 = ((k - 1 + n) % n) * 2, i1 = k * 2, i2 = ((k + 1) % n) * 2;
    const cx = (points[i0] + points[i1] + points[i2]) / 3;
    const cy = (points[i0 + 1] + points[i1 + 1] + points[i2 + 1]) / 3;
    if (pointInPolygon(points, cx, cy)) return [cx, cy];
  }
  return [points[0], points[1]];
}

/**
 * @param {{points: Float64Array, smooth: Uint8Array}[]} contours 2D contours (treated as closed)
 * @param {'nonzero'|'evenodd'} fillRule
 */
export function buildRegions(contours, fillRule = 'nonzero') {
  const items = [];
  for (const c of contours) {
    if (c.points.length < 6) continue;
    const a = signedArea(c.points);
    if (Math.abs(a) < 1e-14) continue;
    items.push({ c, area: a, abs: Math.abs(a), box: bbox(c.points), parent: -1, depth: 0, winding: 0, children: [] });
  }
  items.sort((p, q) => q.abs - p.abs);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const [sx, sy] = samplePoint(it.c.points);
    for (let j = i - 1; j >= 0; j--) {
      const cand = items[j];
      const b = cand.box;
      if (sx < b.minX || sx > b.maxX || sy < b.minY || sy > b.maxY) continue;
      if (pointInPolygon(cand.c.points, sx, sy)) {
        it.parent = j;
        break;
      }
    }
    const sgn = it.area > 0 ? 1 : -1;
    if (it.parent >= 0) {
      const p = items[it.parent];
      it.depth = p.depth + 1;
      it.winding = p.winding + sgn;
      p.children.push(i);
    } else {
      it.depth = 0;
      it.winding = sgn;
    }
    it.filled = fillRule === 'evenodd' ? it.depth % 2 === 0 : it.winding !== 0;
  }

  // A contour is a wall where the fill state differs on its two sides.
  for (const it of items) it.isWall = it.filled !== (it.parent >= 0 ? items[it.parent].filled : false);
  const oriented = (it, wantCcw) => {
    const c = (signedArea(it.c.points) > 0) === wantCcw ? it.c : reverseContour(it.c);
    return { ...c, isWall: it.isWall };
  };

  const regions = [];
  const walls = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.filled) {
      regions.push({ outer: oriented(it, true), holes: it.children.map((k) => oriented(items[k], false)) });
    }
    if (it.isWall) walls.push(oriented(it, it.filled));
  }
  return { regions, walls };
}

/**
 * Triangulate a region; returns {positions: Float64Array (2D), smooth, indices, error}.
 * `error` is the relative area mismatch (large = self-intersecting input).
 */
export function triangulateRegion(region) {
  let total = region.outer.points.length;
  for (const h of region.holes) total += h.points.length;
  const data = new Float64Array(total);
  const smooth = new Uint8Array(total / 2);
  data.set(region.outer.points, 0);
  smooth.set(region.outer.smooth, 0);
  const holeIndices = [];
  let off = region.outer.points.length;
  for (const h of region.holes) {
    holeIndices.push(off / 2);
    data.set(h.points, off);
    smooth.set(h.smooth, off / 2);
    off += h.points.length;
  }
  const indices = triangulate(data, holeIndices.length ? holeIndices : null);
  const error = triangulationError(data, holeIndices.length ? holeIndices : null, indices);
  return { positions: data, smooth, indices, holeIndices, error };
}
