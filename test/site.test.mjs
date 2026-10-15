// The website build: Markdown rendering and the page directives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, tableOfContents, slugify } from '../docs/site/markdown.js';
import { expandPage, siteLink, linkPreview, structuredData } from '../docs/site/vite-plugin-site.js';
import { PAGES, PREVIEW_IMAGES, sitemapXml } from '../docs/site/pages.js';
import fs from 'node:fs';
import path from 'node:path';

test('Markdown: headings with unique ids, code, emphasis, links and escaping', () => {
  const { html, headings } = renderMarkdown(
    ['# Title', '', 'Some *em*, **strong** and `<code> & co`.', '', '## Part', '', '## Part', '', '### `<box>`', '', '```xml', '<es3d version="1"/>', '```', '', 'A [link](SPEC.md#7-transforms) and <https://example.org>.'].join('\n'),
    { linkMap: (h) => h.replace('SPEC.md', 'spec.html') },
  );
  assert.deepEqual(
    headings.map((h) => h.id),
    ['title', 'part', 'part-1', 'box'],
  );
  assert.match(html, /<em>em<\/em>, <strong>strong<\/strong> and <code>&lt;code&gt; &amp; co<\/code>/);
  assert.match(html, /<pre class="lang-xml"><code>&lt;es3d version=&quot;1&quot;\/&gt;<\/code><\/pre>/);
  assert.match(html, /<a href="spec.html#7-transforms">link<\/a>/);
  assert.match(html, /<a href="https:\/\/example.org">https:\/\/example.org<\/a>/);
  assert.equal(slugify('7. Transforms &amp; the <em>scene</em> hierarchy'), '7-transforms-the-scene-hierarchy');
  assert.match(tableOfContents(headings, 2, 3), /<li class="toc-3"><a href="#box"><code>&lt;box&gt;<\/code><\/a><\/li>/);
});

test('Markdown: tables with alignment, nested and loose lists, block quotes', () => {
  const { html } = renderMarkdown(
    ['| a | b |', '|:-|--:|', '| 1 | x \\| y |', '', 'not | a table', '---', '', '- one', '  - nested', '- two', '', '1. first', '', '2. second', '', '> quoted', '> text'].join('\n'),
  );
  assert.match(html, /<th style="text-align:left">a<\/th><th style="text-align:right">b<\/th>/);
  assert.match(html, /<td style="text-align:right">x \| y<\/td>/);
  assert.match(html, /<p>not \| a table<\/p>\n<hr>/);
  assert.match(html, /<ul>\n<li>one\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li><p>first<\/p><\/li>/);
  assert.match(html, /<blockquote>\n<p>quoted\ntext<\/p>\n<\/blockquote>/);
});

test('a ready / frame table marks the fastest of each, and a tie, and leaves other tables alone', () => {
  const { html } = renderMarkdown(
    ['| Scene | A | B |', '|---|---:|---:|', '| Cube | 2.00 / 0.50 | 1.00 / 0.80 |', '| Tie | 1.5 / 0.2 | 1.5 / 0.2 |', '| Skip | – | 3 / 1 |', '', '| Name | Note |', '|---|---|', '| PC | a chip |'].join('\n'),
  );
  const cube = html.slice(html.indexOf('<td>Cube</td>'), html.indexOf('<td>Tie</td>'));
  assert.match(cube, /<td class="pair" style="text-align:right">2\.00<span class="sep"> \/ <\/span><span class="fast" title="Fastest frame time in this row">0\.50<\/span><\/td>/);
  assert.match(cube, /<td class="pair" style="text-align:right"><span class="fast" title="Fastest ready time in this row">1\.00<\/span><span class="sep"> \/ <\/span>0\.80<\/td>/);
  const tie = html.slice(html.indexOf('<td>Tie</td>'), html.indexOf('<td>Skip</td>'));
  assert.equal(tie.match(/class="fast"/g).length, 4);
  assert.match(tie, /<td class="pair best"/);
  const skip = html.slice(html.indexOf('<td>Skip</td>'), html.indexOf('</tbody>'));
  assert.match(skip, /<td style="text-align:right">–<\/td>/);
  assert.match(skip, /<td class="pair best" style="text-align:right"><span class="fast" title="Fastest ready time in this row">3<\/span><span class="sep"> \/ <\/span><span class="fast" title="Fastest frame time in this row">1<\/span><\/td>/);
  assert.match(html, /<table class="timings">/);
  assert.match(html, /<table>\n<thead><tr><th>Name<\/th>/);
});

test('site links: documents become pages, other files point to the repository', () => {
  assert.equal(siteLink('REPORT.md#verdict', 'docs/SPEC.md'), 'https://github.com/bitilia/es3d/blob/HEAD/docs/REPORT.md#verdict');
  assert.equal(siteLink('docs/SPEC.md', 'README.md'), 'spec/');
  assert.equal(siteLink('docs/benchmark-devices.md', 'README.md'), 'benchmark-devices/');
  assert.equal(siteLink('REFERENCE.md', 'docs/SPEC.md'), '../reference/');
  assert.equal(siteLink('benchmark-results.md', 'docs/REPORT.md'), 'https://github.com/bitilia/es3d/blob/HEAD/docs/benchmark-results.md');
  assert.equal(siteLink('images/x.jpg', 'docs/REPORT.md'), 'images/x.jpg');
  assert.equal(siteLink('../src/index.js', 'docs/ARCHITECTURE.md'), 'https://github.com/bitilia/es3d/blob/HEAD/src/index.js');
  assert.equal(siteLink('https://www.w3.org/TR/SVG2/', 'docs/SPEC.md'), 'https://www.w3.org/TR/SVG2/');
  assert.equal(siteLink('docs/demo/index.html', 'README.md'), 'demo/');
});

