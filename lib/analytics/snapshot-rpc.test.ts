import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  anonClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  seedPlatformAdmin,
  userClient,
  type SeededEvent,
} from '@/tests/helpers/db'

/**
 * admin_business_snapshot(), called the way the app will — as a signed-in
 * user through PostgREST. Every numeric assertion is SCOPED via p_event_ids
 * to this file's own fixtures: the suite runs files in parallel against one
 * database, so platform-wide totals are moving targets, but our own events'
 * numbers are exact.
 */

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let endedFx: SeededEvent
let liveFx: SeededEvent
let cancelledFx: SeededEvent
const extraUsers: string[] = []

const ticketCode = () => crypto.randomUUID().replace(/-/g, '')

async function scoped(caller: string) {
  return userClient(caller).rpc('admin_business_snapshot', {
    p_event_ids: [endedFx.eventId, liveFx.eventId, cancelledFx.eventId],
  })
}

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)

  endedFx = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  liveFx = await seedEvent(db, { startsAt: new Date(Date.now() + 24 * HOUR).toISOString() })
  // Ended by time AND cancelled: its money still counts (money that moved,
  // moved — the spec's scoping rule), but it is neither live nor ended in
  // the event counts, and its capacity/seats stay out of fill.
  cancelledFx = await seedEvent(db, {
    startsAt: new Date(Date.now() - 30 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 29 * HOUR).toISOString(),
  })
  for (let i = 0; i < 4; i += 1) extraUsers.push(await createTestUser(db))

  // The money story:
  //   b1  endedFx     confirmed online ₹500 captured, ₹50 commission → GMV, online gross, take rate
  //   b2  endedFx     refunded ₹400, processed refund; its payment row is
  //       flipped to 'refunded' below — GMV must still count it (the refunded arm)
  //   b3  endedFx     confirmed cash ₹250, no payment                → cash gross + count
  //   b4  endedFx     waitlisted, no payment                         → waitlist depth
  //   b5  endedFx     refunded ₹100, refund flipped to 'pending'     → in GMV, NOT in refunds returned
  //   b6  liveFx      confirmed online ₹200 captured, one UNSCANNED ticket
  //       → in GMV and fill, but its ticket must stay OUT of tickets_issued
  //         (check-ins are ended-events-only: not a no-show yet)
  //   b7  cancelledFx confirmed online ₹150 captured → in GMV and confirmed
  //       counts (money facts ignore event status), out of everything
  //       event-scoped
  const b1 = await seedCapturedBooking(db, endedFx, { subtotalPaise: 50_000, commissionPaise: 5_000 })
  const b2 = await seedCapturedBooking(db, endedFx, {
    status: 'refunded', refunded: true, subtotalPaise: 40_000, attendeeId: extraUsers[0],
  })
  const b3 = await seedCapturedBooking(db, endedFx, {
    paymentMode: 'cash', captured: false, subtotalPaise: 25_000, attendeeId: extraUsers[1],
  })
  await seedCapturedBooking(db, endedFx, {
    status: 'waitlisted', captured: false, subtotalPaise: 50_000, attendeeId: extraUsers[2],
  })
  const b5 = await seedCapturedBooking(db, endedFx, {
    status: 'refunded', refunded: true, subtotalPaise: 10_000, attendeeId: extraUsers[3],
  })
  const b6 = await seedCapturedBooking(db, liveFx, { subtotalPaise: 20_000 })
  await seedCapturedBooking(db, cancelledFx, { subtotalPaise: 15_000 })
  await db.from('events').update({ status: 'cancelled' }).eq('id', cancelledFx.eventId)

  // Production shapes the fixtures can't write directly:
  await db.from('payments').update({ status: 'refunded' }).eq('id', b2.paymentId!)
  await db.from('refunds').update({ status: 'pending' }).eq('payment_id', b5.paymentId!)

  // Attendance: two tickets on the ended event (one scanned), two on the
  // live event (one scanned) — neither live ticket may count.
  const { data: tickets, error: ticketsError } = await db
    .from('tickets')
    .insert([
      { booking_id: b1.bookingId, code: ticketCode(), checked_in_at: new Date().toISOString() },
      { booking_id: b3.bookingId, code: ticketCode() },
      { booking_id: b6.bookingId, code: ticketCode() },
      { booking_id: b6.bookingId, code: ticketCode(), checked_in_at: new Date().toISOString() },
    ])
    .select('id')
  if (ticketsError || (tickets ?? []).length !== 4) {
    throw new Error(`ticket seed failed: ${ticketsError?.message}`)
  }
})

afterAll(async () => {
  // tickets cascade with their bookings (core_schema.sql:244), so
  // cleanupEvent's booking delete takes them too.
  await cleanupEvent(db, endedFx)
  await cleanupEvent(db, liveFx)
  await cleanupEvent(db, cancelledFx)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
  for (const id of extraUsers) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('admin_business_snapshot', () => {
  it('refuses a signed-in non-admin', async () => {
    const { error } = await scoped(outsiderId)
    expect(error?.code).toBe('EH071')
  })

  it('refuses a truly anonymous caller at the grant, before the gate', async () => {
    const { error } = await anonClient().rpc('admin_business_snapshot')
    expect(error?.code).toBe('42501')
  })

  it('computes every number over the seeded fixtures', async () => {
    const { data, error } = await scoped(adminId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]).toEqual({
      gmv_paise: 135_000,               // 50k + 40k refunded-arm + 10k pending-refund + 20k live + 15k cancelled
      refunds_processed_paise: 40_000,  // b5's pending refund is not returned money
      commission_paise: 5_000,          // proves the sum accumulates when fees turn on
      cash_confirmed_paise: 25_000,
      online_confirmed_paise: 85_000,   // b1 + b6 + b7; b2/b5 are refunded, not confirmed
      cash_confirmed_count: 1,
      confirmed_count: 4,               // b1 + b3 + b6 + b7 (money facts ignore event status)
      events_live: 1,                   // cancelledFx is neither live nor ended
      events_ended: 1,
      capacity_seats: 20,               // endedFx + liveFx; cancelledFx is not published
      confirmed_seats: 3,               // b1 + b3 + b6, quantity 1 each; b7's event unpublished
      tickets_issued: 2,                // b6's live-event ticket is not a no-show candidate
      tickets_checked_in: 1,
      waitlisted_count: 1,
    })
  })

  it('answers the whole platform when unscoped — at least what our fixtures put in', async () => {
    const { data, error } = await userClient(adminId).rpc('admin_business_snapshot')
    expect(error).toBeNull()
    const platform = data![0]
    // Monotone smoke only: other test files write to the same database in
    // parallel, so equality would flake. The exact math is pinned above.
    expect(platform.gmv_paise).toBeGreaterThanOrEqual(135_000)
    expect(platform.waitlisted_count).toBeGreaterThanOrEqual(1)
    expect(platform.events_ended).toBeGreaterThanOrEqual(1)
  })
})
