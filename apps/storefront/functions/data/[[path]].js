/*
 * The shop's public side, served from Cloudflare whether the till is on or off.
 *
 * The main till uploads it to the `SHOP` KV namespace whenever it changes
 * (apps/pos/src/core/cloudShop.ts):
 *   status       open or closed, name, contact, WhatsApp, offers
 *   catalog      { hash, since, items, body }: the item list and its name
 *   img-<hash>   each photo, by its own content hash
 *
 * Served as
 *   /data/status.json             (a few seconds stale at most)
 *   /data/manifest.json           { hash, since, items }
 *   /data/catalog/<hash>.json     the list, for ever, since its name is its content
 *   /data/img/<hash>              a photo, for ever
 *
 * Orders, sign-in and order status are not here: they need the till.
 */

const IMMUTABLE = 'public, max-age=31536000, immutable'
const BRIEF = 'public, max-age=10'
const HEX = /^[0-9a-f]{64}$/

export async function onRequestGet({ request, env, params, waitUntil }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path]
  const cache = caches.default
  const hit = await cache.match(request)
  if (hit) return hit

  const res = await answer(env.SHOP, parts)
  if (res.status === 200) waitUntil(cache.put(request, res.clone()))
  return res
}

async function answer(kv, parts) {
  /* Exactly one of the four shapes, nothing trailing. */
  if (parts.length > 2 || parts.some((p) => typeof p !== 'string' || p === '' || p === '..')) return missing()
  const [first, second] = parts
  if (first === 'status.json' && second === undefined) {
    const status = await kv.get('status')
    return status ? reply(status, 'application/json', BRIEF) : missing()
  }
  if (first === 'manifest.json' && second === undefined) {
    const c = await kv.get('catalog', 'json')
    return c ? reply(JSON.stringify({ hash: c.hash, since: c.since, items: c.items }), 'application/json', BRIEF) : missing()
  }
  if (first === 'catalog' && typeof second === 'string' && second.endsWith('.json') && HEX.test(second.slice(0, -5))) {
    const c = await kv.get('catalog', 'json')
    return c && `${c.hash}.json` === second ? reply(c.body, 'application/json', IMMUTABLE) : missing()
  }
  if (first === 'img' && HEX.test(second ?? '')) {
    const bytes = await kv.get(`img-${second}`, 'arrayBuffer')
    return bytes ? reply(bytes, kind(new Uint8Array(bytes)), IMMUTABLE) : missing()
  }
  return missing()
}

/** Photos are WebP from the till; older ones may be JPEG or PNG. */
function kind(b) {
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  return 'image/jpeg'
}

function reply(body, type, cacheControl) {
  return new Response(body, {
    headers: { 'content-type': type, 'cache-control': cacheControl, 'access-control-allow-origin': '*' },
  })
}

function missing() {
  return new Response('{"error":"NOT_FOUND"}', {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  })
}
