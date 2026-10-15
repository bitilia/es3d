// Source editor: a <textarea> layered over a syntax highlighted <pre>, with a
// line-number gutter and a diagnostics layer that underlines problem ranges.
// Dependency free; programmatic edits go through execCommand('insertText')
// where available so they stay on the browser's undo stack.

import { h, escapeHtml } from './dom.js';
import { highlight } from './highlight.js';

const MAX_HIGHLIGHT = 600000;

export class Editor {
  constructor(container, { onChange, onCursor } = {}) {
    this.onChange = onChange || null;
    this.onCursor = onCursor || null;
    this.syntax = 'xml';
    this.diagnostics = [];
    this.gutter = h('pre', { class: 'ed-gutter', 'aria-hidden': 'true' });
    this.hl = h('pre', { class: 'ed-layer ed-hl', 'aria-hidden': 'true' });
    this.diag = h('pre', { class: 'ed-layer ed-diag', 'aria-hidden': 'true' });
    this.input = h('textarea', {
      class: 'ed-input',
      spellcheck: false,
      wrap: 'off',
      autocapitalize: 'off',
      autocomplete: 'off',
      'aria-label': 'ES3D source',
    });
    this.input.setAttribute('autocorrect', 'off');
    this.body = h('div', { class: 'ed-body' }, this.hl, this.diag, this.input);
    this.root = h('div', { class: 'ed' }, this.gutter, this.body);
    container.append(this.root);
    this.pending = 0;
    this.lineCount = 0;

    this.input.addEventListener('input', () => {
      this.scheduleRender();
      if (this.onChange) this.onChange(this.input.value);
    });
    this.input.addEventListener('scroll', () => this.syncScroll());
    this.input.addEventListener('keydown', (e) => this.keydown(e));
    const cursor = () => {
      if (this.onCursor) this.onCursor(this.input.selectionStart);
    };
    this.input.addEventListener('click', cursor);
    this.input.addEventListener('keyup', (e) => {
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') cursor();
    });
  }

  get value() {
    return this.input.value;
  }

  /** Replace the whole text (not an undoable user edit). */
  setValue(text, syntax) {
    if (syntax) this.syntax = syntax;
    this.input.value = text;
    this.input.scrollTop = 0;
    this.input.scrollLeft = 0;
    this.render();
    this.syncScroll();
  }

  setSyntax(syntax) {
    if (syntax === this.syntax) return;
    this.syntax = syntax;
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.render();
    });
  }

  render() {
    const text = this.input.value;
    if (text.length > MAX_HIGHLIGHT) this.hl.innerHTML = escapeHtml(text) + '\n';
    else this.hl.innerHTML = highlight(text, this.syntax) + '\n';
    this.renderGutter(text);
    this.renderDiagnostics(text);
  }

  renderGutter(text) {
    let lines = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
    this.lineCount = lines;
    const marks = new Map();
    for (const d of this.diagnostics) {
      if (d.line > 0 && (!marks.has(d.line) || d.severity === 'error')) marks.set(d.line, d.severity);
    }
    const parts = new Array(lines);
    for (let i = 1; i <= lines; i++) {
      const s = marks.get(i);
      parts[i - 1] = s ? `<span class="ln-${s}" title="${s}">${i}</span>` : String(i);
    }
    this.gutter.innerHTML = parts.join('\n') + '\n';
  }

  renderDiagnostics(text) {
    const list = this.diagnostics.filter((d) => d.offset >= 0).sort((a, b) => a.offset - b.offset);
    if (!list.length) {
      this.diag.textContent = '';
      return;
    }
    let out = '';
    let last = 0;
    for (const d of list) {
      let start = Math.min(d.offset, text.length);
      let end = Math.min(text.length, start + Math.max(1, d.length || 1));
      if (start >= text.length && text.length) {
        start = text.length - 1;
        end = text.length;
      }
      if (start < last) continue;
      out += escapeHtml(text.slice(last, start));
      out += `<span class="dg-${d.severity}">${escapeHtml(text.slice(start, end)) || ' '}</span>`;
      last = end;
    }
    out += escapeHtml(text.slice(last));
    this.diag.innerHTML = out + '\n';
  }

  setDiagnostics(list) {
    this.diagnostics = list || [];
    const text = this.input.value;
    this.renderGutter(text);
    this.renderDiagnostics(text);
  }

  syncScroll() {
    const x = this.input.scrollLeft, y = this.input.scrollTop;
    const t = `translate(${-x}px, ${-y}px)`;
    this.hl.style.transform = t;
    this.diag.style.transform = t;
    this.gutter.style.transform = `translateY(${-y}px)`;
  }

  lineHeight() {
    const lh = parseFloat(getComputedStyle(this.input).lineHeight);
    return Number.isFinite(lh) ? lh : 18;
  }

  /** Select a range and scroll it into view. */
  reveal(offset, length = 0, focus = true) {
    const text = this.input.value;
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.max(start, Math.min(text.length, start + length));
    let line = 0;
    for (let i = text.indexOf('\n'); i >= 0 && i < start; i = text.indexOf('\n', i + 1)) line++;
    const lh = this.lineHeight();
    const target = line * lh;
    const view = this.input.clientHeight;
    if (target < this.input.scrollTop + lh || target > this.input.scrollTop + view - 2 * lh) {
      this.input.scrollTop = Math.max(0, target - view / 3);
    }
    const col = start - (text.lastIndexOf('\n', start - 1) + 1);
    const charW = 7.8;
    if (col * charW < this.input.scrollLeft || col * charW > this.input.scrollLeft + this.input.clientWidth - 40) {
      this.input.scrollLeft = Math.max(0, col * charW - 40);
    }
    if (focus) this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(start, end);
    this.syncScroll();
  }

  /** Replace a range of text as an (undoable where supported) edit. */
  replaceRange(start, end, text) {
    const ta = this.input;
    const scrollTop = ta.scrollTop;
    const previous = document.activeElement;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok || ta.value.slice(start, start + text.length) !== text) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    ta.scrollTop = scrollTop;
    this.syncScroll();
    // edits issued from other widgets (inspector, toolbar) keep their focus
    if (previous && previous !== ta && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true });
    else if (previous !== ta) ta.blur();
  }

  keydown(e) {
    const ta = this.input;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      if (s === en) {
        document.execCommand('insertText', false, '  ') || ta.setRangeText('  ', s, en, 'end');
      } else {
        // indent / outdent the selected lines
        const text = ta.value;
        const ls = text.lastIndexOf('\n', s - 1) + 1;
        const block = text.slice(ls, en);
        const out = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        ta.setSelectionRange(ls, en);
        if (!document.execCommand('insertText', false, out)) ta.setRangeText(out, ls, en, 'select');
        ta.setSelectionRange(ls, ls + out.length);
      }
      ta.dispatchEvent(new Event('input'));
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const s = ta.selectionStart;
      const text = ta.value;
      const ls = text.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(ls, s))[0];
      const prev = text.slice(ls, s).trimEnd();
      const extra = /<[A-Za-z][^/>]*[^/]>$/.test(prev) || prev.endsWith('{') ? '  ' : '';
      e.preventDefault();
      const ins = '\n' + indent + extra;
      if (!document.execCommand('insertText', false, ins)) {
        ta.setRangeText(ins, s, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    }
  }
}
