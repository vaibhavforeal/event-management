import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { capturedEvent, failedEvent, fakeProvider, refundEvent, seedPaidBooking } from '@/tests/helpers/payments'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider } = vi.mocked(await import('@/lib/payments/razorpay'))
const { processWebhookEvent } = await import('@/lib/payments/service')

const db = adminClient()
let paid: SeededEvent

// provider_payment_id and provider_refund_id are UNIQUE across the whole
// table, and the fixtures deliberately reuse 'pay_test_1' / 'rfnd_test_1' the
// way Razorpay would replay one payment — so each test's rows must be gone
// before the next test writes the same ids. Deletion order matters:
// refunds → payments (booking_id is ON DELETE RESTRICT) → bookings → buyers.
const buyers: string[] = []
const receipts: string[] = []

beforeAll(async () => {
  paid = await seedEvent(db, { quantity: 50, pricePaise: 50_000, status: 'published' })
})
afterEach(async () => {
  const { data: bookings } = await db.from('bookings').select('id').eq('event_id', paid.eventId)
  const bookingIds = (bookings ?? []).map((b) => b.id)
  if (bookingIds.length > 0) {
    const { data: payments } = await db.from('payments').select('id').in('booking_id', bookingIds)
    const paymentIds = (payments ?? []).map((p) => p.id)
    if (paymentIds.length > 0) {
      await db.from('refunds').delete().in('payment_id', paymentIds)
      await db.from('payments').delete().in('id', paymentIds)
    }
    await db.from('bookings').delete().in('id', bookingIds)
  }
  for (const userId of buyers.splice(0)) {
    await db.auth.admin.deleteUser(userId).catch(() => {})
  }
  const eventIds = receipts.splice(0)
  if (eventIds.length > 0) {
    await db.from('provider_webhook_events').delete().eq('provider', 'razorpay').in('provider_event_id', eventIds)
  }
})
afterAll(async () => {
  await cleanupEvent(db, paid)
})
beforeEach(() => {
  razorpayProvider.mockReturnValue(fakeProvider())
})

async function freshPaidBooking(quantity = 2) {
  const buyerId = await createTestUser(db)
  buyers.push(buyerId)
  return seedPaidBooking(db, paid, { quantity, attendeeId: buyerId })
}

async function apply(fixture: { eventId: string; eventType: string; payload: unknown }) {
  receipts.push(fixture.eventId)
  return processWebhookEvent({ providerEventId: fixture.eventId, eventType: fixture.eventType, payload: fixture.payload })
}

describe('payment.captured', () => {
  it('records the capture and confirms: same tickets as the free path', async () => {
    const { booking, orderId } = await freshPaidBooking(2)

    const outcome = await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    expect(outcome).toBe('processed')
    const { data: after } = await db.from('bookings').select('status, payments(status, provider_payment_id)').eq('id', booking.id).single()
    expect(after!.status).toBe('confirmed')
    expect(after!.payments[0]).toMatchObject({ status: 'captured', provider_payment_id: 'pay_test_1' })
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(2)
  })

  it('the same event id twice: one duplicate, one set of tickets', async () => {
    const { booking, orderId } = await freshPaidBooking(2)
    const fixture = capturedEvent({ orderId, amountPaise: booking.total_paise })

    expect(await apply(fixture)).toBe('processed')
    expect(await apply(fixture)).toBe('duplicate')
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(2)
  })

  it('the same capture under a NEW event id (redelivery): still one set of tickets', async () => {
    const { booking, orderId } = await freshPaidBooking(2)

    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))
    const again = await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    expect(again).toBe('processed') // fresh receipt, no-op application
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(2)
  })

  it('capture after the hold expired: auto-refund, nobody admitted', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)

    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    const { data: after } = await db
      .from('bookings')
      .select('status, payments(id, status, refunds(status, amount_paise, provider_refund_id))')
      .eq('id', booking.id)
      .single()
    expect(after!.status).toBe('expired')
    expect(provider.createRefund).toHaveBeenCalledTimes(1)
    expect(after!.payments[0]!.refunds).toEqual([
      { status: 'pending', amount_paise: booking.total_paise, provider_refund_id: 'rfnd_test_1' },
    ])
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(0)
  })

  it('the same capture racing itself under two fresh event ids: one refund, one provider call', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)

    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)
    // Two independent deliveries of the same capture — fresh event ids, so
    // both pass the receipt dedup and both reach ensureRefund. The
    // refunds_one_per_payment index is what keeps the money from moving twice.
    const outcomes = await Promise.all([
      apply(capturedEvent({ orderId, amountPaise: booking.total_paise })),
      apply(capturedEvent({ orderId, amountPaise: booking.total_paise })),
    ])

    expect(outcomes).toEqual(['processed', 'processed'])
    const paymentId = await paymentIdFor(booking.id)
    const { data: refunds } = await db.from('refunds').select('id').eq('payment_id', paymentId!)
    expect(refunds).toHaveLength(1)
    expect(provider.createRefund).toHaveBeenCalledTimes(1)
  })

  it('capture after a cancel: auto-refund, booking stays cancelled', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'changed my mind' })

    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
    expect(after!.status).toBe('cancelled')
    const { data: refunds } = await db.from('refunds').select('status').eq('payment_id', (await paymentIdFor(booking.id))!)
    expect(refunds).toHaveLength(1)
  })

  it('an amount mismatch records, stamps, and admits nobody', async () => {
    const { booking, orderId } = await freshPaidBooking(2)

    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise - 1 }))

    const { data: after } = await db
      .from('bookings')
      .select('status, payments(status, error_code, error_description)')
      .eq('id', booking.id)
      .single()
    expect(after!.status).toBe('awaiting_payment') // untouched; the sweep and a human decide
    expect(after!.payments[0]).toMatchObject({ status: 'captured', error_code: 'amount_mismatch' })
    expect(after!.payments[0]!.error_description).toMatch(/captured 99999 paise against a booking of 100000/)
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(0)
  })
})

