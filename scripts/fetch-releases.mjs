#!/usr/bin/env node
// The release notes the website's history page shows (docs/history/), from
// the project's GitHub releases. Writes docs/site/releases.json.
//
//   npm run releases
//
// The website workflow runs this before every build, and it runs again when a
// release is published, edited or deleted, so the page follows GitHub. The
// file is also committed: a build without network (or with the API limited)
// keeps the last notes it had, and this script never fails a build. With
// GITHUB_TOKEN set (as in GitHub Actions) the request is authenticated.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/site/releases.json');
const REPO = process.env.GITHUB_REPOSITORY_RELEASES || 'bitilia/es3d';

async function main() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'es3d-site-build', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
    const list = await res.json();
    all.push(...list);
    if (list.length < 100) break;
  }
  // published, full releases only: a draft or a prerelease is not announced
  const releases = all
    .filter((r) => !r.draft && !r.prerelease && r.published_at)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      published: r.published_at,
      url: r.html_url,
      body: (r.body || '').replace(/\r\n/g, '\n').trim(),
    }))
    .sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
  const json = JSON.stringify({ repository: REPO, releases }, null, 2) + '\n';
  const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (before === json) {
    console.log(`docs/site/releases.json is up to date (${releases.length} releases)`);
    return;
  }
  fs.writeFileSync(OUT, json);
  console.log(`wrote docs/site/releases.json (${releases.length} releases)`);
}

main().catch((e) => {
  // the committed notes stay; the page is built from them
  console.warn(`releases: kept docs/site/releases.json (${e.message})`);
});
