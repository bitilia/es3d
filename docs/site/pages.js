// Every page of the website, in one list. The build takes its inputs from
// here, and the site plugin writes the sitemap and each page's link preview
// (canonical address, Open Graph and Twitter tags) from it.

/** Address of the published site. Canonical links and the sitemap use it. */
export const SITE_URL = 'https://es3d.org/';

/**
 * Pictures shown when a page is shared, from docs/images. Each one is
 * copied into the built site at images/<file>.
 */
export const PREVIEW_IMAGES = {
  'studio-primitives.jpg': { width: 2000, height: 1125, alt: 'ES3D Studio: the source of a scene on the left, the live 3D preview, scene tree and statistics on the right' },
  'studio-forest.jpg': { width: 2000, height: 1125, alt: 'The forest example in ES3D Studio: 2,400 trees and rocks placed by three scatter elements' },
  'studio-errors.jpg': { width: 2000, height: 1125, alt: 'ES3D Studio showing located errors with did-you-mean suggestions, underlined in the editor' },
  'demo-ashby.jpg': { width: 1600, height: 1000, alt: 'Ashby: fields, a river and a palisaded medieval village with its church and keep' },
  'demo-parcel.jpg': { width: 1600, height: 1000, alt: 'Parcel: a red gift box with an ivory ribbon and bow' },
  'demo-spoke.jpg': { width: 1600, height: 1000, alt: 'Spoke: a red bicycle with eight-spoke wheels' },
  'demo-helio.jpg': { width: 1600, height: 1000, alt: 'Helio: a dark room with three lamps lighting a table' },
  'demo-castle.jpg': { width: 1600, height: 900, alt: 'A moonlit flight toward a wizard’s castle on a floating island' },
};

const DEFAULT_IMAGE = 'studio-primitives.jpg';

/**
 * The pages. `file` is relative to docs/. `image` picks the link-preview
 * picture. `sitemap: false` keeps a page out of the sitemap and out of
 * search results.
 */
export const PAGES = [
  { file: 'index.html', name: 'Home' },
  { file: 'examples/index.html', name: 'Examples', image: 'studio-forest.jpg' },
  { file: 'demo/index.html', name: 'Demo Sites', image: 'demo-ashby.jpg' },
  { file: 'demo/ashby/index.html', name: 'Ashby', image: 'demo-ashby.jpg' },
  { file: 'demo/parcel/index.html', name: 'Parcel', image: 'demo-parcel.jpg' },
  { file: 'demo/spoke/index.html', name: 'Spoke', image: 'demo-spoke.jpg' },
  { file: 'demo/helio/index.html', name: 'Helio', image: 'demo-helio.jpg' },
  { file: 'demo/castle/index.html', name: 'Castle', image: 'demo-castle.jpg' },
  { file: 'demo/castle/es3d/index.html', name: 'Castle, ES3D', image: 'demo-castle.jpg' },
  { file: 'demo/castle/glTF/index.html', name: 'Castle, glTF', image: 'demo-castle.jpg' },
  { file: 'spec/index.html', name: 'Specification', image: 'studio-errors.jpg' },
  { file: 'reference/index.html', name: 'Element reference', image: 'studio-errors.jpg' },
  { file: 'media/index.html', name: 'Media' },
  { file: 'media/why-es3d-came-to-be/index.html', name: 'Why ES3D came to be' },
  { file: 'media/making-the-web-3d/index.html', name: 'Making the Web 3D' },
  {
    file: 'media/making-the-web-lighter/index.html',
    name: 'Making the web lighter',
    video: {
      title: 'Making the web lighter',
      description: 'A 41-second short on the ES3D channel. It shows the castle demo.',
      thumbnail: 'https://i.ytimg.com/vi/hWGNOcR_cmg/oardefault.jpg',
      thumbnailWidth: 1080,
      thumbnailHeight: 1920,
      poster: 'https://i.ytimg.com/vi/hWGNOcR_cmg/maxresdefault.jpg',
      posterWidth: 1280,
      posterHeight: 720,
      player: 'https://www.youtube-nocookie.com/embed/hWGNOcR_cmg',
      watch: 'https://www.youtube.com/shorts/hWGNOcR_cmg',
      channel: 'https://www.youtube.com/@es3dfile',
      durationSeconds: 41,
      published: '2026-10-24T03:31:03-07:00',
    },
  },
  { file: 'download/index.html', name: 'Download' },
  { file: 'faq/index.html', name: 'FAQ' },
  { file: 'benchmark-devices/index.html', name: 'Benchmarks', image: 'studio-forest.jpg' },
  { file: 'convert/index.html', name: 'File converter' },
  { file: 'studio/index.html', name: 'ES3D Studio' },
  { file: 'modeller/index.html', name: 'ES3D Modeller' },
  { file: '404.html', name: 'Page not found', sitemap: false },
];

