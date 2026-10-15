// The side-by-side view of a LAN session: one row per device, backend and
// scene, with every format's ready and frame time next to each other, and
// ES3D's ready time divided by glTF's as three.js loads and draws it (the
// faster of plain and instanced GLB): below 1, ES3D was ready first.

/** The glTF-in-three.js formats ES3D is compared with. */
export const REFERENCE_FORMATS = ['three-glb', 'three-glb-inst'];

/** Columns of comparison.csv for these formats (in the session's order). */
export function comparisonColumns(formats) {
  const cols = ['session', 'run', 'device', 'device_type', 'gpu', 'repeat', 'backend', 'scene', 'scene_label'];
  for (const f of formats) cols.push(`${f}_ready_ms`, `${f}_frame_ms`);
  cols.push('reference', 'es3d_vs_reference', 'es3d_cached_vs_reference', 'es3d_progressive_first_vs_reference');
  return cols;
}

/**
 * @param {{session: string, run: string, device: string, device_type: string, gpu: string, repeat: number, backend: string, scene: string, scene_label: string, format: string, ready_ms: number|null, frame_ms: number|null, first_frame_ms?: number|null, load_ms?: number|null}[]} rows ok results
 * @param {string[]} formats
 */
export function comparisonRows(rows, formats) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.run}|${r.repeat}|${r.backend}|${r.scene}`;
    let g = groups.get(k);
    if (!g) {
      g = { session: r.session, run: r.run, device: r.device, device_type: r.device_type, gpu: r.gpu, repeat: r.repeat, backend: r.backend, scene: r.scene, scene_label: r.scene_label, by: new Map() };
      groups.set(k, g);
    }
    g.by.set(r.format, r);
  }
  const ratio = (a, b) => (a != null && b ? a / b : null);
  const out = [];
  for (const g of groups.values()) {
    const row = { session: g.session, run: g.run, device: g.device, device_type: g.device_type, gpu: g.gpu, repeat: g.repeat, backend: g.backend, scene: g.scene, scene_label: g.scene_label };
    for (const f of formats) {
      const r = g.by.get(f);
      row[`${f}_ready_ms`] = r ? r.ready_ms : null;
      row[`${f}_frame_ms`] = r ? r.frame_ms : null;
    }
    const refs = REFERENCE_FORMATS.map((f) => g.by.get(f)).filter((r) => r && r.ready_ms != null);
    const ref = refs.length ? refs.reduce((a, b) => (a.ready_ms <= b.ready_ms ? a : b)) : null;
    row.reference = ref ? ref.format : '';
    const ready = (f) => (g.by.get(f) ? g.by.get(f).ready_ms : null);
    row.es3d_vs_reference = ref ? ratio(ready('es3d'), ref.ready_ms) : null;
    row.es3d_cached_vs_reference = ref ? ratio(ready('es3d-cached'), ref.ready_ms) : null;
    // what a visitor sees first: the progressive format's load + first frame
    row.es3d_progressive_first_vs_reference = ref ? ratio(ready('es3d-progressive'), ref.ready_ms) : null;
    out.push(row);
  }
  return out;
}
