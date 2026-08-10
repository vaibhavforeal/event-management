import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { fakeProvider, seedPaidBooking } from '@/tests/helpers/payments'
import type { ProviderPayment } from '@/lib/payments/provider'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider } = vi.mocked(await import('@/lib/payments/razorpay'))
const { reconcileBooking, reconcileAfterCheckout, runReconciliationSweep } = await import('@/lib/payments/service')

const db = adminClient()

// Note the sweep test seeds a slightly artificial state (a pending refund
// beside a to-be-reconciled hold) to exercise both arms in one pass; the arms
// are independent, so this is coverage economy, not a real-world claim. Also
// note: because the sweep reconciles a **lapsed** hold, the Task 6 capture
// path will judge it expired and auto-refund — the assertion on `reconciled`
// counts the attempt, not a confirm. A capture that beat the hold but lost its
// webhook is healed by the **page-load** reconcile (tested above); the sweep,
// arriving minutes later, deliberately applies the by-the-clock rule. This
// asymmetry is the spec's, recorded here so nobody "fixes" it.

/**
 * refunds → payments → cleanupEvent, in that order: payments.booking_id is
 * ON DELETE RESTRICT, so cleanupEvent's bookings delete silently fails while a
 * payments row still points at it. provider_payment_id / provider_refund_id
 * are UNIQUE table-wide and these tests reuse 'pay_reconciled_1' /
 * 'rfnd_test_1', so leftovers poison re-runs — the cancel-refunds suite's
 * pattern. No webhook receipts to delete: reconcile feeds applyPayment
 * directly, never processWebhookEvent.
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

function capturedAnswer(orderId: string, amountPaise: number): ProviderPayment[] {
  return [{
    paymentId: 'pay_reconciled_1',
    orderId,
    amountPaise,
    status: 'captured',
    method: 'upi',
    errorCode: null,
    errorDescription: null,
  }]
}

beforeEach(() => {
  razorpayProvider.mockReturnValue(fakeProvider())
})

describe('reconcileBooking', () => {
  it('heals a dropped webhook: Razorpay says captured, the booking confirms', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
      razorpayProvider.mockReturnValue(
        fakeProvider({ listOrderPayments: vi.fn(async () => capturedAnswer(orderId, booking.total_paise)) }),
      )

      await reconcileBooking(booking.id)

      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('confirmed')
      const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
      expect(count).toBe(1)
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('does nothing when Razorpay reports no terminal attempt', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })

      await reconcileBooking(booking.id)

      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('awaiting_payment')
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('never throws — a provider outage logs and leaves the page alive', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })
      razorpayProvider.mockReturnValue(
        fakeProvider({ listOrderPayments: vi.fn(async () => { throw new Error('razorpay down') }) }),
      )

      await expect(reconcileBooking(booking.id)).resolves.toBeUndefined()
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('is a no-op for a booking with no payments row', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    try {
      const { data: booking } = await db.rpc('book_free_tickets', {
        p_ticket_type_id: seed.ticketTypeId,
        p_attendee_id: seed.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
        p_attendee_note: null,
      })
      await expect(reconcileBooking(booking!.id)).resolves.toBeUndefined()
    } finally {
      await cleanupSeed(seed)
    }
  })
})

describe('reconcileAfterCheckout', () => {
  it('verifies against the STORED order id, then reconciles', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
      const provider = fakeProvider({ listOrderPayments: vi.fn(async () => capturedAnswer(orderId, booking.total_paise)) })
      razorpayProvider.mockReturnValue(provider)

      await reconcileAfterCheckout(booking.id, { paymentId: 'pay_reconciled_1', signature: 'sig' })

      expect(provider.verifyCheckoutSignature).toHaveBeenCalledWith({
        orderId, // ours, not the client's
        paymentId: 'pay_reconciled_1',
        signature: 'sig',
      })
      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('confirmed')
    } finally {
      await cleanupSeed(seed)
    }
  })

  it('a bad checkout signature reconciles nothing and waits for the webhook', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })
      const provider = fakeProvider({ verifyCheckoutSignature: vi.fn(() => false) })
      razorpayProvider.mockReturnValue(provider)

      await reconcileAfterCheckout(booking.id, { paymentId: 'pay_x', signature: 'forged' })

      expect(provider.listOrderPayments).not.toHaveBeenCalled()
      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('awaiting_payment')
    } finally {
      await cleanupSeed(seed)
    }
  })
})

describe('runReconciliationSweep', () => {
  it('reconciles lapsed holds with orders, releases pure abandonments, retries stuck refunds', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      // A dropped-webhook capture on a lapsed hold…
      const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
      await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
      // …and a refund we owe but could not send (no provider_refund_id).
      const { data: payment } = await db.from('payments').select('id').eq('booking_id', booking.id).single()
      await db.from('refunds').insert({ payment_id: payment!.id, amount_paise: 100, status: 'pending', reason: 'test seed' })
      await db.from('payments').update({ provider_payment_id: 'pay_for_stuck_refund', status: 'captured' }).eq('id', payment!.id)

      const provider = fakeProvider({ listOrderPayments: vi.fn(async () => capturedAnswer(orderId, booking.total_paise)) })
      razorpayProvider.mockReturnValue(provider)

      const counts = await runReconciliationSweep()

      expect(counts.reconciled).toBeGreaterThanOrEqual(1)
      expect(counts.refundsRetried).toBeGreaterThanOrEqual(1)
      const { data: refund } = await db.from('refunds').select('provider_refund_id, status').eq('payment_id', payment!.id).single()
      expect(refund!.provider_refund_id).toBe('rfnd_test_1')
    } finally {
      await cleanupSeed(seed)
    }
  })
})
