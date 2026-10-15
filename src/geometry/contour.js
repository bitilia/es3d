// Per-vertex data for 2D contours shared by the extrusion, sweep and revolve
// generators: edge normals, smoothed vertex normals, miter (inset) vectors and
// cumulative arc length. Contours are oriented with the filled side on the
// left, so the right-hand perpendicular of an edge is its outward normal.

const MAX_MITER = 4;

export function contourFrames(points, smooth, closed = true) {
  const n = points.length / 2;
  const edges = closed ? n : n - 1;
  const edgeN = new Float64Array(edges * 2);
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % n;
    const dx = points[j * 2] - points[i * 2];
    const dy = points[j * 2 + 1] - points[i * 2 + 1];
    const l = Math.hypot(dx, dy) || 1;
    edgeN[i * 2] = dy / l;
    edgeN[i * 2 + 1] = -dx / l;
  }
  const vertN = new Float64Array(n * 2);
  const miter = new Float64Array(n * 2);
  const corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const pe = hasPrev ? (i - 1 + edges) % edges : -1;
    const ne = hasNext ? i % edges : -1;
    let ax, ay, bx, by;
    if (pe >= 0) {
      ax = edgeN[pe * 2];
      ay = edgeN[pe * 2 + 1];
    }
    if (ne >= 0) {
      bx = edgeN[ne * 2];
      by = edgeN[ne * 2 + 1];
    }
    if (pe < 0) {
      ax = bx;
      ay = by;
    }
    if (ne < 0) {
      bx = ax;
      by = ay;
    }
    let mx = ax + bx, my = ay + by;
    let ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = ax;
      my = ay;
      ml = 1;
    }
    mx /= ml;
    my /= ml;
    vertN[i * 2] = mx;
    vertN[i * 2 + 1] = my;
    const cosHalf = Math.max(mx * ax + my * ay, 1 / MAX_MITER);
    miter[i * 2] = mx / cosHalf;
    miter[i * 2 + 1] = my / cosHalf;
    corner[i] = smooth && smooth[i] ? 0 : 1;
  }
  const arc = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    if (!closed && i === n) {
      arc[i] = arc[i - 1];
      break;
    }
    const a = (i - 1) % n, b = i % n;
    arc[i] = arc[i - 1] + Math.hypot(points[b * 2] - points[a * 2], points[b * 2 + 1] - points[a * 2 + 1]);
  }
  return { n, edges, edgeN, vertN, miter, corner, arc, length: arc[closed ? n : n - 1] };
}

/** Bounds of a set of 2D point arrays. */
export function bounds2(list) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of list) {
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, size: Math.max(maxX - minX, maxY - minY) || 1 };
}
