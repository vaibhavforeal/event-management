import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { fakeProvider } from '@/tests/helpers/payments'
import type { Caller } from '@/lib/bookings/caller'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider, RazorpayConfigError } = vi.mocked(await import('@/lib/payments/razorpay'))
const { startPaidCheckout } = await import('@/lib/payments/service')

const db = adminClient()
let paid: SeededEvent
const callerOf = (id: string) => ({ id }) as Caller // match concurrency.test.ts's mechanism

beforeAll(async () => {
  paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
})
afterAll(async () => {
  // The payments row the happy-path test records must go first, and explicitly:
  // payments.booking_id is ON DELETE RESTRICT, so it silently blocks
  // cleanupEvent's bookings delete — and (provider, provider_order_id) is
  // unique, so a surviving 'order_test_1' row fails the next run's insert.
  const { data: bookings } = await db.from('bookings').select('id').eq('event_id', paid.eventId)
  await db
    .from('payments')
    .delete()
    .in(
      'booking_id',
      (bookings ?? []).map((b) => b.id),
    )
  await cleanupEvent(db, paid)
})

describe('startPaidCheckout', () => {
  it('holds seats, creates the order, records the payments row', async () => {
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)

    const result = await startPaidCheckout(callerOf(paid.attendeeId), paid.ticketTypeId, 2, 'Asha')

    expect(result).toEqual({ ok: true, reference: expect.stringMatching(/^[0-9A-HJ-NP-TV-Z]{8}$/) })
    expect(provider.createOrder).toHaveBeenCalledWith({
      amountPaise: 100_000,
      receipt: (result as { reference: string }).reference,
      notes: { booking_reference: (result as { reference: string }).reference },
    })
    const { data: booking } = await db
      .from('bookings')
      .select('id, status, payments(provider_order_id, status, amount_paise)')
      .eq('reference', (result as { reference: string }).reference)
      .single()
    expect(booking!.status).toBe('awaiting_payment')
    expect(booking!.payments).toEqual([
      { provider_order_id: 'order_test_1', status: 'created', amount_paise: 100_000 },
    ])
    await db.rpc('cancel_booking', { p_booking_id: booking!.id, p_reason: 'test cleanup' })
  })

  it('cancels the hold when order creation fails, and says one sentence', async () => {
    razorpayProvider.mockReturnValue(
      fakeProvider({ createOrder: vi.fn(async () => { throw new Error('razorpay down') }) }),
    )

    const result = await startPaidCheckout(callerOf(paid.attendeeId), paid.ticketTypeId, 1, 'Asha')

    expect(result).toEqual({
      ok: false,
      error: 'Could not start the payment. Nothing was charged — please try again.',
    })
    const { data: bookings } = await db
      .from('bookings')
      .select('status')
      .eq('event_id', paid.eventId)
      .eq('attendee_id', paid.attendeeId)
      .order('created_at', { ascending: false })
      .limit(1)
    expect(bookings![0]!.status).toBe('cancelled') // the hold did not outlive the failure
  })

  it('fails loudly, before any write, when Razorpay is not configured', async () => {
    razorpayProvider.mockImplementation(() => {
      throw new RazorpayConfigError()
    })
    const before = await db.from('bookings').select('*', { count: 'exact', head: true }).eq('event_id', paid.eventId)

    const result = await startPaidCheckout(callerOf(paid.attendeeId), paid.ticketTypeId, 1, 'Asha')

    expect(result).toEqual({ ok: false, error: 'Payments are not set up on this server yet.' })
    const after = await db.from('bookings').select('*', { count: 'exact', head: true }).eq('event_id', paid.eventId)
    expect(after.count).toBe(before.count)
  })

  it('maps a free ticket type to the EH030 sentence', async () => {
    razorpayProvider.mockReturnValue(fakeProvider())
    const free = await seedEvent(db, { quantity: 5, pricePaise: 0, status: 'published' })
    try {
      const result = await startPaidCheckout(callerOf(free.attendeeId), free.ticketTypeId, 1, 'Asha')
      expect(result).toEqual({ ok: false, error: 'This event is free — book it without paying.' })
    } finally {
      await cleanupEvent(db, free)
    }
  })
})
