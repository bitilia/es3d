// Camera model shared by both GPU backends.

import * as mat4 from '../math/mat4.js';

export class Camera {
  constructor() {
    this.type = 'perspective';
    this.position = [6, 4, 8];
    this.target = [0, 0, 0];
    this.up = [0, 1, 0];
    this.fov = 45; // vertical, degrees
    this.orthoHeight = 10;
    this.near = null; // null = automatic from scene bounds
    this.far = null;
    // fov (or orthoHeight) is the vertical extent at this reference aspect ratio;
    // fit says how other aspect ratios are derived from it (see verticalFov)
    this.refAspect = 1;
    this.fit = 'contain';
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();
    this.invViewProj = mat4.create();
    this.currentNear = 0.1;
    this.currentFar = 1000;
  }

  /** Configure from a camera description produced by the flattener. */
  fromSpec(c) {
    this.type = c.type || 'perspective';
    this.position = c.position.slice();
    this.target = c.target.slice();
    this.up = c.up.slice();
    this.fov = c.fov || 45;
    this.orthoHeight = c.height || 10;
    this.near = c.near || null;
    this.far = c.far || null;
    this.refAspect = c.aspect || 1;
    this.fit = c.fit || 'contain';
    return this;
  }

  clone() {
    const c = new Camera();
    c.type = this.type;
    c.position = this.position.slice();
    c.target = this.target.slice();
    c.up = this.up.slice();
    c.fov = this.fov;
    c.orthoHeight = this.orthoHeight;
    c.near = this.near;
    c.far = this.far;
    c.refAspect = this.refAspect;
    c.fit = this.fit;
    return c;
  }

  /**
   * Factor that turns the reference vertical extent into the one for a viewport
   * aspect ratio. The reference view is refAspect wide and 1 high:
   * contain shows all of it (like SVG's "meet"), cover fills the viewport with
   * it ("slice"), width keeps its width and height keeps its height.
   */
  extentScale(aspect) {
    const A = this.refAspect > 0 ? this.refAspect : 1;
    const keepWidth = A / aspect; // vertical extent that keeps the reference width
    switch (this.fit) {
      case 'cover':
        return Math.min(1, keepWidth);
      case 'width':
        return keepWidth;
      case 'height':
        return 1;
      default:
        return Math.max(1, keepWidth);
    }
  }

  get distance() {
    return Math.hypot(this.position[0] - this.target[0], this.position[1] - this.target[1], this.position[2] - this.target[2]);
  }

  /** Frame an axis aligned bounding box. */
  frame(bounds, dir = [0.62, 0.5, 0.75]) {
    const c = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
    const r = Math.max(1e-3, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2);
    const l = Math.hypot(...dir);
    const d = this.type === 'orthographic' ? r * 3 : (r / Math.sin(((this.fov / 2) * Math.PI) / 180)) * 1.05;
    this.target = c;
    this.position = [c[0] + (dir[0] / l) * d, c[1] + (dir[1] / l) * d, c[2] + (dir[2] / l) * d];
    this.up = [0, 1, 0];
    this.orthoHeight = r * 2.2;
    // the distance above assumes fov applies to the shorter viewport side
    this.refAspect = 1;
    this.fit = 'contain';
    return this;
  }

  /**
   * Update view / projection matrices.
   * @param {number} aspect
   * @param {boolean} zeroToOne WebGPU depth range
   * @param {{min:number[],max:number[]}} [bounds] scene bounds for automatic near/far
   */
  update(aspect, zeroToOne, bounds) {
    mat4.lookAt(this.view, this.position, this.target, this.up);
    let near = this.near;
    let far = this.far;
    if (near === null || far === null) {
      let autoNear = 0.05;
      let autoFar = 2000;
      if (bounds) {
        const c = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
        const R = Math.max(1e-3, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2);
        const d = Math.hypot(this.position[0] - c[0], this.position[1] - c[1], this.position[2] - c[2]);
        autoFar = (d + R) * 1.5 + 1e-3;
        // outside the bounds the near plane can sit just before the scene;
        // inside it is a small fraction of the scene size
        autoNear = Math.max((d - R) * 0.5, R * 0.002, autoFar / 50000, 1e-4);
      }
      if (near === null) near = autoNear;
      if (far === null) far = Math.max(autoFar, near * 10);
    }
    this.currentNear = near;
    this.currentFar = far;
    // Like SVG's preserveAspectRatio, the framed view (fov or the orthographic
    // height at refAspect) is fitted to the viewport, so what the author framed
    // stays framed on every screen shape. The default (contain, aspect 1)
    // applies fov to the shorter side.
    if (this.type === 'orthographic') {
      const h = (this.orthoHeight * this.extentScale(aspect)) / 2;
      const w = h * aspect;
      mat4.ortho(this.proj, -w, w, -h, h, this.near === null ? -far : near, far, zeroToOne);
    } else {
      mat4.perspective(this.proj, this.verticalFov(aspect), aspect, near, far, zeroToOne);
    }
    this.aspect = aspect;
    mat4.multiply(this.viewProj, this.proj, this.view);
    mat4.invert(this.invViewProj, this.viewProj);
  }

  /** Vertical field of view in radians for a viewport aspect ratio. */
  verticalFov(aspect) {
    const f = (this.fov * Math.PI) / 180;
    const s = this.extentScale(aspect);
    return s === 1 ? f : 2 * Math.atan(Math.tan(f / 2) * s);
  }

  /** World-space ray through a pixel (x, y in CSS pixels from the top-left). */
  ray(x, y, width, height, zeroToOne = false) {
    const nx = (x / width) * 2 - 1;
    const ny = 1 - (y / height) * 2;
    const z0 = zeroToOne ? 0 : -1;
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    mat4.transformPoint(a, this.invViewProj, nx, ny, z0);
    mat4.transformPoint(b, this.invViewProj, nx, ny, 1);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return { origin: a, dir: [d[0] / l, d[1] / l, d[2] / l] };
  }

  /** Pixels per world unit at a distance (used for level-of-detail selection). */
  pixelsPerUnit(distance, viewportHeight) {
    const aspect = this.aspect || 1;
    if (this.type === 'orthographic') return viewportHeight / (this.orthoHeight * this.extentScale(aspect));
    return viewportHeight / (2 * Math.max(distance, 1e-6) * Math.tan(this.verticalFov(aspect) / 2));
  }
}
