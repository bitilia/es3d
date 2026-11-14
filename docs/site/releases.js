// The release history page (docs/history/): every published GitHub release,
// newest first, with its notes. The notes come from docs/site/releases.json,
// which `npm run releases` writes from GitHub (scripts/fetch-releases.mjs);
// the website workflow refreshes it before each build and rebuilds the site
// when a release is published, edited or deleted. Only published releases
// are shown: nothing is announced before it is out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, escapeHtml } from './markdown.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'releases.json');
const NPM = 'https://www.npmjs.com/package/@es3d/es3d/v/';

/** Published releases, newest first: {tag, name, published, url, body}. */
export function loadReleases() {
  return JSON.parse(fs.readFileSync(FILE, 'utf8')).releases.filter((r) => r.published && !r.prerelease);
}

/** The version a release names: its title when that is a version, else its tag ("Release" was v1.0.1). */
export function releaseVersion(r) {
  const v = /^v?\d+\.\d+\.\d+\S*$/;
  return v.test(r.name) ? r.name.replace(/^(?!v)/, 'v') : r.tag;
}

const dateOf = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A heading in a release's notes sits under the release's own heading. */
const demote = (html) => html.replace(/<(\/?)h([1-5])\b/g, (m, slash, n) => `<${slash}h${Math.min(6, Math.max(3, +n + 1))}`);

/** The history as HTML: one article per release. */
export function releaseHistory(releases = loadReleases()) {
  if (!releases.length) return '<p>No release has been published yet.</p>';
  const ids = new Set();
  const latest = releases[0];
  const items = releases.map((r) => {
    const version = releaseVersion(r);
    const id = version.replace(/[^\w.-]+/g, '-');
    ids.add(id);
    const npm = /^v(\d+\.\d+\.\d+)$/.exec(version);
    const meta = [`<time datetime="${escapeHtml(r.published)}">${dateOf(r.published)}</time>`];
    if (r.url) meta.push(`<a href="${escapeHtml(r.url)}">On GitHub</a>`);
    if (npm) meta.push(`<a href="${NPM}${npm[1]}">npm ${npm[1]}</a>`);
    if (r.tag !== version) meta.push(`tag <code>${escapeHtml(r.tag)}</code>`);
    const badge = r === latest ? '<span class="release-badge">Latest</span>' : '';
    const notes = r.body ? demote(renderMarkdown(r.body, { ids }).html) : '<p class="muted">No notes.</p>';
    return `<article class="release" id="${escapeHtml(id)}">
  <header class="release-head">
    <h2><a href="#${escapeHtml(id)}">${escapeHtml(version)}</a>${badge}</h2>
    <p class="release-meta">${meta.join(' · ')}</p>
  </header>
  <div class="release-notes">
${notes}
  </div>
</article>`;
  });
  return `<div class="releases">\n${items.join('\n')}\n</div>`;
}
