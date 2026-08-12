import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

// After every static import: the mock in session.ts must be installed before
// this module binds @/lib/supabase/server. See that file's docblock.
const { isPlatformAdmin, listSettleableEvents, listHostStatements, hostPayoutTarget } =
  await import('@/lib/payouts/queries')
const { recordPayout } = await import('@/lib/payouts/service')

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let ended: SeededEvent
let ended2: SeededEvent
let future: SeededEvent
const extraAttendees: string[] = []

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)

  ended = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  // Second ended event to test multi-event grouping
  ended2 = await seedEvent(db, {
    startsAt: new Date(Date.now() - 72 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
  })
  future = await seedEvent(db, { startsAt: new Date(Date.now() + 24 * HOUR).toISOString() })

  for (let i = 0; i < 4; i += 1) extraAttendees.push(await createTestUser(db))

  // ₹500 confirmed, ₹300 forfeited, ₹400 refunded, ₹250 cash.
  await seedCapturedBooking(db, ended, { subtotalPaise: 50_000 })
  await seedCapturedBooking(db, ended, {
    status: 'cancelled', subtotalPaise: 30_000, attendeeId: extraAttendees[0],
  })
  await seedCapturedBooking(db, ended, {
    status: 'refunded', refunded: true, subtotalPaise: 40_000, attendeeId: extraAttendees[1],
  })
  await seedCapturedBooking(db, ended, {
    paymentMode: 'cash', captured: false, subtotalPaise: 25_000, attendeeId: extraAttendees[2],
  })

  // Second event with one booking to ensure grouping works
  await seedCapturedBooking(db, ended2, { subtotalPaise: 100_000, attendeeId: extraAttendees[3] })

  await db.from('hosts').update({ upi_id: 'host@upi' }).eq('id', ended.hostId)
})

afterAll(async () => {
  signInAs(null)
  await cleanupEvent(db, ended)
  await cleanupEvent(db, ended2)
  await cleanupEvent(db, future)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
  for (const id of extraAttendees) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('isPlatformAdmin', () => {
  it('is true for an admin and false for everyone else', async () => {
    signInAs(adminId)
    expect(await isPlatformAdmin()).toBe(true)
    signInAs(outsiderId)
    expect(await isPlatformAdmin()).toBe(false)
    signInAs(null)
    expect(await isPlatformAdmin()).toBe(false)
  })
})

describe('listSettleableEvents', () => {
  it('computes the statement for an ended event', async () => {
    signInAs(adminId)
    const rows = await listSettleableEvents()
    const row = rows.find((r) => r.eventId === ended.eventId)
    expect(row).toBeDefined()
    expect(row!.statement.grossPaise).toBe(80_000)
    expect(row!.statement.forfeitedPaise).toBe(30_000)
    expect(row!.statement.cashPaise).toBe(25_000)
    expect(row!.statement.netPaise).toBe(80_000)
    expect(row!.payout).toBeNull()
    expect(row!.driftPaise).toBeNull()
  })

  it('leaves out an event that has not ended', async () => {
    signInAs(adminId)
    const rows = await listSettleableEvents()
    expect(rows.map((r) => r.eventId)).not.toContain(future.eventId)
  })

  it('returns nothing to a signed-in non-admin', async () => {
    // The RLS policies are the guard; this asserts the query relies on them
    // rather than on a filter the caller could be missing.
    signInAs(outsiderId)
    expect(await listSettleableEvents()).toEqual([])
  })

  it('reports drift once a settled row disagrees with the recomputation', async () => {
    signInAs(adminId)
    const result = await recordPayout({
      eventId: ended.eventId,
      grossPaise: 80_000,
      commissionPaise: 0,
      forfeitedPaise: 30_000,
      status: 'paid',
      utrReference: 'UTR900001',
      notes: null,
    })
    expect(result.ok).toBe(true)

    let rows = await listSettleableEvents()
    let row = rows.find((r) => r.eventId === ended.eventId)!
    expect(row.payout!.status).toBe('paid')
    expect(row.driftPaise).toBe(0)

    // A refund lands after settlement: the recomputation drops by ₹300.
    await db
      .from('bookings')
      .update({ status: 'refunded' })
      .eq('event_id', ended.eventId)
      .eq('status', 'cancelled')

    rows = await listSettleableEvents()
    row = rows.find((r) => r.eventId === ended.eventId)!
    expect(row.statement.netPaise).toBe(50_000)
    // The frozen row still records what left the bank.
    expect(row.payout!.net_paise).toBe(80_000)
    expect(row.driftPaise).toBe(-30_000)
  })
})

describe('recordPayout', () => {
  it('refuses a non-admin with a sentence rather than a raw Postgres error', async () => {
    signInAs(outsiderId)
    const result = await recordPayout({
      eventId: ended.eventId,
      grossPaise: 1_000,
      commissionPaise: 0,
      forfeitedPaise: 0,
      status: 'paid',
      utrReference: 'UTR1',
      notes: null,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/not.*admin/i)
  })

  it('refuses to rewrite a settled payout', async () => {
    signInAs(adminId)
    const result = await recordPayout({
      eventId: ended.eventId,
      grossPaise: 1,
      commissionPaise: 0,
      forfeitedPaise: 0,
      status: 'paid',
      utrReference: 'UTR900002',
      notes: null,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/settled/i)
  })
})

describe('hostPayoutTarget', () => {
  it('gives an admin the destination', async () => {
    signInAs(adminId)
    expect((await hostPayoutTarget(ended.hostId))?.upi_id).toBe('host@upi')
  })

  it('gives a non-admin nothing', async () => {
    signInAs(outsiderId)
    expect(await hostPayoutTarget(ended.hostId)).toBeNull()
  })
})

describe('listHostStatements', () => {
  it('shows the host their own ended events with the same numbers', async () => {
    signInAs(ended.hostProfileId)
    const rows = await listHostStatements()
    const row = rows.find((r) => r.eventId === ended.eventId)
    expect(row).toBeDefined()
    // Recomputed after the refund landed above.
    expect(row!.statement.netPaise).toBe(50_000)
    expect(row!.statement.cashPaise).toBe(25_000)
    expect(row!.payout!.utr_reference).toBe('UTR900001')
  })

  it('shows a host nothing about another host\'s event', async () => {
    signInAs(outsiderId)
    expect(await listHostStatements()).toEqual([])
  })
})
