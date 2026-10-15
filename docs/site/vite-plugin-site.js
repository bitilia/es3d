// The ES3D website is static HTML. Vite expands a few directives when it
// serves or builds a page, so the header, navigation and footer exist once,
// and the documentation pages show the Markdown from this repository.
//
//   <!--#set var="page" value="home" -->
//   <!--#include virtual="top.html" -->                          docs/site/partials
//   <!--#include file="docs/public/es3d-logo.es3d" escape -->     any project file, escaped
//   <!--#echo var="VERSION" -->                                   also LAST_MODIFIED
//   <!--#markdown file="docs/SPEC.md" toc="2" -->
//   <!--#examples -->
//   <!--#filesize of="docs/public/es3d-logo.es3d" -->            size line: ES3D file, gzipped
//   <!--#filesize of="demo/ashby" part="gzip" -->                one figure: es3d or gzip
//
// File sizes come from docs/site/sizes.json, written by `npm run sizes`;
// nothing is measured while a page is served or viewed.
//
// Every page listed in docs/site/pages.js gets a canonical link, Open Graph
// and Twitter tags, and JSON-LD (the page, a breadcrumb trail, and the FAQ
// when that page is the FAQ). A page that already writes structured data
// keeps it and only gains the breadcrumb. The build writes sitemap.xml,
// with lastmod set to the same date the footer calls "Last updated".
//
// Links between the Markdown documents become links between these pages.
// A link to any other file in the repository points at GitHub.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, tableOfContents, escapeHtml } from './markdown.js';
import { sizeHtml, formatBytes } from './filesize.js';
import { PREVIEW_IMAGES, breadcrumbItems, pageFor, pageUrl, previewImage, siteDate, sitemapXml } from './pages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '..');
const ROOT = path.resolve(DOCS, '..');
const PARTIALS = path.join(HERE, 'partials');
const PUBLIC = path.join(DOCS, 'public');
export const REPO_URL = 'https://github.com/bitilia/es3d';

/** Markdown files that have their own page. Values are site paths; '' is the home page. */
const DOC_PAGES = {
  'docs/SPEC.md': 'spec/',
  'docs/REFERENCE.md': 'reference/',
  'docs/benchmark-devices.md': 'benchmark-devices/',
  'README.md': '',
};

/** Directory of a Markdown file's page, or null when that file is not a page. */
function hostDir(doc) {
  const page = DOC_PAGES[doc];
  if (page === undefined) return null;
  return page.replace(/\/$/, '');
}

function asDir(file) {
  if (file.endsWith('/index.html')) return file.slice(0, -'index.html'.length);
  if (file.endsWith('.html')) return `${file.slice(0, -'.html'.length)}/`;
  return file;
}

/** A repository path that the site serves, or null when it stays a GitHub link. */
function toSitePath(rel) {
  if (DOC_PAGES[rel] !== undefined) return DOC_PAGES[rel];
  if (rel.startsWith('docs/images/')) return `images/${rel.slice('docs/images/'.length)}`;
  if (rel.startsWith('docs/demo/')) {
    const rest = rel.slice('docs/'.length);
    return rest.endsWith('.html') ? asDir(rest) : rest;
  }
  if (rel.startsWith('docs/public/')) return rel.slice('docs/public/'.length);
  if (rel.startsWith('public/')) return rel.slice('public/'.length);
  return null;
}

/** Path from one site directory to another. `fromDir` is '' at the site root. */
function relUrl(fromDir, target) {
  const from = (fromDir || '').replace(/\/$/, '');
  const isDir = target === '' || target.endsWith('/');
  const to = isDir ? target.replace(/\/$/, '') : target;
  let rel = path.posix.relative(from || '.', to || '.');
  if (!rel) rel = '.';
  if (isDir) rel = rel === '.' ? './' : (rel.endsWith('/') ? rel : `${rel}/`);
  return rel;
}


function attrsOf(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] === undefined ? true : m[2];
  return out;
}

/**
 * Rewrite a link found in the Markdown file `doc` (path relative to the repository).
 * `fromDir` is the directory of the page that is showing the text. When it is
 * omitted, links are written from that document's own page.
 */
