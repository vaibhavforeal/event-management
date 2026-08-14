/**
 * Happenly's service worker: thin glue over public/sw-strategy.mjs (tested in
 * vitest — keep decisions THERE, not here). Registered as a module worker
 * (app/sw-register.tsx), which lets this static file import the strategy
 * without a bundler. Chrome-on-Android is the host profile (the 2b ruling);
 * browsers without module workers simply never register this, and lose only
 * offline reloads.
 */
import { decide, isStaleCache, PAGES_CACHE, STATIC_CACHE } from '/sw-strategy.mjs'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter(isStaleCache).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const rule = decide(event.request.url, {
    method: event.request.method,
    mode: event.request.mode,
  })
  if (rule === 'static') event.respondWith(cacheFirst(event.request))
  else if (rule === 'scan-page') event.respondWith(networkFirst(event.request))
  // passthrough: no respondWith — the browser does exactly what it always did.
})

/** Content-hashed assets: a hit is immutable, a miss fills the cache. */
async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

/** Scan-page HTML: online always fresh (and re-cached); offline, the last visit. */
async function networkFirst(request) {
  const cache = await caches.open(PAGES_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: true })
    if (hit) return hit
    throw error
  }
}
