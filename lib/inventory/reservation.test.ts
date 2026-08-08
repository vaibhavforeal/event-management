import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  cleanupEvent,
  seedEvent,
  type SeededEvent,
} from '@/tests/helpers/db'

/**
 * Integration tests for inventory. These hit the local Supabase stack; start it
 * with `npm run db:start` before running.
 *
 * The oversell test is the reason this file exists. Selling seat 11 of 10 is
 * the failure that costs a host their reputation at the door, and it is only
 * reproducible under real concurrency — so it runs against real Postgres.
 */

const db: SupabaseClient = adminClient()
let seed: SeededEvent

async function reserve(seed: SeededEvent, quantity = 1, overrides: Record<string, unknown> = {}) {
  return db.rpc('reserve_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: quantity,
    p_convenience_fee_paise: 0,
    p_commission_paise: 0,
    ...overrides,
  })
}

async function reservedCount(ticketTypeId: string): Promise<number> {
  const { data, error } = await db
    .from('ticket_types')
    .select('reserved_count')
    .eq('id', ticketTypeId)
    .single()
  if (error) throw error
  return data.reserved_count
}

describe('reserve_tickets', () => {
  beforeEach(async () => {
    seed = await seedEvent(db, { quantity: 10 })
  })

  afterEach(async () => {
    await cleanupEvent(db, seed)
  })

  it('holds inventory and prices the booking from the stored ticket price', async () => {
    const { data, error } = await reserve(seed, 2, { p_convenience_fee_paise: 2500 })

    expect(error).toBeNull()
    expect(data.status).toBe('awaiting_payment')
    expect(data.quantity).toBe(2)
    expect(data.subtotal_paise).toBe(100_000) // 2 × ₹500, computed server-side
    expect(data.convenience_fee_paise).toBe(2_500)
    expect(data.total_paise).toBe(102_500)
    expect(data.hold_expires_at).not.toBeNull()
    expect(data.reference).toMatch(/^[0-9A-HJ-NP-TV-Z]{8}$/)

    expect(await reservedCount(seed.ticketTypeId)).toBe(2)
  })

  it('refuses to sell more than remain', async () => {
    await reserve(seed, 10)
    const { error } = await reserve(seed, 1)

    expect(error).not.toBeNull()
    expect(error!.message).toContain('0 seats remain')
    expect(await reservedCount(seed.ticketTypeId)).toBe(10)
  })

  it('enforces max_per_order', async () => {
    const small = await seedEvent(db, { quantity: 50, maxPerOrder: 4 })
    try {
      const { error } = await db.rpc('reserve_tickets', {
        p_ticket_type_id: small.ticketTypeId,
        p_attendee_id: small.attendeeId,
        p_quantity: 5,
      })
      expect(error).not.toBeNull()
      expect(error!.message).toContain('more than 4')
    } finally {
      await cleanupEvent(db, small)
    }
  })

  it('refuses bookings on an unpublished event', async () => {
    const draft = await seedEvent(db, { status: 'draft' })
    try {
      const { error } = await db.rpc('reserve_tickets', {
        p_ticket_type_id: draft.ticketTypeId,
        p_attendee_id: draft.attendeeId,
        p_quantity: 1,
      })
      expect(error).not.toBeNull()
      expect(error!.message).toContain('not open for booking')
    } finally {
      await cleanupEvent(db, draft)
    }
  })

  it('refuses cash when the event has not opted in', async () => {
    const { error } = await reserve(seed, 1, { p_payment_mode: 'cash' })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('does not accept cash')
  })

  it('allows cash when the event has opted in', async () => {
    const cashEvent = await seedEvent(db, { allowsCash: true })
    try {
      const { data, error } = await db.rpc('reserve_tickets', {
        p_ticket_type_id: cashEvent.ticketTypeId,
        p_attendee_id: cashEvent.attendeeId,
        p_quantity: 1,
        p_commission_paise: 5000,
        p_payment_mode: 'cash',
      })
      expect(error).toBeNull()
      expect(data.payment_mode).toBe('cash')
      // Commission is forced to zero on cash regardless of what was passed:
      // we never touch the money, so we cannot bill for it.
      expect(data.commission_paise).toBe(0)
    } finally {
      await cleanupEvent(db, cashEvent)
    }
  })

  /**
   * The one that matters. 50 buyers, 10 seats, all at once.
   */
  it('never oversells under concurrency', async () => {
    const CONTENDERS = 50
    const SEATS = 10

    const results = await Promise.all(
      Array.from({ length: CONTENDERS }, () => reserve(seed, 1)),
    )

    const succeeded = results.filter((r) => r.error === null)
    const failed = results.filter((r) => r.error !== null)

    expect(succeeded).toHaveLength(SEATS)
    expect(failed).toHaveLength(CONTENDERS - SEATS)

    // Every rejection must be an out-of-stock rejection, not a crash or a
    // deadlock. If this ever trips, the lock ordering has regressed.
    for (const f of failed) {
      expect(f.error!.message).toMatch(/seats remain/)
    }

    expect(await reservedCount(seed.ticketTypeId)).toBe(SEATS)

    const { count } = await db
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('ticket_type_id', seed.ticketTypeId)
      .eq('status', 'awaiting_payment')

    expect(count).toBe(SEATS)

    // Every successful buyer got a distinct booking reference.
    const references = succeeded.map((r) => r.data.reference)
    expect(new Set(references).size).toBe(SEATS)
  }, 60_000)

  it('cannot be driven past capacity by concurrent multi-seat orders', async () => {
    const big = await seedEvent(db, { quantity: 12, maxPerOrder: 5 })
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          db.rpc('reserve_tickets', {
            p_ticket_type_id: big.ticketTypeId,
            p_attendee_id: big.attendeeId,
            p_quantity: 5,
          }),
        ),
      )
      const seatsSold = results
        .filter((r) => r.error === null)
        .reduce((sum, r) => sum + r.data.quantity, 0)

      // 5 does not divide 12, so at most 2 orders can land.
      expect(seatsSold).toBeLessThanOrEqual(12)
      expect(seatsSold).toBe(10)
      expect(await reservedCount(big.ticketTypeId)).toBe(seatsSold)
    } finally {
      await cleanupEvent(db, big)
    }
  }, 60_000)
})

