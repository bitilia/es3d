// Polygon triangulation with holes: src/path/triangulate.js operation for
// operation (ear clipping on a doubly linked list, hole bridging, z-order
// hashing, the degenerate-input fallbacks). Nodes live in a pool and link by
// index (-1 for none) instead of by reference.
//
// One case is left to JavaScript: when two holes share their leftmost point
// (or one is not finite), the hole order depends on how Array.prototype.sort
// treats ties, which this file does not reproduce.

#include "geometry.h"

typedef struct {
  double x, y;
  i32 i, z;
  i32 prev, next, prevZ, nextZ;
  i32 steiner;
} Node;

static Node *nodes;
static i32 node_count, node_cap;
static u32 *tris;
static i32 tri_count, tri_cap;
static int failed;

static i32 new_node(i32 i, double x, double y) {
  if (node_count == node_cap) {
    const i32 cap = node_cap * 2 + 16;
    Node *grown = es3d_alloc((u32)cap * sizeof(Node));
    if (!grown) {
      failed = 1;
      return 0;
    }
    for (i32 k = 0; k < node_count; k++) grown[k] = nodes[k];
    nodes = grown;
    node_cap = cap;
  }
  Node *p = &nodes[node_count];
  p->i = i;
  p->x = x;
  p->y = y;
  p->prev = p->next = p->prevZ = p->nextZ = -1;
  p->z = 0;
  p->steiner = 0;
  return node_count++;
}

static void push3(i32 a, i32 b, i32 c) {
  if (tri_count + 3 > tri_cap) {
    const i32 cap = tri_cap * 2 + 48;
    u32 *grown = es3d_alloc((u32)cap * 4u);
    if (!grown) {
      failed = 1;
      return;
    }
    for (i32 k = 0; k < tri_count; k++) grown[k] = tris[k];
    tris = grown;
    tri_cap = cap;
  }
  tris[tri_count++] = (u32)a;
  tris[tri_count++] = (u32)b;
  tris[tri_count++] = (u32)c;
}

#define N(k) (nodes[k])

