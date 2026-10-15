// Mouse / touch camera controls: orbit (left drag), pan (right or middle drag,
// or shift + left drag), zoom (wheel or pinch). Works for perspective and
// orthographic cameras. A document's <controls> element (scene.controls) can
// limit them and make the camera collide with the scene: see configure().

import { constrainCamera } from '../scene/camera-constraints.js';

export class OrbitControls {
  /**
   * @param {HTMLElement} element
   * @param {import('./camera.js').Camera} camera
   */
  constructor(element, camera) {
    this.el = element;
    this.camera = camera;
    this.enabled = true;
    this.enableZoom = true;
    this.enablePan = true;
    this.limits = null; // scene.controls: distance, angle and target limits, collision
    this.world = null; // () => ({scene, meshOf, isVisible}) for collision
    this.rotateSpeed = 0.006;
    this.zoomSpeed = 0.0015;
    this.onChange = null;
    this.onClick = null; // (x, y, event) for picking
    this.onDoubleClick = null;
    this.pointers = new Map();
    this.mode = null;
    this.moved = 0;
    this.last = null;
    this.pinch = null;

    this._down = (e) => this.pointerDown(e);
    this._move = (e) => this.pointerMove(e);
    this._up = (e) => this.pointerUp(e);
    this._wheel = (e) => this.wheel(e);
    this._ctx = (e) => e.preventDefault();
    this._dbl = (e) => {
      if (this.onDoubleClick) {
        const r = this.el.getBoundingClientRect();
        this.onDoubleClick(e.clientX - r.left, e.clientY - r.top, e);
      }
    };
    element.addEventListener('pointerdown', this._down);
    element.addEventListener('pointermove', this._move);
    element.addEventListener('pointerup', this._up);
    element.addEventListener('pointercancel', this._up);
    element.addEventListener('wheel', this._wheel, { passive: false });
    element.addEventListener('contextmenu', this._ctx);
    element.addEventListener('dblclick', this._dbl);
    element.style.touchAction = 'none';
  }

  dispose() {
    const el = this.el;
    el.removeEventListener('pointerdown', this._down);
    el.removeEventListener('pointermove', this._move);
    el.removeEventListener('pointerup', this._up);
    el.removeEventListener('pointercancel', this._up);
    el.removeEventListener('wheel', this._wheel);
    el.removeEventListener('contextmenu', this._ctx);
    el.removeEventListener('dblclick', this._dbl);
  }

  /**
   * Apply a document's <controls> (scene.controls, or null for free orbiting).
   * @param {object|null} spec
   * @param {{world?: () => object, ignoreMode?: boolean}} [opts] world supplies the
   *   scene for collision; ignoreMode keeps dragging on (an editor previewing limits).
   */
  configure(spec, opts = {}) {
    this.limits = spec;
    if (opts.world) this.world = opts.world;
    const mode = spec ? spec.mode : 'orbit';
    this.enabled = opts.ignoreMode || mode === 'orbit';
    this.enableZoom = !spec || spec.zoom !== false;
    this.enablePan = !spec || spec.pan !== false;
    // a canvas that does not orbit must let touch scrolling through to the page
    this.el.style.touchAction = this.enabled ? 'none' : 'auto';
  }

  changed() {
    if (this.onChange) this.onChange();
  }

  /** Camera state before a manipulation, for constrain(). */
  snapshot() {
    return { position: this.camera.position.slice(), target: this.camera.target.slice() };
  }

  /** Enforce limits and collision after a manipulation that started at `prev`. */
  constrain(prev) {
    if (!this.limits) return;
    const world = this.limits.collide && this.world ? this.world() : null;
    constrainCamera(prev, this.camera, this.limits, world);
  }