describe('hold expiry', () => {
  beforeEach(async () => {
    seed = await seedEvent(db, { quantity: 5 })
  })

  afterEach(async () => {
    await cleanupEvent(db, seed)
  })

  it('returns inventory once a hold lapses', async () => {
    const { data: booking } = await reserve(seed, 5)
    expect(await reservedCount(seed.ticketTypeId)).toBe(5)

    // Backdate the hold rather than sleeping.
    await db
      .from('bookings')
      .update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', booking.id)

    const { data: released, error } = await db.rpc('release_expired_holds', {
      p_ticket_type_id: seed.ticketTypeId,
    })
    expect(error).toBeNull()
    expect(released).toBe(1)
    expect(await reservedCount(seed.ticketTypeId)).toBe(0)

    const { data: after } = await db
      .from('bookings')
      .select('status')
      .eq('id', booking.id)
      .single()
    expect(after!.status).toBe('expired')
  })

  it('reclaims lapsed holds automatically when a new buyer arrives', async () => {
    const { data: booking } = await reserve(seed, 5)
    await db
      .from('bookings')
      .update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', booking.id)

    // Sold out on paper, but the hold is stale — this buyer should still get in.
    const { data, error } = await reserve(seed, 1)
    expect(error).toBeNull()
    expect(data.status).toBe('awaiting_payment')
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
  })
})

