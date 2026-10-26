/*
 * The storefront's service worker: the app opens with no signal, photos are
 * kept, and nothing about an order is ever answered from a cache.
 *
 *   - The page itself: the network when it answers within three seconds,
 *     else the copy kept here, so the app opens offline.
 *   - Built files (/assets/*, named by their content): kept for ever.
 *   - Photos (/img/<hash>, named by their content): kept, the newest ~300.
 *   - Everything else -- the API, the catalogue manifest -- goes to the
 *     network untouched. The catalogue itself is kept by the page in IndexedDB.
 */

const SHELL = 'shell-v1'
const IMAGES = 'img-v1'
const MAX_IMAGES = 300

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.png'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== IMAGES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  if (req.mode === 'navigate') {
    event.respondWith(page(req))
  } else if (url.origin === location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(kept(SHELL, req))
  } else if (/^\/img\/[0-9a-f]{64}$/.test(url.pathname)) {
    event.respondWith(photo(req))
  }
})

async function page(req) {
  const cache = await caches.open(SHELL)
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3000)),
    ])
    if (res.ok) await cache.put('/', res.clone())
    return res
  } catch {
    return (await cache.match('/')) || Response.error()
  }
}

async function kept(name, req) {
  const cache = await caches.open(name)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone())
  return res
}

async function photo(req) {
  const cache = await caches.open(IMAGES)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) {
    await cache.put(req, res.clone())
    const keys = await cache.keys()
    // Oldest first: a cache keeps insertion order.
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_IMAGES))) await cache.delete(old)
  }
  return res
}
