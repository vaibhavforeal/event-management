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
const { isPlatformAdmin, listSettleableEvents, listHostStatements, hostPayoutTarget, bookingRowsFor } =
  await import('@/lib/payouts/queries')
const { recordPayout } = await import('@/lib/payouts/service')

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let ended: SeededEvent
let ended2: SeededEvent
let ongoing: SeededEvent
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
  // Ongoing event (started but not ended) to test hasEnded filter
  ongoing = await seedEvent(db, {
    startsAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    endsAt: new Date(Date.now() + 22 * HOUR).toISOString(),
  })
  future = await seedEvent(db, { startsAt: new Date(Date.now() + 24 * HOUR).toISOString() })

  for (let i = 0; i < 6; i += 1) extraAttendees.push(await createTestUser(db))

  // ₹500 confirmed, ₹300 forfeited, ₹400 refunded, ₹250 cash, ₹150 uncaptured.
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
  // Uncaptured online booking - payment exists but not captured, so contributes nothing
  await seedCapturedBooking(db, ended, {
    status: 'confirmed', paymentMode: 'online', captured: false, subtotalPaise: 15_000, attendeeId: extraAttendees[3],
  })

  // Second event with one booking to ensure grouping works
  await seedCapturedBooking(db, ended2, { subtotalPaise: 100_000, attendeeId: extraAttendees[4] })

  // Ongoing event with one booking - should not be settleable
  await seedCapturedBooking(db, ongoing, { subtotalPaise: 75_000, attendeeId: extraAttendees[5] })

  await db.from('hosts').update({ upi_id: 'host@upi' }).eq('id', ended.hostId)
})

afterAll(async () => {
  signInAs(null)
  await cleanupEvent(db, ended)
  await cleanupEvent(db, ended2)
  await cleanupEvent(db, ongoing)
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
    expect(rows.map((r) => r.eventId)).not.toContain(ongoing.eventId)
  })

  it('returns nothing to a signed-in non-admin', async () => {
    // The gate (is_platform_admin RPC) refuses a non-admin, answered by the
    // database. The money rows underneath (bookings/payments/payouts) are
    // RLS-guarded regardless — a non-admin can't read them even if they
    // somehow bypassed the gate.
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
    // Check for the exact mapped sentence, not just keywords that appear in raw Postgres message
    expect(result.ok === false && result.error).toBe('You are not a platform admin.')
  })

  it('refuses to rewrite a settled payout', async () => {
    // This test depends on the "reports drift" test having run first to create the payout
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
    // Check for mapped sentence's actionable part that doesn't appear in raw Postgres
    expect(result.ok === false && result.error).toContain('record the correction in the notes')
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

  it('leaves out ongoing events for the host', async () => {
    signInAs(ongoing.hostProfileId)
    const rows = await listHostStatements()
    expect(rows.map((r) => r.eventId)).not.toContain(ongoing.eventId)
  })

  it('shows a host nothing about another host\'s event', async () => {
    signInAs(outsiderId)
    expect(await listHostStatements()).toEqual([])
  })
})

describe('bookingRowsFor fail-closed error handling', () => {
  // Unit-test the error throws without the session mock — bookingRowsFor
  // takes the client as a parameter, so we can stub it directly.
  function stubClient(failTable: 'bookings' | 'payments' | 'refunds') {
    return {
      from: (table: string) => ({
        select: () => ({
          in: () => {
            if (table === failTable) {
              return Promise.resolve({
                data: null,
                error: { message: 'simulated database failure', code: '42P01' },
              })
            }
            // Minimal valid responses for the other tables
            if (table === 'bookings') {
              return Promise.resolve({
                data: [{ id: 'b1', event_id: 'e1', status: 'confirmed', payment_mode: 'online', subtotal_paise: 100, commission_paise: 0 }],
                error: null,
              })
            }
            if (table === 'payments') {
              return Promise.resolve({ data: [{ id: 'p1', booking_id: 'b1', status: 'captured' }], error: null })
            }
            if (table === 'refunds') {
              return Promise.resolve({ data: [], error: null })
            }
            return Promise.resolve({ data: [], error: null })
          },
        }),
      }),
    } as unknown as Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>
  }

  it('throws on a bookings query error', async () => {
    await expect(bookingRowsFor(stubClient('bookings'), ['e1'])).rejects.toThrow(/Failed to read bookings/)
  })

  it('throws on a payments query error', async () => {
    await expect(bookingRowsFor(stubClient('payments'), ['e1'])).rejects.toThrow(/Failed to read payments/)
  })

  it('throws on a refunds query error rather than silently understating', async () => {
    await expect(bookingRowsFor(stubClient('refunds'), ['e1'])).rejects.toThrow(/Failed to read refunds/)
  })
})

