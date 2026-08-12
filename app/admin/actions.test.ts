import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  seedPlatformAdmin,
  type SeededEvent,
} from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session'

// revalidatePath needs a request store; there isn't one here.
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))

const { recordPayoutAction } = await import('@/app/admin/actions')
const { requirePlatformAdmin } = await import('@/lib/payouts/admin')

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let ended: SeededEvent

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)
  ended = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  await seedCapturedBooking(db, ended, { subtotalPaise: 50_000 })
})

afterAll(async () => {
  signInAs(null)
  await cleanupEvent(db, ended)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
})

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.append(key, value)
  return data
}

describe('requirePlatformAdmin', () => {
  // notFound() throws a Next control-flow error rather than returning, so the
  // gate is assertable without a rendering harness. This is what makes the
  // page's 404 a tested claim and not only a line in the manual walk.
  it('throws for a signed-in non-admin', async () => {
    signInAs(outsiderId)
    await expect(requirePlatformAdmin()).rejects.toThrow()
  })

  it('throws for a signed-out visitor', async () => {
    signInAs(null)
    await expect(requirePlatformAdmin()).rejects.toThrow()
  })

  it('returns for an admin', async () => {
    signInAs(adminId)
    await expect(requirePlatformAdmin()).resolves.toBeUndefined()
  })
})

describe('recordPayoutAction', () => {
  it('refuses a signed-in non-admin', async () => {
    signInAs(outsiderId)
    const result = await recordPayoutAction(
      {},
      form({ eventId: ended.eventId, status: 'paid', utr: 'UTR7', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
    expect(result.error).toBeTruthy()
  })

  it('rejects a status that is neither paid nor on_hold', async () => {
    signInAs(adminId)
    const result = await recordPayoutAction(
      {},
      form({ eventId: ended.eventId, status: 'pending', utr: 'UTR7', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
  })

  it('requires a UTR when settling', async () => {
    signInAs(adminId)
    const result = await recordPayoutAction(
      {},
      form({ eventId: ended.eventId, status: 'paid', utr: '  ', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
    expect(result.error).toMatch(/reference/i)
  })

  it('settles using the SERVER\'s numbers, not the form\'s', async () => {
    // The single most important assertion in this file. A tampered amount must
    // change nothing about what is recorded.
    signInAs(adminId)
    const result = await recordPayoutAction(
      {},
      form({
        eventId: ended.eventId,
        status: 'paid',
        utr: 'UTR800001',
        notes: '',
        grossPaise: '999999',
        netPaise: '999999',
      }),
    )
    expect(result.ok).toBe(true)

    const { data } = await db.from('payouts').select('*').eq('event_id', ended.eventId).single()
    expect(data!.gross_paise).toBe(50_000)
    expect(data!.net_paise).toBe(50_000)
  })

  it('refuses an event that is not settleable, whatever the form says', async () => {
    signInAs(adminId)
    const future = await seedEvent(db, { startsAt: new Date(Date.now() + HOUR).toISOString() })
    const result = await recordPayoutAction(
      {},
      form({ eventId: future.eventId, status: 'paid', utr: 'UTR9', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
    await cleanupEvent(db, future)
  })
})
