import { describe, expect, it } from 'vitest'
import { safeNextPath } from '@/lib/auth/next-path'

/**
 * `?next=` is attacker-controlled: it arrives in a URL, and a URL is the one
 * thing this product is built to have forwarded into a WhatsApp group. A value
 * that reaches redirect() unchecked turns every "sign in to continue" link into
 * an open redirect wearing this site's domain.
 */

describe('safeNextPath', () => {
  it('keeps an ordinary in-app path', () => {
    expect(safeNextPath('/host/events/abc/edit')).toBe('/host/events/abc/edit')
  })

  it('keeps the query string, which is where the filter state lives', () => {
    expect(safeNextPath('/?city=Indore')).toBe('/?city=Indore')
  })

  it('refuses an absolute URL', () => {
    expect(safeNextPath('https://evil.example/phish')).toBeNull()
    expect(safeNextPath('http://evil.example')).toBeNull()
  })

  it('refuses a protocol-relative URL', () => {
    // The classic bypass: it starts with '/', so a naive `startsWith('/')`
    // check passes it, and the browser reads it as //host = another origin.
    expect(safeNextPath('//evil.example/phish')).toBeNull()
  })

  it('refuses the backslash spelling of a protocol-relative URL', () => {
    // Browsers normalise backslashes to forward slashes in the authority
    // position, so these reach the same place as '//evil.example'.
    expect(safeNextPath('/\\evil.example')).toBeNull()
    expect(safeNextPath('\\\\evil.example')).toBeNull()
  })

  it('refuses a scheme that is not http', () => {
    expect(safeNextPath('javascript:alert(1)')).toBeNull()
    expect(safeNextPath('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('refuses a path that does not start with a slash', () => {
    expect(safeNextPath('host/events')).toBeNull()
    expect(safeNextPath('evil.example')).toBeNull()
  })

  it('refuses control characters, which can smuggle a second header', () => {
    expect(safeNextPath('/host\nLocation: https://evil.example')).toBeNull()
    expect(safeNextPath('/host\r\nSet-Cookie: a=b')).toBeNull()
    expect(safeNextPath('/host\tevents')).toBeNull()
  })

  it('refuses /login, so signing in cannot loop back to itself', () => {
    expect(safeNextPath('/login')).toBeNull()
    expect(safeNextPath('/login?next=/login')).toBeNull()
  })

  it('returns null for nothing at all', () => {
    expect(safeNextPath(null)).toBeNull()
    expect(safeNextPath(undefined)).toBeNull()
    expect(safeNextPath('')).toBeNull()
  })
})