static inline double area(i32 p, i32 q, i32 r) { return (N(q).y - N(p).y) * (N(r).x - N(q).x) - (N(q).x - N(p).x) * (N(r).y - N(q).y); }
static inline int equals(i32 a, i32 b) { return N(a).x == N(b).x && N(a).y == N(b).y; }
static inline int truthy(double v) { return v != 0 && v == v; }
static inline int sign(double v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

static i32 insert_node(i32 i, double x, double y, i32 last) {
  const i32 p = new_node(i, x, y);
  if (failed) return -1;
  if (last < 0) {
    N(p).prev = p;
    N(p).next = p;
  } else {
    N(p).next = N(last).next;
    N(p).prev = last;
    N(N(last).next).prev = p;
    N(last).next = p;
  }
  return p;
}

static void remove_node(i32 p) {
  N(N(p).next).prev = N(p).prev;
  N(N(p).prev).next = N(p).next;
  if (N(p).prevZ >= 0) N(N(p).prevZ).nextZ = N(p).nextZ;
  if (N(p).nextZ >= 0) N(N(p).nextZ).prevZ = N(p).prevZ;
}

static double signed_area(const double *data, i32 start, i32 end) {
  double sum = 0;
  for (i32 i = start, j = end - 2; i < end; i += 2) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}

static i32 linked_list(const double *data, i32 start, i32 end, int clockwise) {
  i32 last = -1;
  if (clockwise == (signed_area(data, start, end) > 0)) {
    for (i32 i = start; i < end; i += 2) last = insert_node(i / 2, data[i], data[i + 1], last);
  } else {
    for (i32 i = end - 2; i >= start; i -= 2) last = insert_node(i / 2, data[i], data[i + 1], last);
  }
  if (failed) return -1;
  if (last >= 0 && equals(last, N(last).next)) {
    remove_node(last);
    last = N(last).next;
  }
  return last;
}

static i32 filter_points(i32 start, i32 end) {
  if (start < 0) return start;
  if (end < 0) end = start;
  i32 p = start;
  int again;
  do {
    again = 0;
    if (!N(p).steiner && (equals(p, N(p).next) || area(N(p).prev, p, N(p).next) == 0)) {
      remove_node(p);
      p = end = N(p).prev;
      if (p == N(p).next) break;
      again = 1;
    } else {
      p = N(p).next;
    }
  } while (again || p != end);
  return end;
}

static i32 z_order(double xd, double yd, double minX, double minY, double invSize) {
  u32 x = (u32)js_toint32((xd - minX) * invSize);
  u32 y = (u32)js_toint32((yd - minY) * invSize);
  x = (x | (x << 8)) & 0x00ff00ffu;
  x = (x | (x << 4)) & 0x0f0f0f0fu;
  x = (x | (x << 2)) & 0x33333333u;
  x = (x | (x << 1)) & 0x55555555u;
  y = (y | (y << 8)) & 0x00ff00ffu;
  y = (y | (y << 4)) & 0x0f0f0f0fu;
  y = (y | (y << 2)) & 0x33333333u;
  y = (y | (y << 1)) & 0x55555555u;
  return (i32)(x | (y << 1));
}

static inline int point_in_triangle(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

static inline int point_in_triangle_except_first(double ax, double ay, double bx, double by, double cx, double cy, double px, double py) {
  return !(ax == px && ay == py) && point_in_triangle(ax, ay, bx, by, cx, cy, px, py);
}

static int is_ear(i32 ear) {
  const i32 a = N(ear).prev, b = ear, c = N(ear).next;
  if (area(a, b, c) >= 0) return 0; // reflex
  const double ax = N(a).x, bx = N(b).x, cx = N(c).x, ay = N(a).y, by = N(b).y, cy = N(c).y;
  const double x0 = js_min(js_min(ax, bx), cx), y0 = js_min(js_min(ay, by), cy);
  const double x1 = js_max(js_max(ax, bx), cx), y1 = js_max(js_max(ay, by), cy);
  i32 p = N(c).next;
  while (p != a) {
    if (N(p).x >= x0 && N(p).x <= x1 && N(p).y >= y0 && N(p).y <= y1 && point_in_triangle_except_first(ax, ay, bx, by, cx, cy, N(p).x, N(p).y) &&
        area(N(p).prev, p, N(p).next) >= 0)
      return 0;
    p = N(p).next;
  }
  return 1;
}

static inline int blocks(i32 p, i32 a, i32 c, double x0, double y0, double x1, double y1, double ax, double ay, double bx, double by, double cx, double cy) {
  return N(p).x >= x0 && N(p).x <= x1 && N(p).y >= y0 && N(p).y <= y1 && p != a && p != c && point_in_triangle_except_first(ax, ay, bx, by, cx, cy, N(p).x, N(p).y) &&
         area(N(p).prev, p, N(p).next) >= 0;
}

static int is_ear_hashed(i32 ear, double minX, double minY, double invSize) {
  const i32 a = N(ear).prev, b = ear, c = N(ear).next;
  if (area(a, b, c) >= 0) return 0;
  const double ax = N(a).x, bx = N(b).x, cx = N(c).x, ay = N(a).y, by = N(b).y, cy = N(c).y;
  const double x0 = js_min(js_min(ax, bx), cx), y0 = js_min(js_min(ay, by), cy);
  const double x1 = js_max(js_max(ax, bx), cx), y1 = js_max(js_max(ay, by), cy);
  const i32 minZ = z_order(x0, y0, minX, minY, invSize);
  const i32 maxZ = z_order(x1, y1, minX, minY, invSize);
  i32 p = N(ear).prevZ;
  i32 n = N(ear).nextZ;
  while (p >= 0 && N(p).z >= minZ && n >= 0 && N(n).z <= maxZ) {
    if (blocks(p, a, c, x0, y0, x1, y1, ax, ay, bx, by, cx, cy)) return 0;
    p = N(p).prevZ;
    if (blocks(n, a, c, x0, y0, x1, y1, ax, ay, bx, by, cx, cy)) return 0;
    n = N(n).nextZ;
  }
  while (p >= 0 && N(p).z >= minZ) {
    if (blocks(p, a, c, x0, y0, x1, y1, ax, ay, bx, by, cx, cy)) return 0;
    p = N(p).prevZ;
  }
  while (n >= 0 && N(n).z <= maxZ) {
    if (blocks(n, a, c, x0, y0, x1, y1, ax, ay, bx, by, cx, cy)) return 0;
    n = N(n).nextZ;
  }
  return 1;
}

static int on_segment(i32 p, i32 q, i32 r) {
  return N(q).x <= js_max(N(p).x, N(r).x) && N(q).x >= js_min(N(p).x, N(r).x) && N(q).y <= js_max(N(p).y, N(r).y) && N(q).y >= js_min(N(p).y, N(r).y);
}

static int intersects(i32 p1, i32 q1, i32 p2, i32 q2) {
  const int o1 = sign(area(p1, q1, p2));
  const int o2 = sign(area(p1, q1, q2));
  const int o3 = sign(area(p2, q2, p1));
  const int o4 = sign(area(p2, q2, q1));
  if (o1 != o2 && o3 != o4) return 1;
  if (o1 == 0 && on_segment(p1, p2, q1)) return 1;
  if (o2 == 0 && on_segment(p1, q2, q1)) return 1;
  if (o3 == 0 && on_segment(p2, p1, q2)) return 1;
  if (o4 == 0 && on_segment(p2, q1, q2)) return 1;
  return 0;
}

static int intersects_polygon(i32 a, i32 b) {
  i32 p = a;
  do {
    const i32 pn = N(p).next;
    if (N(p).i != N(a).i && N(pn).i != N(a).i && N(p).i != N(b).i && N(pn).i != N(b).i && intersects(p, pn, a, b)) return 1;
    p = pn;
  } while (p != a);
  return 0;
}

static int locally_inside(i32 a, i32 b) {
  return area(N(a).prev, a, N(a).next) < 0 ? area(a, b, N(a).next) >= 0 && area(a, N(a).prev, b) >= 0 : area(a, b, N(a).prev) < 0 || area(a, N(a).next, b) < 0;
}

static int middle_inside(i32 a, i32 b) {
  i32 p = a;
  int inside = 0;
  const double px = (N(a).x + N(b).x) / 2, py = (N(a).y + N(b).y) / 2;
  do {
    const i32 pn = N(p).next;
    if ((N(p).y > py) != (N(pn).y > py) && N(pn).y != N(p).y && px < ((N(pn).x - N(p).x) * (py - N(p).y)) / (N(pn).y - N(p).y) + N(p).x) inside = !inside;
    p = pn;
  } while (p != a);
  return inside;
}

static int is_valid_diagonal(i32 a, i32 b) {
  return N(N(a).next).i != N(b).i && N(N(a).prev).i != N(b).i && !intersects_polygon(a, b) &&
         ((locally_inside(a, b) && locally_inside(b, a) && middle_inside(a, b) && (truthy(area(N(a).prev, a, N(b).prev)) || truthy(area(a, N(b).prev, b)))) ||
          (equals(a, b) && area(N(a).prev, a, N(a).next) > 0 && area(N(b).prev, b, N(b).next) > 0));
}

static i32 split_polygon(i32 a, i32 b) {
  const i32 a2 = new_node(N(a).i, N(a).x, N(a).y);
  const i32 b2 = new_node(N(b).i, N(b).x, N(b).y);
  if (failed) return -1;
  const i32 an = N(a).next;
  const i32 bp = N(b).prev;
  N(a).next = b;
  N(b).prev = a;
  N(a2).next = an;
  N(an).prev = a2;
  N(b2).next = a2;
  N(a2).prev = b2;
  N(bp).next = b2;
  N(b2).prev = bp;
  return b2;
}

static i32 sort_linked(i32 list) {
  i32 num_merges;
  i32 in_size = 1;
  do {
    i32 p = list, e, tail = -1;
    list = -1;
    num_merges = 0;
    while (p >= 0) {
      num_merges++;
      i32 q = p;
      i32 p_size = 0;
      for (i32 i = 0; i < in_size; i++) {
        p_size++;
        q = N(q).nextZ;
        if (q < 0) break;
      }
      i32 q_size = in_size;
      while (p_size > 0 || (q_size > 0 && q >= 0)) {
        if (p_size != 0 && (q_size == 0 || q < 0 || N(p).z <= N(q).z)) {
          e = p;
          p = N(p).nextZ;
          p_size--;
        } else {
          e = q;
          q = N(q).nextZ;
          q_size--;
        }
        if (tail >= 0) N(tail).nextZ = e;
        else list = e;
        N(e).prevZ = tail;
        tail = e;
      }
      p = q;
    }
    N(tail).nextZ = -1;
    in_size *= 2;
  } while (num_merges > 1);
  return list;
}

static void index_curve(i32 start, double minX, double minY, double invSize) {
  i32 p = start;
  do {
    if (N(p).z == 0) N(p).z = z_order(N(p).x, N(p).y, minX, minY, invSize);
    N(p).prevZ = N(p).prev;
    N(p).nextZ = N(p).next;
    p = N(p).next;
  } while (p != start);
  N(N(p).prevZ).nextZ = -1;
  N(p).prevZ = -1;
  sort_linked(p);
}

static i32 cure_local_intersections(i32 start) {
  i32 p = start;
  do {
    const i32 a = N(p).prev, b = N(N(p).next).next;
    if (!equals(a, b) && intersects(a, p, N(p).next, b) && locally_inside(a, b) && locally_inside(b, a)) {
      push3(N(a).i, N(p).i, N(b).i);
      remove_node(p);
      remove_node(N(p).next);
      p = start = b;
    }
    p = N(p).next;
  } while (p != start);
  return filter_points(p, -1);
}

static void earcut_linked(i32 ear, double minX, double minY, double invSize, int pass, int depth);

static void split_earcut(i32 start, double minX, double minY, double invSize, int depth) {
  i32 a = start;
  do {
    i32 b = N(N(a).next).next;
    while (b != N(a).prev) {
      if (N(a).i != N(b).i && is_valid_diagonal(a, b)) {
        i32 c = split_polygon(a, b);
        if (failed) return;
        a = filter_points(a, N(a).next);
        c = filter_points(c, N(c).next);
        earcut_linked(a, minX, minY, invSize, 0, depth + 1);
        earcut_linked(c, minX, minY, invSize, 0, depth + 1);
        return;
      }
      b = N(b).next;
    }
    a = N(a).next;
  } while (a != start);
}

static void earcut_linked(i32 ear, double minX, double minY, double invSize, int pass, int depth) {
  if (ear < 0 || failed) return;
  // very deep splitting would overflow this module's stack: leave such input to JavaScript
  if (depth > 400) {
    failed = 1;
    return;
  }
  if (!pass && truthy(invSize)) index_curve(ear, minX, minY, invSize);
  i32 stop = ear;
  while (N(ear).prev != N(ear).next) {
    const i32 prev = N(ear).prev;
    const i32 next = N(ear).next;
    if (truthy(invSize) ? is_ear_hashed(ear, minX, minY, invSize) : is_ear(ear)) {
      push3(N(prev).i, N(ear).i, N(next).i);
      if (failed) return;
      remove_node(ear);
      // skipping the next vertex leads to fewer sliver triangles
      ear = N(next).next;
      stop = N(next).next;
      continue;
    }
    ear = next;
    if (ear == stop) {
      if (!pass) {
        earcut_linked(filter_points(ear, -1), minX, minY, invSize, 1, depth + 1);
      } else if (pass == 1) {
        ear = cure_local_intersections(filter_points(ear, -1));
        earcut_linked(ear, minX, minY, invSize, 2, depth + 1);
      } else if (pass == 2) {
        split_earcut(ear, minX, minY, invSize, depth + 1);
      }
      break;
    }
  }
}

static i32 get_leftmost(i32 start) {
  i32 p = start, leftmost = start;
  do {
    if (N(p).x < N(leftmost).x || (N(p).x == N(leftmost).x && N(p).y < N(leftmost).y)) leftmost = p;
    p = N(p).next;
  } while (p != start);
  return leftmost;
}

static int sector_contains_sector(i32 m, i32 p) { return area(N(m).prev, m, N(p).prev) < 0 && area(N(p).next, m, N(m).next) < 0; }

static i32 find_hole_bridge(i32 hole, i32 outer) {
  i32 p = outer;
  const double hx = N(hole).x, hy = N(hole).y;
  double qx = -__builtin_inf();
  i32 m = -1;
  if (equals(hole, p)) return p;
  do {
    const i32 pn = N(p).next;
    if (equals(hole, pn)) return pn;
    if (hy <= N(p).y && hy >= N(pn).y && N(pn).y != N(p).y) {
      const double x = N(p).x + ((hy - N(p).y) * (N(pn).x - N(p).x)) / (N(pn).y - N(p).y);
      if (x <= hx && x > qx) {
        qx = x;
        m = N(p).x < N(pn).x ? p : pn;
        if (x == hx) return m;
      }
    }
    p = pn;
  } while (p != outer);
  if (m < 0) return -1;
  const i32 stop = m;
  const double mx = N(m).x, my = N(m).y;
  double tan_min = __builtin_inf();
  p = m;
  do {
    if (hx >= N(p).x && N(p).x >= mx && hx != N(p).x && point_in_triangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, N(p).x, N(p).y)) {
      const double tan = js_abs(hy - N(p).y) / (hx - N(p).x);
      if (locally_inside(p, hole) && (tan < tan_min || (tan == tan_min && (N(p).x > N(m).x || (N(p).x == N(m).x && sector_contains_sector(m, p)))))) {
        m = p;
        tan_min = tan;
      }
    }
    p = N(p).next;
  } while (p != stop);
  return m;
}

static i32 eliminate_hole(i32 hole, i32 outer) {
  const i32 bridge = find_hole_bridge(hole, outer);
  if (bridge < 0) return outer;
  const i32 bridge_reverse = split_polygon(bridge, hole);
  if (failed) return outer;
  filter_points(bridge_reverse, N(bridge_reverse).next);
  return filter_points(bridge, N(bridge).next);
}

static u32 no_triangles[1];

/**
 * Triangulate data[0, n) (x y pairs) with holes starting at the given vertex
 * indices: the triangle indices and their count, or 0 when JavaScript must do
 * it (memory, recursion depth, or a hole order that depends on ties).
 */
u32 *earcut(const double *data, i32 n, const i32 *holes, i32 nh, i32 *count) {
  nodes = 0;
  node_count = node_cap = 0;
  tris = 0;
  tri_count = tri_cap = 0;
  failed = 0;
  const i32 outer_len = nh ? holes[0] * 2 : n;
  i32 outer = linked_list(data, 0, outer_len, 1);
  if (failed) return 0;
  if (outer < 0 || N(outer).next == N(outer).prev) {
    *count = 0;
    return no_triangles;
  }
  if (nh) {
    i32 *queue = es3d_alloc((u32)nh * 4u);
    if (!queue) return 0;
    i32 q = 0;
    for (i32 h = 0; h < nh; h++) {
      const i32 start = holes[h] * 2;
      const i32 end = h < nh - 1 ? holes[h + 1] * 2 : n;
      const i32 list = linked_list(data, start, end, 0);
      if (failed) return 0;
      if (list < 0) continue;
      if (list == N(list).next) N(list).steiner = 1;
      queue[q++] = get_leftmost(list);
    }
    // sort by x, then y (a strict order when no two leftmost points coincide)
    for (i32 a = 0; a < q; a++) {
      // x - x is NaN for NaN and the infinities, which the JavaScript comparator turns into ties
      if (N(queue[a]).x - N(queue[a]).x != 0 || N(queue[a]).y - N(queue[a]).y != 0) return 0;
      for (i32 b = a + 1; b < q; b++)
        if (N(queue[a]).x == N(queue[b]).x && N(queue[a]).y == N(queue[b]).y) return 0;
    }
    for (i32 a = 1; a < q; a++) {
      const i32 v = queue[a];
      i32 b = a - 1;
      while (b >= 0 && (N(queue[b]).x > N(v).x || (N(queue[b]).x == N(v).x && N(queue[b]).y > N(v).y))) {
        queue[b + 1] = queue[b];
        b--;
      }
      queue[b + 1] = v;
    }
    for (i32 k = 0; k < q; k++) {
      outer = eliminate_hole(queue[k], outer);
      if (failed) return 0;
    }
  }
  double minX = 0, minY = 0, invSize = 0;
  if (n > 80 * 2) {
    minX = __builtin_inf();
    minY = __builtin_inf();
    double maxX = -__builtin_inf(), maxY = -__builtin_inf();
    for (i32 i = 0; i < outer_len; i += 2) {
      const double x = data[i], y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    invSize = js_max(maxX - minX, maxY - minY);
    invSize = invSize != 0 ? 32767 / invSize : 0;
  }
  earcut_linked(outer, minX, minY, invSize, 0, 0);
  if (failed) return 0;
  *count = tri_count;
  return tri_count ? tris : no_triangles;
}

static u32 result[2];

/** earcut for JavaScript: a pointer to {index count, indices}, or 0. */
EXPORT("triangulate") u32 *triangulate(const double *data, i32 n, const i32 *holes, i32 nh) {
  i32 count = 0;
  u32 *t = earcut(data, n, holes, nh, &count);
  if (!t) return 0;
  result[0] = (u32)count;
  result[1] = (u32)t;
  return result;
}
