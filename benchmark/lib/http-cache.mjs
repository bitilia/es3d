// Static responses with standard HTTP caching (RFC 9110, RFC 9111):
//
// - a strong ETag from the content's SHA-256, so a browser revalidates with
//   If-None-Match and gets 304 Not Modified, without the body, when nothing
//   changed;
// - `Cache-Control: no-cache` (store, but revalidate before use) for pages
//   and documents, whose URL stays the same when they change;
// - `Cache-Control: public, max-age=31536000, immutable` for build assets
//   whose file name carries a content hash (Vite's assets/name-[hash].js):
//   a new version has a new URL, so the old one never needs checking;
// - brotli or gzip for text, as the request's Accept-Encoding allows, with
//   `Vary: Accept-Encoding` so caches keep the variants apart.
//
// Compressed bodies are kept per ETag, so a file is compressed once.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml|model\/vnd\.es3d)/;
const IMMUTABLE = /\/assets\/[^/]*-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
const encoded = new Map();

export function etagOf(body) {
  return `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

/** Whether an If-None-Match header names this ETag (weak comparison, as RFC 9110 asks for GET). */
export function matches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((t) => strip(t) === strip(etag));
}

/** The best encoding the request accepts: br, then gzip, else identity. */
export function negotiate(acceptEncoding) {
  const accepted = new Map();
  for (const part of String(acceptEncoding || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    accepted.set(name, q ? Number(q.slice(2)) : 1);
  }
  const ok = (name) => (accepted.has(name) ? accepted.get(name) > 0 : accepted.has('*') && accepted.get('*') > 0);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return 'identity';
}

/**
 * Send a static body with caching headers.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Buffer} body
 * @param {string} type Content-Type
 * @param {{path?: string, headers?: object}} [opts] path decides whether the URL is content-hashed
 */
export function sendStatic(req, res, body, type, opts = {}) {
  const etag = etagOf(body);
  const headers = {
    ...opts.headers,
    'content-type': type,
    etag,
    'cache-control': opts.path && IMMUTABLE.test(opts.path) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  const compressible = COMPRESSIBLE.test(type) && body.length > 1024;
  if (compressible) headers.vary = 'Accept-Encoding';
  if (matches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  let out = body;
  const encoding = compressible ? negotiate(req.headers['accept-encoding']) : 'identity';
  if (encoding !== 'identity') {
    const k = `${etag}:${encoding}`;
    if (!encoded.has(k)) {
      encoded.set(k, encoding === 'br' ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(body, { level: 9 }));
    }
    out = encoded.get(k);
    headers['content-encoding'] = encoding;
  }
  headers['content-length'] = out.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : out);
}
