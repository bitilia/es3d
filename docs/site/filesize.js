// How the site states a file size: the ES3D file and its gzipped size. The
// site plugin uses it to write the recorded sizes (docs/site/sizes.json, from
// `npm run sizes`) into pages, so every page says it the same way.

// A no-break space keeps a number and its unit on one line wherever a size wraps.
const NBSP = ' ';

export function formatBytes(n) {
  if (n < 1024) return `${n.toLocaleString('en-US')}${NBSP}bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}${NBSP}kB`;
  return `${(n / (1024 * 1024)).toFixed(1)}${NBSP}MB`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * One line of HTML: "11.9 kB ES3D file · 2.9 kB gzipped".
 * @param {{es3d: number, gzip?: number|null}} m
 */
export function sizeHtml(m) {
  const line = `<b>${esc(formatBytes(m.es3d))}</b> ES3D file`;
  // the gzipped figure stays on one line with its label when the text wraps
  return m.gzip ? `${line} <span class="filesize-gzip">· ${esc(formatBytes(m.gzip))} gzipped</span>` : line;
}
