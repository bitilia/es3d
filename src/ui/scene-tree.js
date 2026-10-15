// Scene tree: the document's element hierarchy with summaries, instance
// counts and selection. Expansion state survives re-parses (keyed by path).

import { h, clear } from './dom.js';
import { valueOf, elementSpec } from '../format/schema.js';
import { colorToHex } from '../format/colors.js';

export const ICONS = {
  es3d: '◆', scene: '◇', defs: '⌘', group: '▣', use: '⧉', repeat: '⟳', scatter: '⁘', lod: '◫',
  light: '☀', camera: '⌖', material: '◐', environment: '☁', title: 'T', desc: '¶', animate: '↻',
  box: '■', sphere: '●', cylinder: '▮', cone: '▲', capsule: '⬮', plane: '▱', torus: '◎', line: '╱',
  polyline: '〰', polygon: '⬠', path: '✎', extrude: '⬛', revolve: '◍', sweep: '➰', gear: '⚙', mesh: '▦',
};

const fmt = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Number(v.toFixed(3))));

export function summarize(el) {
  const v = el.values || {};
  switch (el.name) {
    case 'box': {
      const s = valueOf(el, 'size');
      return s[0] === s[1] && s[1] === s[2] ? `${fmt(s[0])}` : s.map(fmt).join('×');
    }
    case 'sphere':
    case 'capsule':
    case 'cylinder':
    case 'cone':
      return `r=${fmt(valueOf(el, 'radius'))}` + (el.name !== 'sphere' ? ` h=${fmt(valueOf(el, 'height'))}` : '');
    case 'torus':
      return `r=${fmt(valueOf(el, 'radius'))} t=${fmt(valueOf(el, 'tube'))}`;
    case 'use':
      return v.ref ? `→ ${v.ref}` : '';
    case 'repeat':
      return v.count !== undefined ? `×${v.count}` : '';
    case 'scatter':
      return v.grid ? `×${v.grid[0] * v.grid[1]} grid` : v.count !== undefined ? `×${v.count}` : '';
    case 'lod':
      return v.distances ? `${v.distances.length + 1} levels` : '';
    case 'light':
      return v.type || '';
    case 'camera':
      return valueOf(el, 'type');
    case 'gear':
      return `${valueOf(el, 'teeth')} teeth`;
    case 'extrude':
    case 'revolve':
    case 'path':
    case 'sweep':
      return v.path ? `path=${v.path}` : '';
    case 'mesh':
      return v.positions ? `${(v.positions.length / 3) | 0} verts` : '';
    case 'title':
    case 'desc':
      return el.text ? el.text.trim().slice(0, 40) : '';
    default:
      return '';
  }
}

export class SceneTree {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect || null;
    this.expanded = new Map(); // path -> bool
    this.rows = new Map(); // uid -> row element
    this.selected = 0;
    this.limit = new Map(); // path -> children shown
  }

  pathOf(el) {
    const parts = [];
    for (let e = el; e && e.parent; e = e.parent) parts.unshift(e.parent.children.filter((c) => c.type === 'element').indexOf(e));
    return parts.join('/');
  }

  isExpanded(el, depth) {
    const p = this.pathOf(el);
    if (this.expanded.has(p)) return this.expanded.get(p);
    if (el.name === 'defs') return false;
    return depth < 2;
  }

  setDocument(doc) {
    this.doc = doc;
    clear(this.container);
    this.rows.clear();
    if (!doc || !doc.root) return;
    const list = h('div', { class: 'tree', role: 'tree' });
    const add = (el, depth, into) => {
      const kids = el.children.filter((c) => c.type === 'element');
      const open = this.isExpanded(el, depth);
      const spec = elementSpec(el.name);
      const color = el.name === 'material' && el.values && el.values.color ? colorToHex(el.values.color) : el.values && el.values.color ? colorToHex(el.values.color) : null;
      const row = h(
        'div',
        {
          class: 'tree-row' + (el.uid === this.selected ? ' selected' : '') + (spec ? '' : ' unknown'),
          role: 'treeitem',
          style: { paddingLeft: `${6 + depth * 14}px` },
          title: spec ? spec.desc : 'Unknown element',
          onclick: (e) => {
            e.stopPropagation();
            this.select(el.uid, true);
          },
        },
        h(
          'span',
          {
            class: 'tree-toggle' + (kids.length ? '' : ' leaf'),
            onclick: (e) => {
              e.stopPropagation();
              if (!kids.length) return;
              this.expanded.set(this.pathOf(el), !open);
              this.setDocument(this.doc);
            },
          },
          kids.length ? (open ? '▾' : '▸') : '',
        ),
        h('span', { class: 'tree-icon' }, ICONS[el.name] || '•'),
        h('span', { class: 'tree-name' }, el.name),
        el.values && el.values.id !== undefined ? h('span', { class: 'tree-id' }, '#' + el.values.id) : null,
        color ? h('span', { class: 'swatch', style: { background: color } }) : null,
        h('span', { class: 'tree-summary' }, summarize(el)),
      );
      this.rows.set(el.uid, row);
      into.append(row);
      if (kids.length && open) {
        const p = this.pathOf(el);
        const max = this.limit.get(p) || 300;
        kids.slice(0, max).forEach((k) => add(k, depth + 1, into));
        if (kids.length > max) {
          into.append(
            h(
              'div',
              {
                class: 'tree-row tree-more',
                style: { paddingLeft: `${20 + (depth + 1) * 14}px` },
                onclick: () => {
                  this.limit.set(p, max + 1000);
                  this.setDocument(this.doc);
                },
              },
              `… ${kids.length - max} more`,
            ),
          );
        }
      }
    };
    add(doc.root, 0, list);
    this.container.append(list);
  }

  /** Select an element; expands its ancestors. */
  select(uid, notify = false) {
    this.selected = uid;
    const el = this.doc && this.doc.byUid.get(uid);
    if (el) {
      let changed = false;
      for (let p = el.parent; p; p = p.parent) {
        const path = this.pathOf(p);
        if (this.expanded.get(path) !== true && !(p.name !== 'defs' && !this.expanded.has(path) && this.depthOf(p) < 2)) {
          this.expanded.set(path, true);
          changed = true;
        }
      }
      if (changed || !this.rows.has(uid)) this.setDocument(this.doc);
    }
    for (const [u, row] of this.rows) row.classList.toggle('selected', u === uid);
    const row = this.rows.get(uid);
    if (row) row.scrollIntoView({ block: 'nearest' });
    if (notify && this.onSelect) this.onSelect(uid);
  }

  depthOf(el) {
    let d = 0;
    for (let p = el.parent; p; p = p.parent) d++;
    return d;
  }
}