export function siteLink(href, doc, fromDir) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return href;
  const [p, hash] = href.split('#');
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc), p));
  const target = toSitePath(rel);
  if (target === null) return `${REPO_URL}/blob/HEAD/${rel}${hash ? `#${hash}` : ''}`;
  const from = fromDir !== undefined ? fromDir : hostDir(doc);
  const url = from === null ? (target || './') : relUrl(from, target);
  return hash ? `${url}#${hash}` : url;
}

function parseToc(spec) {
  if (spec === true) return [2, 2];
  const [a, b] = String(spec).split('-').map(Number);
  return [a || 2, b || a || 2];
}

/**
 * Recorded sizes of a file or demo scene ({es3d, gzip}). Keys are repository
 * paths ("docs/public/examples/04-forest.es3d") or demo names ("demo/ashby").
 */
export function sizesOf(key) {
  const all = JSON.parse(fs.readFileSync(path.join(HERE, 'sizes.json'), 'utf8'));
  const s = all[key];
  if (!s) throw new Error(`site: no recorded size for '${key}'. Run: npm run sizes`);
  return s;
}

/** A recorded size as HTML: the whole line, or one figure. */
function sizeFigure(key, part = 'line') {
  const s = sizesOf(key);
  switch (part) {
    case 'line':
      return `<span class="filesize">${sizeHtml(s)}</span>`;
    case 'es3d':
    case 'gzip':
      return escapeHtml(formatBytes(s[part]));
    default:
      throw new Error(`site: unknown filesize part '${part}'`);
  }
}

function examplesGallery(root = '') {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'examples/manifest.json'), 'utf8'));
  const rows = manifest.examples.map((ex) => {
    const sizes = sizesOf(`docs/public/examples/${ex.file}`);
    const thumb = fs.existsSync(path.join(PUBLIC, 'thumbs', `${ex.id}.jpg`))
      ? `<img src="${root}thumbs/${ex.id}.jpg" width="240" height="150" alt="${escapeHtml(ex.title)}" loading="lazy">`
      : `<span class="no-thumb">no picture</span>`;
    const studio = `${root}studio/?example=${encodeURIComponent(ex.id)}`;
    return `<tr>
  <td class="thumb"><a href="${studio}">${thumb}</a></td>
  <td><b><a href="${studio}">${escapeHtml(ex.title)}</a></b><br>
  ${escapeHtml(ex.description || '')}<br>
  <span class="filesize">${sizeHtml(sizes)}</span><br>
  <small>File: <a href="${root}examples/${encodeURIComponent(ex.file)}">${escapeHtml(ex.file)}</a></small></td>
</tr>`;
  });
  return `<div class="table-wrap"><table class="gallery">\n<tbody>\n${rows.join('\n')}\n</tbody></table></div>`;
}

/** Expand the directives in one page. */
export function expandPage(html, vars = {}) {
  const env = {
    LAST_MODIFIED: siteDate(),
    VERSION: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    ROOT: '',
    HOME: './',
    ...vars,
  };
  const ids = new Set();
  const expand = (src, depth) => {
    if (depth > 8) throw new Error('site: includes nested too deeply');
    return src.replace(/<!--#(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*-->/g, (m, cmd, rest) => {
      const a = attrsOf(rest);
      switch (cmd) {
        case 'set':
          env[a.var] = a.value;
          return '';
        case 'echo':
          return escapeHtml(env[a.var] ?? '');
        case 'include': {
          const file = a.virtual ? path.join(PARTIALS, a.virtual) : path.join(ROOT, a.file);
          const text = fs.readFileSync(file, 'utf8');
          return a.escape ? escapeHtml(text.replace(/\s+$/, '')) : expand(text, depth + 1);
        }
        case 'markdown': {
          const doc = a.file;
          const md = fs.readFileSync(path.join(ROOT, doc), 'utf8');
          const from = Object.hasOwn(env, 'PAGE_DIR') ? env.PAGE_DIR : undefined;
          const { html: body, headings } = renderMarkdown(md, { linkMap: (href) => siteLink(href, doc, from), ids });
          let toc = '';
          if (a.toc) {
            const [lo, hi] = parseToc(a.toc);
            toc = `<div class="toc"><b>Contents</b>\n${tableOfContents(headings, lo, hi)}\n</div>\n`;
          }
          const intro = `<p class="source-note">Taken from <a href="${REPO_URL}/blob/HEAD/${doc}">${escapeHtml(doc)}</a>. This page and that file say the same thing.</p>\n${toc}`;
          // The note and the contents sit directly under the document title.
          const h1 = /<h1[^>]*>[\s\S]*?<\/h1>/.exec(body);
          const out = h1 ? body.slice(0, h1.index + h1[0].length) + '\n' + intro + body.slice(h1.index + h1[0].length) : intro + body;
          return `<div class="doc">\n${out}\n</div>`;
        }
        case 'examples':
          return examplesGallery(env.ROOT || '');
        case 'filesize':
          return sizeFigure(a.of, a.part);
        default:
          throw new Error(`site: unknown directive <!--#${cmd}-->`);
      }
    });
  };
  let out = expand(html, 0);
  if (env.page) out = out.replaceAll(`data-nav="${env.page}"`, 'aria-current="page"');
  return out;
}

