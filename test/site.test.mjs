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

const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting', 'ScholarlyArticle', 'TechArticle', 'Report']);
const SOFTWARE_TYPES = new Set(['SoftwareApplication', 'WebApplication', 'MobileApplication']);

function typesOf(node) {
  const t = node['@type'];
  if (!t) return new Set();
  return new Set(Array.isArray(t) ? t : [t]);
}

function walkNodes(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkNodes(item, visit);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walkNodes(value, visit);
}

function jsonBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function renderSitePage(file) {
  const docs = path.join(import.meta.dirname, '..', 'docs');
  const html = fs.readFileSync(path.join(docs, file), 'utf8');
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const root = dir ? `${dir.split('/').map(() => '..').join('/')}/` : '';
  return structuredData(linkPreview(expandPage(html, { ROOT: root, HOME: root || './', PAGE_DIR: dir }), file), file);
}

test('structured data on every public page is valid for Google rich results', () => {
  const docs = path.join(import.meta.dirname, '..', 'docs');
  const logo = fs.readFileSync(path.join(docs, 'public/logo.png'));
  assert.equal(logo.readUInt32BE(16), 1216);
  assert.equal(logo.readUInt32BE(20), 384);
  const videoPage = PAGES.find((p) => p.video);
  const xml = sitemapXml();
  assert.match(xml, /xmlns:video="http:\/\/www\.google\.com\/schemas\/sitemap-video\/1\.1"/);
  assert.match(xml, new RegExp(`<loc>${videoPage.video.player.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>|<video:player_loc[^>]*>${videoPage.video.player}</video:player_loc>`));
  assert.match(xml, /<video:thumbnail_loc>https:\/\/i\.ytimg\.com\/vi\/hWGNOcR_cmg\/maxresdefault\.jpg<\/video:thumbnail_loc>/);
  assert.match(xml, /<video:duration>41<\/video:duration>/);
  assert.match(xml, /<loc>https:\/\/es3d\.org\/media\/<\/loc>/);

  for (const page of PAGES) {
    if (page.sitemap === false) {
      assert.equal(structuredData('<head></head>', page.file), '<head></head>');
      continue;
    }
    const html = renderSitePage(page.file);
    const blocks = jsonBlocks(html);
    assert.ok(blocks.length, `${page.file} has no JSON-LD`);
    const nodes = [];
    for (const block of blocks) {
      assert.doesNotMatch(block, /<!--|favicon\.svg/, page.file);
      nodes.push(JSON.parse(block));
    }
    assert.match(html, /https:\/\/es3d\.org\/logo\.png/, page.file);
    assert.match(html, /https:\/\/www\.youtube\.com\/@es3dfile/, page.file);
    let sawOrg = false;
    walkNodes(nodes, (node) => {
      const types = typesOf(node);
      if (typeof node.dateModified === 'string') {
        assert.match(node.dateModified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, page.file);
        if (typeof node.datePublished === 'string') {
          assert.ok(Date.parse(node.dateModified) >= Date.parse(node.datePublished), `${page.file} dateModified before datePublished`);
        }
      }
      if (types.has('Organization') && node.name === 'ES3D') {
        sawOrg = true;
        assert.equal(node.url, 'https://es3d.org/');
        assert.equal(node.logo?.url, 'https://es3d.org/logo.png');
        assert.equal(node.logo.contentUrl, 'https://es3d.org/logo.png');
        assert.equal(node.logo.width, 1216);
        assert.equal(node.logo.height, 384);
        assert.ok(!/\.svg(\?|$)/i.test(node.logo.url));
        const same = [].concat(node.sameAs || []);
        assert.ok(same.includes('https://www.youtube.com/@es3dfile'), page.file);
        assert.ok(same.includes('https://github.com/bitilia/es3d'), page.file);
      }
      for (const type of SOFTWARE_TYPES) {
        if (!types.has(type)) continue;
        const price = node.offers?.price;
        assert.ok(price === 0 || price === '0' || Number(price) > 0, `${page.file} ${type} price`);
        assert.ok(node.aggregateRating || node.review, `${page.file} ${type} requires a rating that is visible on the page`);
      }
      if ([...types].some((type) => ARTICLE_TYPES.has(type))) {
        assert.ok(node.headline && node.headline.length <= 110, `${page.file} headline`);
        const images = [].concat(node.image || []);
        assert.ok(images.some((img) => typeof img === 'string' ? img : img?.url), `${page.file} image`);
        assert.ok(node.datePublished, `${page.file} datePublished`);
        const authors = [].concat(node.author || []);
        assert.ok(authors.some((author) => author?.name && (author.url || author.sameAs)), `${page.file} author`);
      }
      if (types.has('VideoObject')) {
        assert.equal(node.name, videoPage.video.title);
        assert.equal(node.description, videoPage.video.description);
        assert.equal(node.uploadDate, videoPage.video.published);
        assert.equal(node.duration, `PT${videoPage.video.durationSeconds}S`);
        assert.equal(node.embedUrl, videoPage.video.player);
        const thumbs = [].concat(node.thumbnailUrl || []);
        assert.ok(thumbs.includes(videoPage.video.poster) && thumbs.includes(videoPage.video.thumbnail));
        assert.match(html, new RegExp(`<iframe[^>]*src="${node.embedUrl}"`));
      }
      if (types.has('BreadcrumbList')) {
        node.itemListElement.forEach((item, i) => {
          assert.equal(item['@type'], 'ListItem');
          assert.equal(item.position, i + 1, page.file);
          assert.ok(item.name, page.file);
          assert.match(item.item, /^https:\/\/es3d\.org\//, page.file);
        });
      }
      if (types.has('FAQPage')) {
        const questions = [].concat(node.mainEntity || []);
        assert.ok(questions.length >= 2, page.file);
        for (const question of questions) {
          assert.equal(question['@type'], 'Question');
          assert.ok(question.name && question.acceptedAnswer?.text, page.file);
        }
      }
      if (types.has('ItemList') && page.file === 'media/index.html') {
        assert.equal(node.numberOfItems, node.itemListElement.length);
        const urls = node.itemListElement.map((item) => item.url);
        assert.deepEqual(urls, [
          'https://es3d.org/media/making-the-web-lighter/',
          'https://zenodo.org/records/23403919',
          'https://dev.to/pavkode/optimizing-3d-file-formats-for-web-performance-by-reducing-precision-and-complexity-2i8i',
          'https://es3d.org/media/why-es3d-came-to-be/',
          'https://es3d.org/media/making-the-web-3d/',
        ]);
      }
    });
    assert.ok(sawOrg, `${page.file} organization`);
    if (page.file === 'media/index.html') {
      const joined = blocks.join('\n');
      assert.doesNotMatch(joined, /ScholarlyArticle|BlogPosting|VideoObject|SoftwareApplication/);
      assert.match(html, /making-the-web-lighter\//);
    }
    if (page.video) {
      assert.match(html, new RegExp(`src="${page.video.player}"`));
      assert.match(html, new RegExp(page.video.watch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(html, /"@type": "VideoObject"/);
    }
  }
});
