// Compression helpers that work in browsers (CompressionStream) and in Node
// (zlib, which also provides brotli). Used for file-size statistics and the
// benchmark, and for loading .gz files.

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof window === 'undefined';

let zlibPromise = null;
function zlib() {
  // Node only; the variable keeps bundlers from trying to resolve it for browsers
  const specifier = 'node:zlib';
  if (!zlibPromise) zlibPromise = import(/* @vite-ignore */ specifier);
  return zlibPromise;
}

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

async function streamBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gzip (level 9 in Node, browser default otherwise). */
export async function gzip(data) {
  const bytes = toBytes(data);
  if (isNode) {
    const z = await zlib();
    return new Uint8Array(z.gzipSync(bytes, { level: 9 }));
  }
  return streamBytes(bytes, new CompressionStream('gzip'));
}

export async function gunzip(data) {
  const bytes = toBytes(data);
  if (isNode) {
    const z = await zlib();
    return new Uint8Array(z.gunzipSync(bytes));
  }
  return streamBytes(bytes, new DecompressionStream('gzip'));
}

/** Brotli (quality 11). Returns null where unavailable (browsers lack a brotli compressor API). */
export async function brotli(data) {
  const bytes = toBytes(data);
  if (isNode) {
    const z = await zlib();
    return new Uint8Array(z.brotliCompressSync(bytes, { params: { [z.constants.BROTLI_PARAM_QUALITY]: 11, [z.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }));
  }
  try {
    return await streamBytes(bytes, new CompressionStream('br'));
  } catch {
    return null;
  }
}

export async function compressedSizes(data) {
  const bytes = toBytes(data);
  const [g, b] = await Promise.all([gzip(bytes), brotli(bytes)]);
  return { raw: bytes.length, gzip: g.length, brotli: b ? b.length : null };
}

export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