const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

/**
 * Add a page's canonical link and link-preview tags before </head>. A tag the
 * page already has is left as it is. `file` is the page relative to docs/.
 */
export function linkPreview(html, file) {
  const page = pageFor(file);
  if (!page || page.sitemap === false) return html;
  const title = /<title>([^<]*)<\/title>/.exec(html);
  const description = /<meta name="description" content="([^"]*)"/.exec(html);
  const url = pageUrl(page);
  const image = previewImage(page);
  const attr = (v) => escapeHtml(unescapeHtml(v));
  const tags = [];
  if (!/<link rel="canonical"/.test(html)) tags.push(`<link rel="canonical" href="${url}">`);
  const meta = (kind, key, value) => {
    if (value !== undefined && !html.includes(`${kind}="${key}"`)) tags.push(`<meta ${kind}="${key}" content="${value}">`);
  };
  meta('property', 'og:type', 'website');
  meta('property', 'og:site_name', 'ES3D');
  if (title) meta('property', 'og:title', attr(title[1].replace(/ - ES3D$/, '')));
  if (description) meta('property', 'og:description', description[1]);
  meta('property', 'og:url', url);
  meta('property', 'og:image', image.url);
  meta('property', 'og:image:width', String(image.width));
  meta('property', 'og:image:height', String(image.height));
  meta('property', 'og:image:alt', attr(image.alt));
  meta('property', 'og:locale', 'en_GB');
  meta('name', 'twitter:card', 'summary_large_image');
  meta('name', 'twitter:image', image.url);
  meta('name', 'twitter:image:alt', attr(image.alt));
  if (!tags.length) return html;
  return html.replace(/\s*<\/head>/, (end) => `\n${tags.join('\n')}${end}`);
}

const ORG_ID = 'https://es3d.org/#organization';
const SITE_ID = 'https://es3d.org/#website';

function jsonLd(data) {
  return JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
}

function plainText(html) {
  return unescapeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Questions from the FAQ definition list, for FAQPage markup. */
function faqEntities(html) {
  const dl = /<dl class="faq">([\s\S]*?)<\/dl>/.exec(html);
  if (!dl) return null;
  const questions = [];
  for (const m of dl[1].matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const name = plainText(m[1]);
    const text = plainText(m[2]);
    if (name && text) questions.push({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } });
  }
  return questions.length ? questions : null;
}

