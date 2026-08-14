/**
 * The service worker's entire decision surface, pure and importable: the SW
 * (public/sw.js, a module worker) imports this file over HTTP, and the vitest
 * suite (lib/checkin/offline/sw-strategy.test.ts) imports it from disk. That
 * split is the repo's pure/glue rule applied without a bundler.
 *
 * Scope is deliberately the scanner and its assets, nothing else — the spec's
 * "scanner only" ruling. HTML is network-first so online is always fresh;
 * offline serves the page as of the last online visit, whose hashed chunks
 * were runtime-cached during that same visit — a consistent pair, no build
 * stamping. Bump CACHE_VERSION to condemn a bad deploy's caches.
 */

export const CACHE_VERSION = 'v1'
const PREFIX = 'happenly-'
export const STATIC_CACHE = `${PREFIX}static-${CACHE_VERSION}`
export const PAGES_CACHE = `${PREFIX}pages-${CACHE_VERSION}`

const SCAN_PATH = /^\/host\/events\/[^/]+\/scan\/?$/

/**
 * `origin` is the worker's own (self.location.origin): only same-origin
 * requests may reach a cache — a foreign host serving /_next/static/… paths
 * must not be able to seed ours. Missing origin fails the same way, closed.
 *
 * @param {string} url
 * @param {{ method: string, mode: string, origin: string }} init
 * @returns {'static' | 'scan-page' | 'passthrough'}
 */
export function decide(url, { method, mode, origin }) {
  if (method !== 'GET') return 'passthrough'
  const parsed = new URL(url)
  if (parsed.origin !== origin) return 'passthrough'
  if (parsed.pathname.startsWith('/_next/static/')) return 'static'
  if (mode === 'navigate' && SCAN_PATH.test(parsed.pathname)) return 'scan-page'
  return 'passthrough'
}

/** @param {string} name */
export function isStaleCache(name) {
  return name.startsWith(PREFIX) && name !== STATIC_CACHE && name !== PAGES_CACHE
}
