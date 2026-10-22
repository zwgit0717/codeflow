/**
 * CodeFlow Asset Delivery
 *
 * Serves runtime binaries from a private R2 bucket over a custom domain.
 * The bucket itself stays private -- only this worker can read it -- and the
 * custom domain is the public door onto it. No shared secret is involved:
 * a request that reaches the domain is served.
 *
 * Bindings:
 *   ASSETS       R2 bucket (private)
 *
 * Routes:
 *   GET /healthz              liveness probe
 *   GET /d/<name>-<arch>      asset body, Range supported
 *   HEAD /d/<name>-<arch>     asset metadata only
 */

// The allow list is the security boundary: the bucket is never enumerated,
// so a name that is not listed here simply does not exist.
const ALLOWED = new Set(['core-engine', 'edge-router', 'health-agent', 'nezha-agent']);
const ARCHS = new Set(['amd64', 'arm64']);

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      extra || {},
    ),
  });
}

/**
 * `/d/<name>-<arch>` maps to the object key `<name>-<arch>`.
 * Every other shape is rejected here, so the bucket is never enumerated.
 */
function resolveKey(pathname) {
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'd') return null;
  const cut = parts[1].lastIndexOf('-');
  if (cut < 1) return null;
  const name = parts[1].slice(0, cut);
  const arch = parts[1].slice(cut + 1);
  if (!ALLOWED.has(name) || !ARCHS.has(arch)) return null;
  return `${name}-${arch}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method !== 'GET' && method !== 'HEAD') {
      return json({ error: 'method not allowed' }, 405);
    }

    if (url.pathname === '/healthz') {
      return json({ status: 'ok' });
    }

    const key = resolveKey(url.pathname);
    if (!key) return json({ error: 'not found' }, 404);

    // The range is only forwarded when the request actually asks for one.
    // Handing R2 the whole header bag made it treat every read as a ranged
    // read, so even a plain GET came back with a range attached and had to
    // be answered 206 -- which the downloader rejects, since it expects a
    // complete body.
    const range = request.headers.get('range');
    const object = range
      ? await env.ASSETS.get(key, { range })
      : await env.ASSETS.get(key);
    if (!object) return json({ error: 'not found' }, 404);

    const headers = new Headers();
    headers.set('content-type', 'application/octet-stream');
    headers.set('cache-control', 'public, max-age=3600');
    headers.set('etag', object.httpEtag);
    headers.set('x-content-type-options', 'nosniff');

    // A ranged read has to answer 206 with a real byte range. The R2 range
    // object carries offset and length, not a printable string -- rendering
    // it directly produced "bytes [object Object]" and a 200, which tells the
    // client the whole body is present when only a slice was sent.
    let status = 200;
    if (object.range && object.size !== undefined) {
      const offset = Number(object.range.offset || 0);
      const length = Number(object.range.length || 0);
      const end = offset + Math.max(length - 1, 0);
      headers.set('content-range', `bytes ${offset}-${end}/${object.size}`);
      headers.set('content-length', String(length));
      status = 206;
    } else if (object.size !== undefined) {
      headers.set('content-length', String(object.size));
    }

    if (method === 'HEAD') return new Response(null, { status, headers });
    return new Response(object.body, { status, headers });
  },
};