test('page directives: set, include, echo and the current navigation link', () => {
  const html = expandPage('<!--#set var="page" value="faq" --><!--#set var="title" value="A &amp; B" --><title><!--#echo var="title" --></title><!--#include virtual="top.html" -->');
  assert.match(html, /<title>A &amp;amp; B<\/title>/);
  assert.match(html, /<a href="faq\/" aria-current="page">/);
  assert.doesNotMatch(html, /data-nav="faq"/);
  assert.match(html, /data-nav="home"/);
  assert.throws(() => expandPage('<!--#frobnicate -->'), /unknown directive/);
  const doc = expandPage('<!--#markdown file="docs/SPEC.md" toc="2" -->');
  assert.match(doc, /<div class="toc"><b>Contents<\/b>/);
  assert.match(doc, /Taken from <a href="https:\/\/github.com\/bitilia\/es3d\/blob\/HEAD\/docs\/SPEC.md">/);
});

test('every page in docs/ is in the page list, and the sitemap has every public page', () => {
  const docs = path.join(import.meta.dirname, '..', 'docs');
  const found = fs.globSync('**/*.html', { cwd: docs }).map((f) => f.split(path.sep).join('/')).filter((f) => !f.startsWith('site/') && !f.startsWith('public/'));
  assert.deepEqual(PAGES.map((p) => p.file).sort(), found.sort());
  for (const page of PAGES) {
    if (page.image) assert.ok(PREVIEW_IMAGES[page.image], `${page.file}: unknown preview image ${page.image}`);
  }
  for (const file of Object.keys(PREVIEW_IMAGES)) assert.ok(fs.existsSync(path.join(docs, 'images', file)), `docs/images/${file} is missing`);
  const xml = sitemapXml();
  assert.match(xml, /<loc>https:\/\/es3d.org\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/es3d.org\/modeller\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/es3d.org\/demo\/ashby\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/es3d.org\/media\/why-es3d-came-to-be\/<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.doesNotMatch(xml, /404/);
  assert.equal(xml.match(/<url>/g).length, PAGES.length - 1);
  assert.equal(xml.match(/<lastmod>/g).length, PAGES.length - 1);
});

test('link previews: canonical, Open Graph and Twitter tags, without replacing the page\'s own', () => {
  const html = linkPreview('<head><title>Spec &amp; more - ES3D</title><meta name="description" content="The &quot;spec&quot;.">\n</head>', 'spec/index.html');
  assert.match(html, /<link rel="canonical" href="https:\/\/es3d.org\/spec\/">/);
  assert.match(html, /<meta property="og:title" content="Spec &amp; more">/);
  assert.match(html, /<meta property="og:description" content="The &quot;spec&quot;.">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/es3d.org\/images\/studio-errors.jpg">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/es3d.org\/images\/studio-errors.jpg">/);
  assert.match(html, /<meta property="og:locale" content="en_GB">/);
  const own = linkPreview('<head><title>Post</title><link rel="canonical" href="https://es3d.org/x/"><meta name="twitter:card" content="summary"></head>', 'media/making-the-web-3d/index.html');
  assert.equal(own.match(/rel="canonical"/g).length, 1);
  assert.equal(own.match(/twitter:card/g).length, 1);
  assert.match(own, /og:url" content="https:\/\/es3d.org\/media\/making-the-web-3d\/"/);
  assert.equal(linkPreview('<head></head>', '404.html'), '<head></head>');
  assert.equal(linkPreview('<head></head>', 'not-a-page.html'), '<head></head>');
});

test('structured data: a page, the FAQ, an article breadcrumb, and nothing on the 404', () => {
  const page = structuredData('<head><title>Download - ES3D</title><meta name="description" content="Get it."></head>', 'download/index.html');
  assert.match(page, /"@type": "WebPage"/);
  assert.match(page, /"@type": "BreadcrumbList"/);
  assert.match(page, /https:\/\/es3d.org\/download\//);
  assert.match(page, /"name": "Home"/);
  const faq = structuredData('<head><title>FAQ and links - ES3D</title><meta name="description" content="Questions."></head><dl class="faq"><dt>What is ES3D?</dt><dd>A <b>file</b> format.</dd></dl>', 'faq/index.html');
  assert.match(faq, /"FAQPage"/);
  assert.match(faq, /"name": "What is ES3D\?"/);
  assert.match(faq, /"text": "A file format\."/);
  const article = structuredData('<head><title>Post</title><script type="application/ld+json">{"@type":"Article"}</script></head>', 'media/making-the-web-3d/index.html');
  assert.match(article, /BreadcrumbList/);
  assert.match(article, /"name": "Media"/);
  assert.match(article, /"name": "Post"/);
  assert.doesNotMatch(article, /"@type": "WebPage"/);
  assert.equal(structuredData('<head></head>', '404.html'), '<head></head>');
});

test('Markdown: a table with an empty header row is a list of names and values', () => {
  const { html } = renderMarkdown(['| | |', '|---|---|', '| Text | `.es3d` |', '| Media type | `model/vnd.es3d` |'].join('\n'));
  assert.doesNotMatch(html, /<thead>/);
  assert.match(html, /<tr><th scope="row">Text<\/th><td><code>.es3d<\/code><\/td><\/tr>/);
});

test('site navigation: a menu button for phones, and no New badges', () => {
  const nav = expandPage('<!--#include virtual="top.html" -->');
  assert.match(nav, /<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-links">/);
  assert.match(nav, /<div class="nav-links" id="nav-links">/);
  assert.match(nav, />File converter<\/a>/);
  assert.match(nav, />ES3D Modeller<\/a>/);
  assert.doesNotMatch(nav, /class="new"|>New</);
});
