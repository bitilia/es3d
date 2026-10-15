// Statistics panel: source size, compression, scene expansion, GPU memory,
// timings and rendering counters.

import { h, clear, formatBytes, formatCount, formatMs } from './dom.js';

export class StatsPanel {
  constructor(container) {
    this.container = container;
    this.data = {};
    this.compare = null;
  }

  update(data) {
    Object.assign(this.data, data);
    this.render();
  }

  render() {
    const d = this.data;
    const rows = [];
    const section = (title) => rows.push(h('div', { class: 'st-section' }, title));
    const row = (k, v, title) => rows.push(h('div', { class: 'st-row', title: title || '' }, h('span', {}, k), h('span', {}, v)));
    section('Source');
    row('Syntax', d.syntax || '–');
    row('Size', formatBytes(d.sourceBytes));
    row('gzip', d.gzipBytes ? `${formatBytes(d.gzipBytes)} (${((d.gzipBytes / Math.max(1, d.sourceBytes)) * 100).toFixed(0)}%)` : '…');
    if (d.loadedBytes && d.loadedBytes !== d.sourceBytes) row('Loaded file', formatBytes(d.loadedBytes));
    row('Elements', formatCount(d.elements));
    section('Scene');
    row('Shape elements', formatCount(d.shapes));
    row('Instances', formatCount(d.instances), 'Drawable instances after expanding use / repeat / scatter');
    row('Unique geometries', formatCount(d.geometries));
    row('Materials', formatCount(d.materials));
    row('Lights / cameras', `${formatCount(d.lights)} / ${formatCount(d.cameras)}`);
    if (d.animated) row('Animated subtrees', formatCount(d.animated));
    section('Geometry');
    row('Generated vertices', formatCount(d.genVertices), 'Unique vertices tessellated (all LODs used so far)');
    row('Generated triangles', formatCount(d.genTriangles));
    row('Equivalent triangles', formatCount(d.equivalentTriangles), 'Triangles a flattened mesh format would store at full detail');
    row('GPU geometry', formatBytes(d.geometryBytes));
    row('GPU instances', formatBytes(d.instanceBytes));
    row('Expansion', d.expansion ? `${d.expansion.toFixed(0)}× source size` : '–', 'Flattened full-detail mesh bytes (32 B/vertex, 4 B/index) divided by the source size');
    section('Timings');
    row('Parse + validate', formatMs(d.parseMs));
    row('Scene graph', formatMs(d.buildMs));
    row('Flatten', formatMs(d.flattenMs));
    row('Tessellation', formatMs(d.tessMs));
    section('Rendering');
    row('Backend', d.backend || '–');
    row('FPS', d.fps ? d.fps.toFixed(0) : '–');
    row('Frame CPU', formatMs(d.frameMs));
    row('Draw calls', formatCount(d.drawCalls));
    row('Triangles drawn', formatCount(d.triangles));
    row('Visible / culled', `${formatCount(d.visible)} / ${formatCount(d.culled)}`);
    if (d.lodHistogram) row('LOD 0/1/2/3', d.lodHistogram.map(formatCount).join(' / '));
    if (this.compare) {
      section('Equivalent formats');
      for (const c of this.compare) row(c.label, c.gzip ? `${formatBytes(c.raw)} (gz ${formatBytes(c.gzip)})` : formatBytes(c.raw));
    }
    clear(this.container).append(...rows);
  }
}
