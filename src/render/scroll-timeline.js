// Page scroll -> animation progress for timeline="scroll" animations.
//
// Progress runs from 0 to 1 while a section of the page scrolls past. The
// usual layout is a tall section with a sticky canvas inside it:
//
//   <section id="tour" style="height: 400vh">
//     <div style="position: sticky; top: 0; height: 100vh"> canvas </div>
//     <p data-es3d-stop>…</p> <p data-es3d-stop="0.5">…</p> …
//   </section>
//
// Without stops, progress is 0 when the section's top reaches the top of the
// viewport and 1 when its bottom reaches the bottom. Elements inside it with
// data-es3d-stop pin progress values to page content instead: a stop is
// reached when the element's centre is at the viewport's centre (its value,
// or i / (n - 1) for the i-th of n stops when the attribute is empty), and
// progress is interpolated between stops. Give the camera's keyTimes the same
// values and each key view lines up with its paragraph.
//
// Scroll events only mark the timeline stale; update() reads layout at most
// once per frame. The value eases towards the scroll position so wheel steps
// do not jerk the camera. With reduced motion it jumps from stop to stop.

const reducedMotionQuery = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ScrollTimeline {
  /**
   * @param {HTMLElement} section element whose scroll position drives progress
   * @param {{smoothing?: number, reducedMotion?: boolean}} [opts] smoothing: time constant in seconds (0 = none)
   */
  constructor(section, opts = {}) {
    this.section = section;
    this.smoothing = opts.smoothing ?? 0.12;
    this.reducedMotion = opts.reducedMotion ?? reducedMotionQuery();
    this.value = NaN; // current (smoothed) progress
    this.target = 0; // progress the scroll position asks for
    this.stale = true;
    this.markStale = () => {
      this.stale = true;
    };
    addEventListener('scroll', this.markStale, { passive: true, capture: true });
    addEventListener('resize', this.markStale, { passive: true });
  }

  dispose() {
    removeEventListener('scroll', this.markStale, { capture: true });
    removeEventListener('resize', this.markStale);
  }

  /** Stops inside the section: [{el, value}] in document order. */
  stops() {
    const els = [...this.section.querySelectorAll('[data-es3d-stop]')];
    return els.map((el, i) => {
      const raw = el.getAttribute('data-es3d-stop');
      const v = raw === null || raw.trim() === '' ? (els.length > 1 ? i / (els.length - 1) : 0) : Number(raw);
      return { el, value: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0 };
    });
  }

  /** Progress for the current scroll position (reads layout). */
  measure() {
    const vh = innerHeight || 1;
    const stops = this.stops();
    if (!stops.length) {
      const r = this.section.getBoundingClientRect();
      const range = r.height - vh;
      if (range <= 0) return r.top <= 0 ? 1 : 0;
      return Math.min(1, Math.max(0, -r.top / range));
    }
    // signed distance of each stop's centre below the viewport centre
    const d = stops.map((s) => {
      const r = s.el.getBoundingClientRect();
      return r.top + r.height / 2 - vh / 2;
    });
    if (d[0] >= 0) return stops[0].value;
    const last = stops.length - 1;
    if (d[last] <= 0) return stops[last].value;
    let i = 0;
    while (i < last - 1 && d[i + 1] <= 0) i++;
    const u = d[i] === d[i + 1] ? 0 : -d[i] / (d[i + 1] - d[i]);
    if (this.reducedMotion) return u < 0.5 ? stops[i].value : stops[i + 1].value;
    return stops[i].value + (stops[i + 1].value - stops[i].value) * u;
  }

  /**
   * Advance by dt seconds. Returns true when the value changed (redraw).
   * @param {number} dt
   */
  update(dt) {
    if (this.stale) {
      this.stale = false;
      this.target = this.measure();
    }
    if (Number.isNaN(this.value) || this.reducedMotion || !(this.smoothing > 0)) {
      if (this.value === this.target) return false;
      this.value = this.target;
      return true;
    }
    const diff = this.target - this.value;
    if (diff === 0) return false;
    if (Math.abs(diff) < 1e-4) this.value = this.target;
    else this.value += diff * (1 - Math.exp(-Math.max(dt, 0) / this.smoothing));
    return true;
  }
}