function breadcrumbNode(url, items) {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * JSON-LD for a page that does not write its own: the organization, the site,
 * this page, and a breadcrumb trail. The FAQ page is also an FAQPage. A page
 * that already has structured data only gains a breadcrumb trail.
 */
export function structuredData(html, file) {
  const page = pageFor(file);
  if (!page || page.sitemap === false) return html;
  const url = pageUrl(page);
  const title = /<title>([^<]*)<\/title>/.exec(html);
  const description = /<meta name="description" content="([^"]*)"/.exec(html);
  const name = title ? unescapeHtml(title[1]).replace(/ - ES3D$/, '') : (page.name || 'ES3D');
  const crumbs = breadcrumbItems(page, name);
  const blocks = [];
  if (!html.includes('application/ld+json')) {
    const image = previewImage(page);
    const faq = file === 'faq/index.html' ? faqEntities(html) : null;
    const graph = [
      {
        '@type': 'Organization',
        '@id': ORG_ID,
        name: 'ES3D',
        url: 'https://es3d.org/',
        logo: { '@type': 'ImageObject', url: 'https://es3d.org/favicon.svg' },
        sameAs: ['https://github.com/bitilia/es3d'],
      },
      {
        '@type': 'WebSite',
        '@id': SITE_ID,
        url: 'https://es3d.org/',
        name: 'ES3D',
        publisher: { '@id': ORG_ID },
        inLanguage: 'en',
      },
      {
        '@type': faq ? ['WebPage', 'FAQPage'] : 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name,
        ...(description ? { description: unescapeHtml(description[1]) } : {}),
        isPartOf: { '@id': SITE_ID },
        publisher: { '@id': ORG_ID },
        inLanguage: 'en',
        dateModified: siteDate(),
        primaryImageOfPage: { '@type': 'ImageObject', url: image.url, width: image.width, height: image.height },
        ...(faq ? { mainEntity: faq } : {}),
        ...(crumbs.length > 1 ? { breadcrumb: { '@id': `${url}#breadcrumb` } } : {}),
      },
    ];
    if (crumbs.length > 1) graph.push(breadcrumbNode(url, crumbs));
    blocks.push({ '@context': 'https://schema.org', '@graph': graph });
  } else if (crumbs.length > 1 && !html.includes('BreadcrumbList')) {
    blocks.push({ '@context': 'https://schema.org', ...breadcrumbNode(url, crumbs) });
  }
  if (!blocks.length) return html;
  const scripts = blocks.map((b) => `<script type="application/ld+json">\n${jsonLd(b)}\n</script>`).join('\n');
  return html.replace(/\s*<\/head>/, (end) => `\n${scripts}${end}`);
}

/**
 * The 404 page is served for a missing address at any depth, so its relative
 * links start from the site's base path: "" at a domain root, "/<repository>"
 * on a GitHub Pages project site. The website workflow passes it in.
 */
function basePath() {
  return (process.env.SITE_BASE_PATH || '').replace(/\/+$/, '');
}

export default function sitePlugin() {
  return {
    name: 'es3d-site',
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => {
        // Shared partials use ROOT so a page in a folder still reaches the site root.
        const rel = ctx?.filename ? path.relative(DOCS, ctx.filename).split(path.sep).join('/') : '';
        const dir = rel ? path.posix.dirname(rel) : '.';
        const pageDir = dir === '.' ? '' : dir;
        const root = pageDir ? `${pageDir.split('/').map(() => '..').join('/')}/` : '';
        let out = structuredData(linkPreview(expandPage(html, { ROOT: root, HOME: root || './', PAGE_DIR: pageDir }), rel), rel);
        if (rel === '404.html') out = out.replace(/<head>/, `<head>\n<base href="${basePath()}/">`);
        return out;
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml() });
      for (const file of Object.keys(PREVIEW_IMAGES)) {
        this.emitFile({ type: 'asset', fileName: `images/${file}`, source: fs.readFileSync(path.join(DOCS, 'images', file)) });
      }
    },
    configureServer(server) {
      // the dev server answers for the files the build writes
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const image = /^\/images\/([\w.-]+)$/.exec(url);
        if (url === '/sitemap.xml') {
          res.setHeader('Content-Type', 'application/xml');
          res.end(sitemapXml());
        } else if (image && PREVIEW_IMAGES[image[1]]) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.end(fs.readFileSync(path.join(DOCS, 'images', image[1])));
        } else {
          next();
        }
      });
      const watched = [PARTIALS, DOCS, path.join(ROOT, 'README.md')];
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        if (watched.some((w) => file.startsWith(w))) server.ws.send({ type: 'full-reload' });
      });
    },
  };
}
