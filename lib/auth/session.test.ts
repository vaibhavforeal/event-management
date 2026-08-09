import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminClient, createTestUser } from '@/tests/helpers/db'
// Installs the @/lib/supabase/server mock as a side effect — see that file.
import { signInAs } from '@/tests/helpers/session'

// redirect() signals by throwing and never returns to its caller. Standing in
// for it the same way is the only way to observe requireUser()'s signed-out
// path: a redirect that returned normally would be a bug this could not see.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  },
}))

/**
 * A Server Component cannot see its own URL, so proxy.ts puts it in a request
 * header. The literal 'x-pathname' is spelled out here rather than imported:
 * this is the wire format between two files that never call each other, and a
 * test that imported the constant would agree with itself after a rename while
 * the proxy and the reader silently stopped agreeing with each other.
 */
let currentPath: string | null = null
vi.mock('next/headers', () => ({
  headers: async () => new Headers(currentPath ? { 'x-pathname': currentPath } : {}),
}))

const { getCurrentUser, requireUser } = await import('@/lib/auth/session')

const db = adminClient()
let userId: string

beforeAll(async () => {
  userId = await createTestUser(db)
})

afterAll(async () => {
  await db.auth.admin.deleteUser(userId).catch(() => {})
})

describe('getCurrentUser', () => {
  it('returns the signed-in user', async () => {
    signInAs(userId)
    expect((await getCurrentUser())?.id).toBe(userId)
  })

  it('returns null when signed out', async () => {
    signInAs(null)
    expect(await getCurrentUser()).toBeNull()
  })
})

describe('requireUser', () => {
  it('returns the user when signed in', async () => {
    signInAs(userId)
    expect((await requireUser()).id).toBe(userId)
  })

  it('redirects to /login when signed out', async () => {
    signInAs(null)
    currentPath = null
    await expect(requireUser()).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it('carries the page the host wanted, so signing in returns them to it', async () => {
    // The deferral this closes: every protected page sent the host to /login and
    // /login sent them to the feed, so the edit screen they clicked was two
    // navigations behind wherever they landed.
    signInAs(null)
    currentPath = '/host/events/abc/edit'

    await expect(requireUser()).rejects.toThrow(
      'NEXT_REDIRECT:/login?next=%2Fhost%2Fevents%2Fabc%2Fedit',
    )
  })

  it('keeps the query string, which is where the feed filter lives', async () => {
    signInAs(null)
    currentPath = '/?city=Indore'

    await expect(requireUser()).rejects.toThrow('NEXT_REDIRECT:/login?next=%2F%3Fcity%3DIndore')
  })

  it('drops a return path that is not this site', async () => {
    // A header this app did not write should never reach redirect(). Belt and
    // braces over safeNextPath: if the proxy is ever bypassed, the fallback is
    // the plain sign-in page rather than someone else's origin.
    signInAs(null)
    currentPath = '//evil.example/phish'

    await expect(requireUser()).rejects.toThrow('NEXT_REDIRECT:/login')
  })
})
