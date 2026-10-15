// Across the passes of one device: one row per backend, scene and format.
// The median is the figure to quote. The mean sits beside it so a single
// slow pass (a hitch, a warm phone) is visible rather than hidden.

export const SUMMARY_COLUMNS = [
  'session', 'run', 'device', 'device_type', 'gpu', 'backend', 'scene', 'scene_label', 'format', 'format_label',
  'n',
  'ready_median_ms', 'ready_mean_ms', 'ready_min_ms', 'ready_max_ms',
  'frame_median_ms', 'frame_mean_ms', 'frame_min_ms', 'frame_max_ms',
];

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stats(values) {
  if (!values.length) return { median: null, mean: null, min: null, max: null };
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { median: median(values), mean: mean(values), min, max };
}

const interrupted = (r) => r.interrupted === true || r.interrupted === 'true';

/**
 * @param {object[]} rows finished measurements (status ok). Interrupted passes are left out.
 */
export function summaryRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (interrupted(r)) continue;
    if (r.ready_ms == null && r.frame_ms == null) continue;
    const k = `${r.run}|${r.backend}|${r.scene}|${r.format}`;
    let g = groups.get(k);
    if (!g) {
      g = { row: r, ready: [], frame: [] };
      groups.set(k, g);
    }
    if (typeof r.ready_ms === 'number') g.ready.push(r.ready_ms);
    if (typeof r.frame_ms === 'number') g.frame.push(r.frame_ms);
  }
  const out = [];
  for (const g of groups.values()) {
    const r = g.row;
    const ready = stats(g.ready);
    const frame = stats(g.frame);
    out.push({
      session: r.session, run: r.run, device: r.device, device_type: r.device_type, gpu: r.gpu,
      backend: r.backend, scene: r.scene, scene_label: r.scene_label, format: r.format, format_label: r.format_label,
      n: Math.max(g.ready.length, g.frame.length),
      ready_median_ms: ready.median, ready_mean_ms: ready.mean, ready_min_ms: ready.min, ready_max_ms: ready.max,
      frame_median_ms: frame.median, frame_mean_ms: frame.mean, frame_min_ms: frame.min, frame_max_ms: frame.max,
    });
  }
  return out;
}
