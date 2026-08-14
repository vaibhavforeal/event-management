import { describe, expect, it } from 'vitest'
// The strategy ships as a plain ESM file in public/ so the module service
// worker can import it WITHOUT a bundler; vitest imports the same file here.
// @ts-expect-error — plain .mjs, no type declarations, deliberately.
import { decide, isStaleCache, PAGES_CACHE, STATIC_CACHE } from '../../../public/sw-strategy.mjs'

const ORIGIN = 'https://happenly.example.com'
const GET_NAV = { method: 'GET', mode: 'navigate' }
const GET_FETCH = { method: 'GET', mode: 'no-cors' }

describe('decide — the whole fetch policy, three rules', () => {
  it('immutable build assets are cache-first', () => {
    expect(decide(`${ORIGIN}/_next/static/chunks/main-abc123.js`, GET_FETCH)).toBe('static')
    expect(decide(`${ORIGIN}/_next/static/media/geist-xyz.woff2`, GET_FETCH)).toBe('static')
  })

  it('a navigation to the scan page is network-first', () => {
    expect(decide(`${ORIGIN}/host/events/8f14e45f-0000-4000-8000-000000000001/scan`, GET_NAV)).toBe(
      'scan-page',
    )
    expect(decide(`${ORIGIN}/host/events/8f14e45f-0000-4000-8000-000000000001/scan/`, GET_NAV)).toBe(
      'scan-page',
    )
  })

  it('everything else passes through untouched', () => {
    expect(decide(`${ORIGIN}/`, GET_NAV)).toBe('passthrough') // the feed: NOT cached
    expect(decide(`${ORIGIN}/host/events/x/attendees`, GET_NAV)).toBe('passthrough')
    expect(decide(`${ORIGIN}/host/events/x/scan`, GET_FETCH)).toBe('passthrough') // not a navigation
    expect(decide(`${ORIGIN}/api/cron`, GET_FETCH)).toBe('passthrough')
    expect(decide(`${ORIGIN}/host/events/x/scan`, { method: 'POST', mode: 'navigate' })).toBe(
      'passthrough', // server actions are never cached
    )
  })
})

describe('isStaleCache', () => {
  it('condemns other versions of our caches and nothing else', () => {
    expect(isStaleCache('happenly-static-v0')).toBe(true)
    expect(isStaleCache('happenly-pages-v0')).toBe(true)
    expect(isStaleCache(STATIC_CACHE)).toBe(false)
    expect(isStaleCache(PAGES_CACHE)).toBe(false)
    expect(isStaleCache('someone-elses-cache')).toBe(false)
  })
})
