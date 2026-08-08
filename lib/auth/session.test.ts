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
    await expect(requireUser()).rejects.toThrow('NEXT_REDIRECT:/login')
  })
})
