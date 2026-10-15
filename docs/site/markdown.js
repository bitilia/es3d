// A small Markdown renderer for this project's own documents.
// Headings, paragraphs, emphasis, inline code, fenced code, tables,
// nested lists, block quotes, links, images, rules, HTML comments.
// The site build uses it to turn docs/*.md into static pages, so the
// page and the file in the repository say the same thing. No dependencies.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escape everything (code). */
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/** Escape text but keep character references that are already there (&lt; &#x263A;). */
const escapeText = (s) => s.replace(/&(?!#?[A-Za-z0-9]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z0-9#]+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const indentOf = (line) => line.search(/\S|$/);
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_BLOCK = /^\s*<(p|div|img|table|pre|details|section|figure|center|br|hr)\b/i;

/** A table starts with a header row and a delimiter row with the same number of cells. */
function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i].includes('|') && TABLE_SEP.test(lines[i + 1]) && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line) || HTML_BLOCK.test(line) || /^\s*<!--/.test(line);
}

/** Inline Markdown → HTML. */
function inline(text, ctx) {
  const codes = [];
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => {
    codes.push(code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeText(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, alt, src) => `<img src="${ctx.linkMap(src)}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, label, href) => `<a href="${ctx.linkMap(href)}">${label}</a>`);
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (m, url) => `<a href="${url}">${url}</a>`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_(?=\S)([^_]*?\S)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/ {2,}$/gm, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, k) => `<code>${escapeHtml(codes[Number(k)])}</code>`);
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const TIMING = /^(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)$/;

/** A result cell is "ready / frame". Null for a label, a skip, or anything else. */
function timingOf(text) {
  const m = TIMING.exec(text.trim());
  if (!m) return null;
  return {
    ready: Number(m[1].replace(/,/g, '')),
    frame: Number(m[2].replace(/,/g, '')),
    readyText: m[1],
    frameText: m[2],
  };
}

function fastest(values) {
  let best = Infinity;
  for (const n of values) if (n < best) best = n;
  return best;
}

function renderTable(lines, ctx) {
  const head = splitRow(lines[0]);
  const align = splitRow(lines[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const body = lines.slice(2).map((l) => {
    const cells = splitRow(l);
    while (cells.length < head.length) cells.push('');
    return cells.slice(0, head.length);
  });
  const timings = body.map((cells) => cells.map(timingOf));
  const bestReady = timings.map((row) => fastest(row.filter(Boolean).map((t) => t.ready)));
  const bestFrame = timings.map((row) => fastest(row.filter(Boolean).map((t) => t.frame)));
  const hasTimings = timings.some((row) => row.some(Boolean));
  const alignAttr = (k) => (align[k] ? ` style="text-align:${align[k]}"` : '');
  // Markdown needs a header row, so a list of names and values is written
  // with an empty one. Such a table gets no header row; its first column
  // heads each row instead.
  const hasHead = head.some((c) => c.trim());
  const headHtml = head.map((c, k) => `<th${alignAttr(k)}>${inline(c, ctx)}</th>`).join('');
  const rows = body.map((cells, r) => {
    const tds = cells.map((text, k) => {
      const t = timings[r][k];
      if (!hasHead && k === 0) return `<th scope="row"${alignAttr(k)}>${inline(text, ctx)}</th>`;
      if (!t) return `<td${alignAttr(k)}>${inline(text, ctx)}</td>`;
      const readyWin = t.ready === bestReady[r];
      const frameWin = t.frame === bestFrame[r];
      const cls = ['pair'];
      if (readyWin && frameWin) cls.push('best');
      const mark = (win, kind, raw) => (win ? `<span class="fast" title="Fastest ${kind} time in this row">${raw}</span>` : raw);
      return `<td class="${cls.join(' ')}"${alignAttr(k)}>${mark(readyWin, 'ready', t.readyText)}<span class="sep"> / </span>${mark(frameWin, 'frame', t.frameText)}</td>`;
    });
    return `<tr>${tds.join('')}</tr>`;
  });
  const thead = hasHead ? `<thead><tr>${headHtml}</tr></thead>\n` : '';
  return `<div class="table-wrap"><table${hasTimings ? ' class="timings"' : ''}>\n${thead}<tbody>\n${rows.join('\n')}\n</tbody></table></div>`;
}

function renderList(lines, start, ctx) {
  const first = LIST_ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + m[3].length;
    const body = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) {
        let j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) > base) {
          for (let k = i; k < j; k++) body.push('');
          i = j;
          continue;
        }
        const after = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
        if (after && after[1].length === base && /\d/.test(after[2]) === ordered) loose = true;
        i = j;
        break;
      }
      const ind = indentOf(l);
      if (ind > base) {
        body.push(l.slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      if (!isBlockStart(l)) {
        // lazy paragraph continuation
        body.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    if (body.some((l, k) => k > 0 && l === '' && k < body.length - 1)) loose = true;
    items.push(body);
  }
  const startAttr = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : '';
  const html = items
    .map((body) => {
      let inner = blocks(body, ctx);
      if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
      return `<li>${inner}</li>`;
    })
    .join('\n');
  return { html: `<${ordered ? 'ol' : 'ul'}${startAttr}>\n${html}\n</${ordered ? 'ol' : 'ul'}>`, next: i };
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
      continue;
    }
    let m = FENCE.exec(line);
    if (m) {
      const fence = m[2];
      const lang = m[3];
      const indent = m[1].length;
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      i++;
      out.push(`<pre${lang ? ` class="lang-${lang}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    m = HEADING.exec(line);
    if (m) {
      const level = m[1].length;
      const html = inline(m[2], ctx);
      let id = slugify(html) || `section-${ctx.headings.length + 1}`;
      while (ctx.ids.has(id)) id += '-1';
      ctx.ids.add(id);
      ctx.headings.push({ level, id, html });
      out.push(`<h${level} id="${id}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows, ctx));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>\n${blocks(quote, ctx)}\n</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, i, ctx);
      out.push(list.html);
      i = list.next;
      continue;
    }
    if (HTML_BLOCK.test(line)) {
      const raw = [];
      while (i < lines.length && !/^\s*$/.test(lines[i])) raw.push(lines[i++]);
      out.push(raw.join('\n'));
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i]) && !isTableStart(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${inline(para.join('\n'), ctx)}</p>`);
  }
  return out.join('\n');
}

/**
 * Render Markdown to HTML.
 * @param {string} src
 * @param {{linkMap?: (href: string) => string, ids?: Set<string>}} [opts]
 *        linkMap rewrites link targets; ids is shared by documents rendered into one page
 * @returns {{html: string, headings: {level: number, id: string, html: string}[]}}
 */
export function renderMarkdown(src, opts = {}) {
  const ctx = { linkMap: opts.linkMap || ((h) => h), headings: [], ids: opts.ids || new Set() };
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  return { html: blocks(lines, ctx), headings: ctx.headings };
}

/** A nested table of contents for the given heading levels. */
export function tableOfContents(headings, minLevel = 2, maxLevel = 2) {
  const items = headings.filter((h) => h.level >= minLevel && h.level <= maxLevel);
  if (!items.length) return '';
  return `<ul>\n${items.map((h) => `<li class="toc-${h.level}"><a href="#${h.id}">${h.html.replace(/<a [^>]*>|<\/a>/g, '')}</a></li>`).join('\n')}\n</ul>`;
}