describe('confirm and cancel', () => {
  beforeEach(async () => {
    seed = await seedEvent(db, { quantity: 10 })
  })

  afterEach(async () => {
    await cleanupEvent(db, seed)
  })

  it('issues one ticket per seat on confirmation', async () => {
    const { data: booking } = await reserve(seed, 3)
    const { data: confirmed, error } = await db.rpc('confirm_booking', {
      p_booking_id: booking.id,
    })

    expect(error).toBeNull()
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.hold_expires_at).toBeNull()

    const { data: tickets } = await db
      .from('tickets')
      .select('code')
      .eq('booking_id', booking.id)

    expect(tickets).toHaveLength(3)
    expect(new Set(tickets!.map((t) => t.code)).size).toBe(3)
    for (const t of tickets!) {
      expect(t.code).toMatch(/^[0-9a-f]{32}$/) // 128 bits
    }
  })

  it('is idempotent, because payment webhooks get redelivered', async () => {
    const { data: booking } = await reserve(seed, 2)

    await db.rpc('confirm_booking', { p_booking_id: booking.id })
    const { error } = await db.rpc('confirm_booking', { p_booking_id: booking.id })
    expect(error).toBeNull()

    const { count } = await db
      .from('tickets')
      .select('*', { count: 'exact', head: true })
      .eq('booking_id', booking.id)

    // Two seats, two tickets — not four.
    expect(count).toBe(2)
  })

  it('returns inventory when a confirmed booking is cancelled', async () => {
    const { data: booking } = await reserve(seed, 4)
    await db.rpc('confirm_booking', { p_booking_id: booking.id })
    expect(await reservedCount(seed.ticketTypeId)).toBe(4)

    const { data: cancelled, error } = await db.rpc('cancel_booking', {
      p_booking_id: booking.id,
      p_reason: 'attendee changed plans',
    })

    expect(error).toBeNull()
    expect(cancelled.status).toBe('cancelled')
    expect(await reservedCount(seed.ticketTypeId)).toBe(0)

    const { count } = await db
      .from('tickets')
      .select('*', { count: 'exact', head: true })
      .eq('booking_id', booking.id)
    expect(count).toBe(0)
  })

  it('does not double-release when cancelled twice', async () => {
    const { data: booking } = await reserve(seed, 3)
    await db.rpc('cancel_booking', { p_booking_id: booking.id })
    await db.rpc('cancel_booking', { p_booking_id: booking.id })

    expect(await reservedCount(seed.ticketTypeId)).toBe(0)
  })
})

describe('approval flow', () => {
  it('does not consume inventory until the host approves', async () => {
    const curated = await seedEvent(db, { quantity: 2, requiresApproval: true })
    try {
      // Three people request two seats. All requests are accepted; that is the
      // point of curation.
      const requests = await Promise.all(
        Array.from({ length: 3 }, () =>
          db.rpc('request_booking', {
            p_ticket_type_id: curated.ticketTypeId,
            p_attendee_id: curated.attendeeId,
            p_quantity: 1,
          }),
        ),
      )
      expect(requests.every((r) => r.error === null)).toBe(true)
      expect(await reservedCount(curated.ticketTypeId)).toBe(0)

      // Approving takes inventory.
      const { data: approved, error } = await db.rpc('approve_booking', {
        p_booking_id: requests[0].data.id,
        p_convenience_fee_paise: 2500,
        p_commission_paise: 5000,
      })
      expect(error).toBeNull()
      expect(approved.status).toBe('awaiting_payment')
      expect(approved.subtotal_paise).toBe(50_000) // priced at approval time
      expect(approved.total_paise).toBe(52_500)
      expect(await reservedCount(curated.ticketTypeId)).toBe(1)

      await db.rpc('approve_booking', { p_booking_id: requests[1].data.id })
      expect(await reservedCount(curated.ticketTypeId)).toBe(2)

      // The third approval must fail rather than oversell.
      const { error: overError } = await db.rpc('approve_booking', {
        p_booking_id: requests[2].data.id,
      })
      expect(overError).not.toBeNull()
      expect(overError!.message).toContain('cannot approve')
    } finally {
      await cleanupEvent(db, curated)
    }
  })

  it('skips payment for a free approved event', async () => {
    const free = await seedEvent(db, {
      quantity: 5,
      pricePaise: 0,
      requiresApproval: true,
    })
    try {
      const { data: request } = await db.rpc('request_booking', {
        p_ticket_type_id: free.ticketTypeId,
        p_attendee_id: free.attendeeId,
        p_quantity: 1,
      })
      const { data: approved } = await db.rpc('approve_booking', {
        p_booking_id: request.id,
      })

      expect(approved.status).toBe('confirmed')

      const { count } = await db
        .from('tickets')
        .select('*', { count: 'exact', head: true })
        .eq('booking_id', request.id)
      expect(count).toBe(1)
    } finally {
      await cleanupEvent(db, free)
    }
  })
})