  pointerDown(e) {
    if (!this.enabled) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      this.mode = 'pinch';
      return;
    }
    if (e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey) this.mode = 'pan';
    else this.mode = 'orbit';
    this.last = { x: e.clientX, y: e.clientY };
  }

  pointerMove(e) {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const prev = this.snapshot();
    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (this.pinch.d > 0 && this.enableZoom) this.zoom(this.pinch.d / Math.max(d, 1));
      if (this.enablePan) this.pan(cx - this.pinch.cx, cy - this.pinch.cy);
      this.pinch = { d, cx, cy };
      this.moved += 10;
      this.constrain(prev);
      this.changed();
      return;
    }
    if (!this.last) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    this.moved += Math.abs(dx) + Math.abs(dy);
    if (this.mode === 'orbit') this.orbit(dx, dy);
    else if (this.mode === 'pan' && this.enablePan) this.pan(dx, dy);
    this.constrain(prev);
    this.changed();
  }

  pointerUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be released
    }
    if (this.pointers.size === 0) {
      if (this.moved < 4 && this.onClick && e.button === 0) {
        const r = this.el.getBoundingClientRect();
        this.onClick(e.clientX - r.left, e.clientY - r.top, e);
      }
      this.mode = null;
      this.last = null;
      this.pinch = null;
    } else if (this.pointers.size === 1) {
      const p = [...this.pointers.values()][0];
      this.mode = 'orbit';
      this.last = { x: p.x, y: p.y };
      this.pinch = null;
    }
  }

  wheel(e) {
    // without zoom the wheel scrolls the page
    if (!this.enabled || !this.enableZoom) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const prev = this.snapshot();
    this.zoom(Math.exp(delta * this.zoomSpeed));
    this.constrain(prev);
    this.changed();
  }

  orbit(dx, dy) {
    const c = this.camera;
    const off = [c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]];
    const r = Math.hypot(off[0], off[1], off[2]) || 1e-6;
    let theta = Math.atan2(off[0], off[2]);
    let phi = Math.acos(Math.max(-1, Math.min(1, off[1] / r)));
    theta -= dx * this.rotateSpeed;
    phi -= dy * this.rotateSpeed;
    phi = Math.max(0.001, Math.min(Math.PI - 0.001, phi));
    c.position = [
      c.target[0] + r * Math.sin(phi) * Math.sin(theta),
      c.target[1] + r * Math.cos(phi),
      c.target[2] + r * Math.sin(phi) * Math.cos(theta),
    ];
    c.up = [0, 1, 0];
  }

  pan(dx, dy) {
    const c = this.camera;
    const h = this.el.clientHeight || 1;
    const dist = c.distance;
    const unitsPerPixel = c.type === 'orthographic' ? c.orthoHeight / h : (2 * dist * Math.tan(((c.fov / 2) * Math.PI) / 180)) / h;
    // camera basis
    const f = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
    const fl = Math.hypot(...f) || 1;
    f[0] /= fl; f[1] /= fl; f[2] /= fl;
    let right = [f[1] * c.up[2] - f[2] * c.up[1], f[2] * c.up[0] - f[0] * c.up[2], f[0] * c.up[1] - f[1] * c.up[0]];
    const rl = Math.hypot(...right) || 1;
    right = right.map((v) => v / rl);
    const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
    const mx = -dx * unitsPerPixel, my = dy * unitsPerPixel;
    for (let k = 0; k < 3; k++) {
      const d = right[k] * mx + up[k] * my;
      c.position[k] += d;
      c.target[k] += d;
    }
  }

  zoom(factor) {
    const c = this.camera;
    if (c.type === 'orthographic') {
      c.orthoHeight = Math.max(1e-4, c.orthoHeight * factor);
      return;
    }
    const off = [c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]];
    const r = Math.hypot(...off);
    const nr = Math.max(1e-4, r * factor);
    for (let k = 0; k < 3; k++) c.position[k] = c.target[k] + (off[k] / (r || 1)) * nr;
  }

  /** Move the orbit centre to a point, keeping the viewing direction. */
  focus(point) {
    const c = this.camera;
    const prev = this.snapshot();
    const d = [point[0] - c.target[0], point[1] - c.target[1], point[2] - c.target[2]];
    for (let k = 0; k < 3; k++) {
      c.target[k] += d[k];
      c.position[k] += d[k];
    }
    this.constrain(prev);
    this.changed();
  }
}
