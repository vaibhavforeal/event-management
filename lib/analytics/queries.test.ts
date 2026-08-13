import { describe, expect, it } from 'vitest'
import { signInAs } from '@/tests/helpers/session'
import { adminClient, seedPlatformAdmin } from '@/tests/helpers/db'

// After every static import: the mock in session.ts must be installed before
// this module binds @/lib/supabase/server. See that file's docblock.
const { businessSnapshot } = await import('@/lib/analytics/queries')

describe('businessSnapshot', () => {
  it('throws for a non-admin rather than rendering zeros', async () => {
    // EH071 from the RPC must surface as a throw — a failed read must not
    // read as "an empty business".
    signInAs(null)
    await expect(businessSnapshot()).rejects.toThrow(/Failed to read the business snapshot/)
  })

  it('returns the one row to an admin', async () => {
    const db = adminClient()
    const adminId = await seedPlatformAdmin(db)
    try {
      signInAs(adminId)
      const row = await businessSnapshot()
      expect(typeof row.gmv_paise).toBe('number')
      expect(typeof row.waitlisted_count).toBe('number')
    } finally {
      signInAs(null)
      await db.auth.admin.deleteUser(adminId).catch(() => {})
    }
  })
})
