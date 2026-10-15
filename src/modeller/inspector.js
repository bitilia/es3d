// The modeller's inspector: every attribute of one element, read from the
// schema, so each element and each attribute of the format can be edited.
// Values are kept as written; the validator judges them and its messages
// are shown above the fields.

import { h, clear } from '../ui/dom.js';
import { elementSpec } from '../format/schema.js';
import { formatAttrValue } from '../format/serializer.js';
import { parseColor, colorToHex } from '../format/colors.js';

/** The default of an attribute as text, for placeholders. */
function defaultText(name, attr, spec) {
  if (spec.default === undefined) return '';
  if (spec.default === Infinity) return 'indefinite';
  try {
    return formatAttrValue({ name, values: { [attr]: spec.default } }, attr, '', { normalize: true, pretty: true, precision: null });
  } catch {
    return String(spec.default);
  }
}

function select(options, value, onChange) {
  const el = h('select', { onchange: (e) => onChange(e.target.value) }, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  return el;
}

function textField(value, placeholder, onChange) {
  return h('input', {
    type: 'text',
    value,
    placeholder,
    spellcheck: 'false',
    onchange: (e) => onChange(e.target.value),
    onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
  });
}

function widget(name, attr, spec, raw, refs, set) {
  const has = raw !== undefined;
  const def = defaultText(name, attr, spec);
  const commit = (v) => set(attr, v.trim() === '' ? null : v.trim());
  switch (spec.type) {
    case 'bool':
      return select([['', `default (${def || 'false'})`], ['true', 'true'], ['false', 'false']], has ? raw.trim() : '', commit);
    case 'enum':
      return select([['', def ? `default (${def})` : 'choose…'], ...spec.values.map((v) => [v, v])], has ? raw.trim() : '', commit);
    case 'ref': {
      const ids = refs[spec.ref] || [];
      const options = [['', 'none'], ...ids.map((id) => [id, id])];
      if (has && !ids.includes(raw.trim())) options.push([raw.trim(), `${raw.trim()} (missing)`]);
      return select(options, has ? raw.trim() : '', commit);
    }
    case 'color': {
      const rgba = parseColor(has ? raw : def || '#ffffff');
      const text = textField(has ? raw : '', def, commit);
      const pick = h('input', { type: 'color', value: rgba ? colorToHex([...rgba.slice(0, 3), 1]) : '#ffffff', onchange: (e) => set(attr, e.target.value) });
      return h('span', { class: 'colour-field' }, pick, text);
    }
    default:
      return textField(has ? raw : '', def, commit);
  }
}

/**
 * Show one element.
 * @param {HTMLElement} container
 * @param {object} o
 * @param {string} o.name element name (schema key)
 * @param {string} [o.heading] shown instead of the element name
 * @param {Object<string,string>} o.attrs canonical name → raw value
 * @param {string|null} [o.text] text content (title, desc)
 * @param {object[]} [o.diagnostics]
 * @param {{material?: string[], path?: string[], node?: string[]}} [o.refs] ids to offer for references
 * @param {(attr: string, raw: string|null) => void} o.onSet
 * @param {(text: string) => void} [o.onText]
 * @param {{label: string, title?: string, danger?: boolean, onClick: () => void}[]} [o.actions]
 */
export function renderInspector(container, o) {
  clear(container);
  const spec = elementSpec(o.name);
  if (!spec) return;
  container.append(
    h(
      'div',
      { class: 'insp-head' },
      h('div', {}, h('strong', {}, o.heading || `<${o.name}>`), h('div', { class: 'note' }, spec.desc)),
      h('div', { class: 'insp-actions' }, (o.actions || []).map((a) => h('button', { class: `small${a.danger ? ' danger' : ''}`, title: a.title || '', onclick: a.onClick }, a.label))),
    ),
  );
  for (const d of o.diagnostics || []) {
    const extra = d.suggestion ? ` Did you mean “${d.suggestion}”?` : d.hint ? ` ${d.hint}` : '';
    container.append(h('div', { class: `insp-diag ${d.severity}` }, d.message + extra));
  }
  if (spec.children === 'text') {
    container.append(
      h('textarea', {
        class: 'insp-text',
        rows: 3,
        value: o.text || '',
        onchange: (e) => o.onText && o.onText(e.target.value),
      }),
    );
  }
  const rows = h('div', { class: 'insp-rows' });
  for (const [attr, aspec] of Object.entries(spec.attrs)) {
    const raw = o.attrs[attr];
    rows.append(
      h(
        'label',
        { class: `insp-row${raw !== undefined ? ' set' : ''}`, title: aspec.desc },
        h('span', { class: 'insp-name' }, attr, aspec.required ? h('b', { title: 'Required' }, '*') : null),
        widget(o.name, attr, aspec, raw, o.refs || {}, o.onSet),
        raw !== undefined ? h('button', { type: 'button', class: 'icon', title: `Remove ${attr} (use the default)`, onclick: (e) => (e.preventDefault(), o.onSet(attr, null)) }, '×') : h('span'),
      ),
    );
  }
  container.append(rows);
}