describe('payment.failed', () => {
  it("records the failure on the order's row", async () => {
    const { booking, orderId } = await freshPaidBooking(1)

    await apply(failedEvent({ orderId, errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'UPI timed out' }))

    const { data: payment } = await db.from('payments').select('status, error_code, error_description').eq('booking_id', booking.id).single()
    expect(payment).toEqual({ status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'UPI timed out' })
  })

  it('a failed arriving after the capture does not regress the row', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    await apply(failedEvent({ orderId, paymentId: 'pay_test_stale' }))

    const { data: payment } = await db.from('payments').select('status, provider_payment_id').eq('booking_id', booking.id).single()
    expect(payment).toEqual({ status: 'captured', provider_payment_id: 'pay_test_1' })
    const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
    expect(after!.status).toBe('confirmed')
  })
})

describe('refund events', () => {
  it('refund.processed settles the row and marks the payment refunded', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise })) // creates the pending refund rfnd_test_1

    await apply(refundEvent('processed', { refundId: 'rfnd_test_1', paymentId: 'pay_test_1', amountPaise: booking.total_paise }))

    const paymentId = await paymentIdFor(booking.id)
    const { data: refund } = await db.from('refunds').select('status').eq('payment_id', paymentId!).single()
    expect(refund!.status).toBe('processed')
    const { data: payment } = await db.from('payments').select('status').eq('id', paymentId!).single()
    expect(payment!.status).toBe('refunded')
  })

  it('a refund arriving under an unknown id claims the stuck pending row', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
    // The provider is down when the auto-refund fires: the row stays pending
    // with no provider_refund_id — the stuck shape the sweep exists for.
    razorpayProvider.mockReturnValue(
      fakeProvider({ createRefund: vi.fn(async () => { throw new Error('razorpay down') }) }),
    )
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))
    const paymentId = await paymentIdFor(booking.id)
    const { data: stuck } = await db.from('refunds').select('id, provider_refund_id, status').eq('payment_id', paymentId!).single()
    expect(stuck).toMatchObject({ provider_refund_id: null, status: 'pending' })

    // Someone refunds from the Razorpay dashboard: the webhook names a refund
    // id we never stored, against a payment that already owns a pending row.
    await apply(refundEvent('processed', { refundId: 'rfnd_claimed_1', paymentId: 'pay_test_1', amountPaise: booking.total_paise }))

    const { data: refunds } = await db.from('refunds').select('id, provider_refund_id, status').eq('payment_id', paymentId!)
    expect(refunds).toEqual([{ id: stuck!.id, provider_refund_id: 'rfnd_claimed_1', status: 'processed' }])
    const { data: payment } = await db.from('payments').select('status').eq('id', paymentId!).single()
    expect(payment!.status).toBe('refunded')
  })

  it('refund.failed marks the row failed so a human looks', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    await apply(refundEvent('failed', { refundId: 'rfnd_test_1', paymentId: 'pay_test_1', amountPaise: booking.total_paise }))

    const paymentId = await paymentIdFor(booking.id)
    const { data: refund } = await db.from('refunds').select('status').eq('payment_id', paymentId!).single()
    expect(refund!.status).toBe('failed')
  })
})

describe('bookkeeping', () => {
  it('an unknown event type is recorded and marked processed', async () => {
    const eventId = `evt_unknown_${Date.now()}`
    receipts.push(eventId)
    const outcome = await processWebhookEvent({
      providerEventId: eventId,
      eventType: 'invoice.paid',
      payload: { event: 'invoice.paid' },
    })
    expect(outcome).toBe('processed')
  })

  it('a processing failure stamps the receipt and throws', async () => {
    const fixture = capturedEvent({ orderId: 'order_never_created', amountPaise: 1 })

    await expect(apply(fixture)).rejects.toThrow(/no payments row/)
    const { data: receipt } = await db
      .from('provider_webhook_events')
      .select('processed_at, error')
      .eq('provider_event_id', fixture.eventId)
      .single()
    expect(receipt!.processed_at).toBeNull()
    expect(receipt!.error).toMatch(/no payments row/)
  })

  it('a redelivery of the SAME event id reprocesses a half-done event', async () => {
    const { booking, orderId } = await freshPaidBooking(2)
    // The order exists at Razorpay but our payments row does not (the insert
    // landing late): the first delivery fails and stamps the receipt.
    await db.from('payments').delete().eq('booking_id', booking.id)
    const fixture = capturedEvent({ orderId, amountPaise: booking.total_paise })

    await expect(apply(fixture)).rejects.toThrow(/no payments row/)

    // The row appears; Razorpay redelivers under the SAME event id. The
    // receipt exists but never earned a processed_at — so this is not a
    // duplicate, it is the retry the 500 asked for.
    await db.from('payments').insert({
      booking_id: booking.id,
      provider: 'razorpay',
      provider_order_id: orderId,
      amount_paise: booking.total_paise,
      status: 'created',
    })
    const outcome = await apply(fixture)

    expect(outcome).toBe('processed')
    const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
    expect(after!.status).toBe('confirmed')
    const { data: receipt } = await db
      .from('provider_webhook_events')
      .select('processed_at, error')
      .eq('provider_event_id', fixture.eventId)
      .single()
    expect(receipt!.processed_at).not.toBeNull()
    expect(receipt!.error).toBeNull()
  })
})

async function paymentIdFor(bookingId: string): Promise<string | null> {
  const { data } = await db.from('payments').select('id').eq('booking_id', bookingId).maybeSingle()
  return data?.id ?? null
}
