import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { capturedEvent, fakeProvider } from '@/tests/helpers/payments'
import type { Caller } from '@/lib/bookings/caller'

vi.mock('@/lib/payments/razorpay')

const { razorpayProvider } = await import('@/lib/payments/razorpay')
const { beginApprovedCheckout, processWebhookEvent } = await import('@/lib/payments/service')

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

async function approvedBooking(seed: SeededEvent): Promise<{ id: string; reference: string; total: number }> {
  const { data: request } = await db.rpc('request_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: 1,
    p_attendee_name: 'Asha',
  })
  const { data: approved } = await db.rpc('approve_booking', { p_booking_id: request!.id })
  return { id: approved!.id, reference: approved!.reference, total: approved!.total_paise }
}

describe('beginApprovedCheckout', () => {
  let seed: SeededEvent
  let provider: ReturnType<typeof fakeProvider>

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
  })
  beforeEach(() => {
    provider = fakeProvider()
    vi.mocked(razorpayProvider).mockReturnValue(provider)
  })
  afterAll(async () => {
    // SCOPE every delete to this file's own rows. The dev DB doubles as the
    // test DB and holds kept evidence payments — a blanket delete on
    // payments or provider_webhook_events destroys them. Mirrors the cleanup
    // scoping in lib/payments/cancel-refunds.test.ts:
    // refunds → payments (by this event's booking ids) → bookings → event.
    const { data: bookings } = await db.from('bookings').select('id').eq('event_id', seed.eventId)
    const ids = (bookings ?? []).map((b) => b.id)
    if (ids.length > 0) {
      const { data: payments } = await db.from('payments').select('id').in('booking_id', ids)
      const paymentIds = (payments ?? []).map((p) => p.id)
      if (paymentIds.length > 0) await db.from('refunds').delete().in('payment_id', paymentIds)
      await db.from('payments').delete().in('booking_id', ids)
    }
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
  })

  it('creates the order once; the second call reuses it', async () => {
    const booking = await approvedBooking(seed)
    const first = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(first).toEqual({ ok: true })
    const second = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(second).toEqual({ ok: true })
    expect(provider.createOrder).toHaveBeenCalledTimes(1)
    const { data: payments } = await db.from('payments').select('amount_paise, status').eq('booking_id', booking.id)
    expect(payments).toHaveLength(1)
    expect(payments![0]).toMatchObject({ amount_paise: booking.total, status: 'created' })
    await db.from('payments').delete().eq('booking_id', booking.id)
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'test cleanup' })
  })

  it('refuses everyone but the attendee, and every state but approved-awaiting-online', async () => {
    const booking = await approvedBooking(seed)
    const stranger = await createTestUser(db)

    expect((await beginApprovedCheckout(asCaller(stranger), booking.id)).ok).toBe(false)
    expect((await beginApprovedCheckout(asCaller(seed.hostProfileId), booking.id)).ok).toBe(false)

    // lapsed hold
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
    expect((await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)).ok).toBe(false)
    expect(provider.createOrder).not.toHaveBeenCalled()

    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'test cleanup' })
    await db.auth.admin.deleteUser(stranger).catch(() => {})
  })

  it('a failed order leaves the booking approved and retryable — never cancelled', async () => {
    const booking = await approvedBooking(seed)
    vi.mocked(provider.createOrder).mockRejectedValueOnce(new Error('razorpay down'))
    const failed = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(failed.ok).toBe(false)
    const { data: after } = await db.from('bookings').select('status, approved_at').eq('id', booking.id).single()
    expect(after!.status).toBe('awaiting_payment')   // NOT cancelled
    expect(after!.approved_at).toBeTruthy()
    const retried = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(retried).toEqual({ ok: true })
    await db.from('payments').delete().eq('booking_id', booking.id)
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'test cleanup' })
  })

  it('the join: order → captured webhook → confirmed with tickets', async () => {
    const booking = await approvedBooking(seed)
    await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    const { data: payment } = await db.from('payments').select('provider_order_id').eq('booking_id', booking.id).single()

    // Hold the fixture so its event id can scope the receipt delete below —
    // the dev DB holds kept evidence receipts a blanket delete would destroy.
    const fixture = capturedEvent({ orderId: payment!.provider_order_id, amountPaise: booking.total })
    await processWebhookEvent({ providerEventId: fixture.eventId, eventType: fixture.eventType, payload: fixture.payload })

    const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
    expect(after!.status).toBe('confirmed')
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(1)

    // Teardown scoped to THIS test's rows only.
    await db
      .from('provider_webhook_events')
      .delete()
      .eq('provider', 'razorpay')
      .eq('provider_event_id', fixture.eventId)
    await db.from('payments').delete().eq('booking_id', booking.id)
  })
})
