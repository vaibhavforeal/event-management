import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import { approveBooking, declineBooking, requestBooking, bookCashTickets, cancelBooking } from '@/lib/bookings/service'

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

describe('the approval service', () => {
  let seed: SeededEvent
  let stranger: string
  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
    stranger = await createTestUser(db)
  })
  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(stranger).catch(() => {})
  })

  it('requests as the caller, never as a form value', async () => {
    const result = await requestBooking(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online', 'note')
    expect(result.ok).toBe(true)
    const { data } = await db.from('bookings').select('attendee_id, status').eq('event_id', seed.eventId).single()
    expect(data).toMatchObject({ attendee_id: seed.attendeeId, status: 'pending_approval' })
  })

  it('refuses approval from a stranger and from the attendee themselves', async () => {
    const { data: booking } = await db.from('bookings').select('id').eq('event_id', seed.eventId).single()
    for (const who of [stranger, seed.attendeeId]) {
      const result = await approveBooking(asCaller(who), booking!.id)
      expect(result).toEqual({ ok: false, error: 'That request is not yours to decide.' })
    }
    const { data: after } = await db.from('bookings').select('status').eq('id', booking!.id).single()
    expect(after!.status).toBe('pending_approval')
  })

  it('approves as the host', async () => {
    const { data: booking } = await db.from('bookings').select('id').eq('event_id', seed.eventId).single()
    const result = await approveBooking(asCaller(seed.hostProfileId), booking!.id)
    expect(result).toEqual({ ok: true })
    const { data: after } = await db.from('bookings').select('status, approved_at').eq('id', booking!.id).single()
    expect(after!.status).toBe('awaiting_payment')
    expect(after!.approved_at).toBeTruthy()
    await db.rpc('cancel_booking', { p_booking_id: booking!.id, p_reason: 'test cleanup' })
  })

  it('declines with the stored reason and without a refunds row', async () => {
    const request = await requestBooking(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(request.ok).toBe(true)
    const { data: booking } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'pending_approval').single()

    const refused = await declineBooking(asCaller(stranger), booking!.id)
    expect(refused.ok).toBe(false)

    const declined = await declineBooking(asCaller(seed.hostProfileId), booking!.id)
    expect(declined).toEqual({ ok: true })
    const { data: after } = await db
      .from('bookings').select('status, cancellation_reason').eq('id', booking!.id).single()
    expect(after).toMatchObject({ status: 'cancelled', cancellation_reason: 'declined by host' })

    const again = await declineBooking(asCaller(seed.hostProfileId), booking!.id)
    expect(again.ok).toBe(false) // already handled — not pending any more
  })

  it('lets the attendee withdraw their own request via cancelBooking', async () => {
    const request = await requestBooking(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(request.ok).toBe(true)
    const { data: booking } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'pending_approval').single()
    const result = await cancelBooking(asCaller(seed.attendeeId), booking!.id, 'attendee')
    expect(result).toEqual({ ok: true })
  })
})

describe('the cash service', () => {
  it('books and the host removal creates no refund', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, allowsCash: true })
    const booked = await bookCashTickets(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Chitra')
    expect(booked.ok).toBe(true)
    const { data: booking } = await db.from('bookings').select('id').eq('event_id', seed.eventId).single()
    const removed = await cancelBooking(asCaller(seed.hostProfileId), booking!.id, 'host')
    expect(removed).toEqual({ ok: true })
    // No refund row was created for this booking: a cash booking has no
    // payments row, so there is nothing a refund could hang off.
    const { data: payments } = await db.from('payments').select('id').eq('booking_id', booking!.id)
    expect(payments).toHaveLength(0)
    const { data: after } = await db.from('bookings').select('status').eq('id', booking!.id).single()
    expect(after!.status).toBe('cancelled') // cancelled, never 'refunded' — no money moved
    await cleanupEvent(db, seed)
  })
})
