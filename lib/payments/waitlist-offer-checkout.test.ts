import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { capturedEvent, fakeProvider } from '@/tests/helpers/payments'
import type { Caller } from '@/lib/bookings/caller'

vi.mock('@/lib/payments/razorpay')

const { razorpayProvider } = await import('@/lib/payments/razorpay')
const { beginApprovedCheckout, processWebhookEvent } = await import('@/lib/payments/service')

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

describe('an online seat offer on the Phase 3 rails', () => {
  let seed: SeededEvent
  let filler = ''
  let provider: ReturnType<typeof fakeProvider>

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    // Fill the room, put Asha in the line, then free the seat so she is
    // promoted. Nothing here is approval machinery — the shape it produces
    // just happens to be identical, which is the entire design.
    //
    // Filled through the paid door and confirmed: this event takes no cash, so
    // the cash door would refuse it outright.
    filler = await createTestUser(db)
    const { data: booked, error } = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: filler,
      p_quantity: 1,
      p_attendee_name: 'Filler',
    })
    if (error) throw new Error(`fill failed: ${error.message}`)
    const { error: confirmError } = await db.rpc('confirm_booking', { p_booking_id: booked!.id })
    if (confirmError) throw new Error(`fill confirm failed: ${confirmError.message}`)

    await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    await db.rpc('cancel_booking', { p_booking_id: booked!.id, p_reason: 'test' })
  })

  beforeEach(() => {
    provider = fakeProvider()
    vi.mocked(razorpayProvider).mockReturnValue(provider)
  })

  afterAll(async () => {
    // Scoped exactly as approved-checkout.test.ts scopes it: the dev DB
    // doubles as the test DB and holds kept evidence payments and receipts.
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
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('the join: offer → order → captured webhook → confirmed with tickets', async () => {
    const { data: offer } = await db
      .from('bookings')
      .select('id, total_paise, status, approved_at')
      .eq('attendee_id', seed.attendeeId)
      .single()
    // The precondition set beginApprovedCheckout checks, met by promotion
    // alone — no approve_booking was ever called on this row.
    expect(offer).toMatchObject({ status: 'awaiting_payment', total_paise: 50_000 })
    expect(offer!.approved_at).toBeTruthy()

    expect(await beginApprovedCheckout(asCaller(seed.attendeeId), offer!.id)).toEqual({ ok: true })

    const { data: payment } = await db
      .from('payments').select('provider_order_id').eq('booking_id', offer!.id).single()
    const fixture = capturedEvent({ orderId: payment!.provider_order_id, amountPaise: offer!.total_paise })
    await processWebhookEvent({
      providerEventId: fixture.eventId,
      eventType: fixture.eventType,
      payload: fixture.payload,
    })

    const { data: after } = await db.from('bookings').select('status').eq('id', offer!.id).single()
    expect(after!.status).toBe('confirmed')
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', offer!.id)
    expect(count).toBe(1)

    await db
      .from('provider_webhook_events')
      .delete()
      .eq('provider', 'razorpay')
      .eq('provider_event_id', fixture.eventId)
  })
})
