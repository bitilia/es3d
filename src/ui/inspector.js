// Object / property inspector: shows the selected element's attributes with
// typed widgets; edits are turned into minimal source text edits by the app.

import { h, clear, formatCount } from './dom.js';
import { elementSpec, valueOf, CONTAINERS } from '../format/schema.js';
import { colorToHex } from '../format/colors.js';
import { formatAttrValue } from '../format/serializer.js';
import { widgetFor, SNIPPETS } from './text-edits.js';
import { summarize } from './scene-tree.js';

function defaultRaw(elName, canonical, spec) {
  const d = spec.default;
  if (d === undefined) {
    switch (spec.type) {
      case 'vec3':
        return '0,0,0';
      case 'color':
        return '#ffffff';
      case 'bool':
        return 'true';
      case 'transform':
        return 'translate(0,0,0)';
      case 'number':
      case 'angle':
        return '1';
      case 'ref':
        return '';
      default:
        return '';
    }
  }
  const fake = { name: elName, values: { [canonical]: d } };
  return formatAttrValue(fake, canonical, '', { normalize: true, pretty: true, precision: null });
}

export class Inspector {
  /**
   * @param {HTMLElement} container
   * @param {object} handlers {onEdit(el, name, raw), onRemove(el, name), onDelete(el), onAddChild(el, kind), onReveal(el), onSelect(uid)}
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.h = handlers;
  }

  empty(message) {
    clear(this.container).append(h('div', { class: 'insp-empty' }, message));
  }

  /**
   * @param {import('../format/ast.js').Document} doc
   * @param {import('../format/ast.js').Element} el
   * @param {{instances?: number, geometry?: object, diagnostics?: object[]}} info
   */
  show(doc, el, info = {}) {
    clear(this.container);
    if (!el) return this.empty('Select an element in the scene tree or click an object in the viewport.');
    const spec = elementSpec(el.name);
    const header = h(
      'div',
      { class: 'insp-head' },
      h('div', { class: 'insp-title' }, h('code', {}, `<${el.name}>`), el.values && el.values.id !== undefined ? h('span', { class: 'insp-id' }, '#' + el.values.id) : null, h('span', { class: 'insp-summary' }, summarize(el))),
      h(
        'div',
        { class: 'insp-actions' },
        h('button', { class: 'small', title: 'Show this element in the source', onclick: () => this.h.onReveal && this.h.onReveal(el) }, 'Source'),
        el.parent ? h('button', { class: 'small danger', title: 'Delete this element', onclick: () => this.h.onDelete && this.h.onDelete(el) }, 'Delete') : null,
      ),
    );
    this.container.append(header);
    if (spec) this.container.append(h('p', { class: 'insp-desc' }, spec.desc));
    if (info.instances !== undefined) {
      this.container.append(h('div', { class: 'insp-meta' }, `${formatCount(info.instances)} rendered instance${info.instances === 1 ? '' : 's'}`));
    }
    if (info.geometry) {
      const g = info.geometry;
      this.container.append(
        h('div', { class: 'insp-meta' }, `Geometry: ${formatCount(g.triangles)} triangles at full detail, ${g.lods} level${g.lods === 1 ? '' : 's'} of detail${g.shared > 1 ? `, shared by ${formatCount(g.shared)} instances` : ''}`),
      );
    }
    if (el.name === 'use' && el.target) {
      this.container.append(
        h('div', { class: 'insp-meta' }, 'Instance of ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), this.h.onSelect && this.h.onSelect(el.target.uid)) }, `#${el.values.ref} <${el.target.name}>`)),
      );
    }
    const diagByAttr = new Map();
    for (const d of info.diagnostics || []) {
      for (const [k, a] of Object.entries(el.attrIndex || {})) {
        if (a && d.offset >= a.nameStart && d.offset <= a.valueEnd + 1) diagByAttr.set(k, d);
      }
    }
    if (!spec) return;
    const table = h('div', { class: 'insp-attrs' });
    const present = Object.keys(el.attrIndex || {});
    for (const name of present) table.append(this.row(doc, el, name, spec.attrs[name], diagByAttr.get(name)));
    for (const a of el.attrs) {
      if (!Object.values(el.attrIndex || {}).includes(a)) {
        table.append(h('div', { class: 'insp-row bad' }, h('label', {}, a.name), h('span', { class: 'insp-error' }, 'unknown attribute')));
      }
    }
    if (el.text !== null && el.text !== undefined && spec.children === 'text') {
      table.append(h('div', { class: 'insp-row' }, h('label', {}, 'text'), h('span', { class: 'insp-text' }, el.text.trim())));
    }
    this.container.append(table);

    const missing = Object.keys(spec.attrs).filter((k) => !present.includes(k));
    if (missing.length) {
      const sel = h('select', { class: 'small' }, h('option', { value: '' }, 'Add attribute…'), ...missing.map((k) => h('option', { value: k, title: spec.attrs[k].desc }, k)));
      sel.addEventListener('change', () => {
        const k = sel.value;
        if (!k) return;
        this.h.onEdit && this.h.onEdit(el, k, defaultRaw(el.name, k, spec.attrs[k]));
      });
      this.container.append(h('div', { class: 'insp-add' }, sel));
    }
    const canHold = Array.isArray(spec.children) && (CONTAINERS.includes(el.name) || ['scene', 'es3d', 'defs'].includes(el.name));
    if (canHold) {
      const sel = h('select', { class: 'small' }, h('option', { value: '' }, 'Add child…'), ...Object.keys(SNIPPETS).map((k) => h('option', { value: k }, k)));
      sel.addEventListener('change', () => sel.value && this.h.onAddChild && this.h.onAddChild(el, sel.value));
      this.container.append(h('div', { class: 'insp-add' }, sel));
    }
  }

  row(doc, el, name, aspec, diag) {
    const a = el.attrIndex[name];
    const raw = a ? a.value : '';
    const widget = widgetFor(el.name, name);
    const commit = (value) => {
      if (value !== raw) this.h.onEdit && this.h.onEdit(el, name, value);
    };
    let input;
    if (widget === 'bool') {
      input = h('input', { type: 'checkbox', checked: raw.trim() === 'true' });
      input.addEventListener('change', () => commit(input.checked ? 'true' : 'false'));
    } else if (widget === 'enum') {
      input = h('select', {}, ...aspec.values.map((v) => h('option', { value: v, selected: v === raw.trim() }, v)));
      if (!aspec.values.includes(raw.trim())) input.prepend(h('option', { value: raw, selected: true }, raw));
      input.addEventListener('change', () => commit(input.value));
    } else if (widget === 'color') {
      const v = el.values && el.values[name];
      const pick = h('input', { type: 'color', value: v ? colorToHex([v[0], v[1], v[2], 1]) : '#ffffff' });
      const text = h('input', { type: 'text', value: raw, spellcheck: false });
      let t = 0;
      pick.addEventListener('input', () => {
        text.value = pick.value;
        clearTimeout(t);
        t = setTimeout(() => commit(pick.value), 120);
      });
      text.addEventListener('change', () => commit(text.value));
      input = h('span', { class: 'insp-color' }, pick, text);
    } else {
      input = h('input', { type: 'text', value: raw, spellcheck: false });
      input.addEventListener('change', () => commit(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          // keep the key's default action away from the editor that receives the edit
          e.preventDefault();
          input.blur();
          return;
        }
        if (widget === 'number' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          const n = Number(input.value);
          if (!Number.isFinite(n)) return;
          e.preventDefault();
          const step = e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1;
          const nv = Math.round((n + (e.key === 'ArrowUp' ? step : -step)) * 1e6) / 1e6;
          if (aspec && aspec.min !== undefined && nv < aspec.min) return;
          input.value = String(nv);
          commit(input.value);
        }
      });
    }
    const label = h('label', { title: aspec ? aspec.desc : '' }, name, a && a.name !== name ? h('span', { class: 'insp-alias' }, ` (${a.name})`) : null);
    const remove = h('button', { class: 'icon', title: `Remove ${name}`, onclick: () => this.h.onRemove && this.h.onRemove(el, name) }, '×');
    const row = h('div', { class: 'insp-row' + (diag ? ' bad' : '') }, label, input, remove);
    if (diag) row.append(h('div', { class: 'insp-error' }, diag.message));
    if (aspec && aspec.default !== undefined && el.values && el.values[name] !== undefined) {
      const def = valueOf({ name: el.name, values: {} }, name);
      if (def !== undefined && JSON.stringify(def) === JSON.stringify(el.values[name])) row.classList.add('is-default');
    }
    return row;
  }
}