/** The site directory of a page file: 'spec/index.html' → 'spec', 'index.html' → ''. */
export function pageDir(file) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  return file.endsWith('index.html') ? dir : file.replace(/\.html$/, '');
}

/** The page entry for a file relative to docs/, or undefined. */
export function pageFor(file) {
  return PAGES.find((p) => p.file === file);
}

/** The published address of a page. */
export function pageUrl(page) {
  const dir = pageDir(page.file);
  return SITE_URL + (dir ? `${dir}/` : '');
}

/** The link-preview picture of a page: its file name and details. */
export function previewImage(page) {
  const file = (page && page.image) || DEFAULT_IMAGE;
  return { file, url: `${SITE_URL}images/${file}`, ...PREVIEW_IMAGES[file] };
}

/** Calendar date for "Last updated" and sitemap lastmod, YYYY-MM-DD in local time. */
export function siteDate(d = new Date()) {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** ISO 8601 local date and time with a numeric offset, for structured data. */
export function siteDateTime(d = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${siteDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(Math.abs(off) % 60)}`;
}

/**
 * Breadcrumb from the site root to this page. The last name is the page title
 * when one is passed; earlier names come from the page list.
 */
export function breadcrumbItems(page, currentName) {
  const dir = pageDir(page.file);
  const parts = dir ? dir.split('/') : [];
  const items = [{ name: 'Home', url: SITE_URL }];
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    const node = PAGES.find((p) => pageDir(p.file) === acc);
    if (!node) continue;
    const last = i === parts.length - 1;
    items.push({ name: last && currentName ? currentName : (node.name || parts[i]), url: pageUrl(node) });
  }
  return items;
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** One video sitemap block. Google wants the player page, a thumbnail, and the file or player URL. */
function videoSitemap(video) {
  return `
    <video:video>
      <video:thumbnail_loc>${xml(video.poster)}</video:thumbnail_loc>
      <video:title>${xml(video.title)}</video:title>
      <video:description>${xml(video.description)}</video:description>
      <video:player_loc allow_embed="yes">${xml(video.player)}</video:player_loc>
      <video:duration>${video.durationSeconds}</video:duration>
      <video:publication_date>${xml(video.published)}</video:publication_date>
      <video:family_friendly>yes</video:family_friendly>
      <video:live>no</video:live>
    </video:video>`;
}

/** sitemap.xml for every page that is listed in it. lastmod is the site date. */
export function sitemapXml(modified = siteDate()) {
  const videos = PAGES.some((p) => p.video && p.sitemap !== false);
  const xmlns = videos
    ? 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'
    : 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  const urls = PAGES.filter((p) => p.sitemap !== false).map((p) => {
    const extra = p.video ? videoSitemap(p.video) : '';
    return `  <url>\n    <loc>${pageUrl(p)}</loc>\n    <lastmod>${modified}</lastmod>${extra}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${xmlns}>\n${urls.join('\n')}\n</urlset>\n`;
}
