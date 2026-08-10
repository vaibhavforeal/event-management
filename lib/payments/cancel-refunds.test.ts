import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { capturedEvent, fakeProvider, seedPaidBooking } from '@/tests/helpers/payments'
import type { Caller } from '@/lib/bookings/caller'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider } = vi.mocked(await import('@/lib/payments/razorpay'))
const { processWebhookEvent } = await import('@/lib/payments/service')
const { cancelBooking } = await import('@/lib/bookings/service')

const db = adminClient()
const callerOf = (id: string) => ({ id }) as Caller // match concurrency.test.ts's mechanism

// provider_payment_id and provider_refund_id are UNIQUE across the whole table
// and the fixtures reuse 'pay_test_1' / 'rfnd_test_1', so every case tears its
// own money rows down before the next one writes the same ids. The receipts it
// wrote go too — their event ids are per-run-unique, but rows that outlive the
// run are clutter the next debugging session has to read around.
const receipts: string[] = []

beforeEach(() => {
  razorpayProvider.mockReturnValue(fakeProvider())
})

afterEach(async () => {
  const eventIds = receipts.splice(0)
  if (eventIds.length > 0) {
    await db.from('provider_webhook_events').delete().eq('provider', 'razorpay').in('provider_event_id', eventIds)
  }
})

/**
 * refunds → payments → cleanupEvent, in that order: payments.booking_id is
 * ON DELETE RESTRICT, so cleanupEvent's bookings delete silently fails while a
 * payments row still points at it — the webhook-processor suite's pattern.
 */
async function cleanupSeed(seed: SeededEvent): Promise<void> {
  const { data: bookings } = await db.from('bookings').select('id').eq('event_id', seed.eventId)
  const bookingIds = (bookings ?? []).map((b) => b.id)
  if (bookingIds.length > 0) {
    const { data: payments } = await db.from('payments').select('id').in('booking_id', bookingIds)
    const paymentIds = (payments ?? []).map((p) => p.id)
    if (paymentIds.length > 0) {
      await db.from('refunds').delete().in('payment_id', paymentIds)
      await db.from('payments').delete().in('id', paymentIds)
    }
  }
  await cleanupEvent(db, seed)
}

/** A paid, captured, confirmed booking on an event that starts `hoursOut` from now. */
async function confirmedPaidBooking(hoursOut: number, cutoffHours = 24) {
  const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
  await db
    .from('events')
    .update({
      starts_at: new Date(Date.now() + hoursOut * 3600_000).toISOString(),
      refund_cutoff_hours: cutoffHours,
    })
    .eq('id', seed.eventId)
  const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
  const fixture = capturedEvent({ orderId, amountPaise: booking.total_paise })
  receipts.push(fixture.eventId)
  await processWebhookEvent({ providerEventId: fixture.eventId, eventType: fixture.eventType, payload: fixture.payload })
  return { seed, booking }
}

async function endState(bookingId: string) {
  const { data } = await db
    .from('bookings')
    .select('status, payments(id, refunds(status, provider_refund_id, amount_paise))')
    .eq('id', bookingId)
    .single()
  return { status: data!.status, refunds: data!.payments[0]?.refunds ?? [] }
}

describe('the cancel matrix', () => {
  it('attendee inside the cutoff: refunded, one refund row, provider called once', async () => {
    const { seed, booking } = await confirmedPaidBooking(48, 24)
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)
    try {
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('refunded')
      expect(after.refunds).toEqual([
        { status: 'pending', provider_refund_id: 'rfnd_test_1', amount_paise: booking.total_paise },
      ])
      expect(provider.createRefund).toHaveBeenCalledTimes(1)
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('attendee past the cutoff: cancelled, seat freed, no money moves', async () => {
    const { seed, booking } = await confirmedPaidBooking(2, 24)
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)
    try {
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('cancelled')
      expect(after.refunds).toEqual([])
      expect(provider.createRefund).not.toHaveBeenCalled()
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('host removal past the cutoff: still a full refund', async () => {
    const { seed, booking } = await confirmedPaidBooking(2, 24)
    try {
      const result = await cancelBooking(callerOf(seed.hostProfileId), booking.id, 'host')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('refunded')
      expect(after.refunds).toHaveLength(1)
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('cancelling twice creates at most one refund', async () => {
    const { seed, booking } = await confirmedPaidBooking(48, 24)
    try {
      await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      const again = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(again).toEqual({ ok: true }) // cancel_booking is idempotent
      const after = await endState(booking.id)
      expect(after.refunds).toHaveLength(1)
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('a free booking cancels with no refund machinery', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    try {
      const { data: booking } = await db.rpc('book_free_tickets', {
        p_ticket_type_id: seed.ticketTypeId,
        p_attendee_id: seed.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
        p_attendee_note: null,
      })
      const result = await cancelBooking(callerOf(seed.attendeeId), booking!.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const { count } = await db.from('refunds').select('*', { count: 'exact', head: true })
      const after = await endState(booking!.id)
      expect(after.status).toBe('cancelled')
      expect(after.refunds).toEqual([])
      void count
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('an uncaptured (awaiting_payment) cancel releases the hold, no refund', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('cancelled')
      expect(after.refunds).toEqual([])
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('a failed provider call leaves the row pending for the sweep, booking still refunded', async () => {
    const { seed, booking } = await confirmedPaidBooking(48, 24)
    razorpayProvider.mockReturnValue(
      fakeProvider({ createRefund: vi.fn(async () => { throw new Error('razorpay down') }) }),
    )
    try {
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true }) // the seat decision does not wait on Razorpay
      const after = await endState(booking.id)
      expect(after.status).toBe('refunded')
      expect(after.refunds).toEqual([
        { status: 'pending', provider_refund_id: null, amount_paise: booking.total_paise },
      ])
    } finally {
      await cleanupSeed(seed)
    }
  })
})
