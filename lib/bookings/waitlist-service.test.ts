import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import {
  cancelBooking,
  claimOfferedSeat,
  joinWaitlist,
  waitlistPosition,
} from '@/lib/bookings/service'

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

/**
 * Confirms `seats` against the room so the event is genuinely full.
 *
 * begin_paid_booking rather than book_cash_tickets: the cash door refuses any
 * event without allows_cash, and one describe below fills an online-only event
 * on purpose. This pair reaches the identical end state — confirmed, inventory
 * held, tickets issued — whatever the event's payment flags say. The confirm is
 * not optional: begin_paid_booking only holds, and a hold that lapsed mid-test
 * would hand the seat to the very line under test.
 */
async function fill(seed: SeededEvent, seats: number): Promise<{ buyer: string; bookingId: string }> {
  const buyer = await createTestUser(db)
  const { data, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: buyer,
    p_quantity: seats,
    p_attendee_name: 'Filler',
  })
  if (error) throw new Error(`fill failed: ${error.message}`)
  const { error: confirmError } = await db.rpc('confirm_booking', { p_booking_id: data!.id })
  if (confirmError) throw new Error(`fill confirm failed: ${confirmError.message}`)
  return { buyer, bookingId: data!.id }
}

describe('joinWaitlist', () => {
  let seed: SeededEvent
  let filler = ''
  let stranger = ''

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, allowsCash: true, hasWaitlist: true })
    filler = (await fill(seed, 1)).buyer
    stranger = await createTestUser(db)
  })

  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
  })

  it('joins as the caller, never as a form value', async () => {
    const result = await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(result.ok).toBe(true)

    const { data } = await db
      .from('bookings')
      .select('attendee_id, status, total_paise')
      .eq('event_id', seed.eventId)
      .eq('status', 'waitlisted')
      .single()
    expect(data).toMatchObject({ attendee_id: seed.attendeeId, status: 'waitlisted', total_paise: 0 })
  })

  it('turns a refusal into a sentence rather than a Postgres code', async () => {
    // Same attendee, second entry: EH065 underneath.
    const again = await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(again).toEqual({
      ok: false,
      error: 'You have already booked this event. Cancel that booking first to change it.',
    })
  })

  it('shows a position to the attendee and to the host, and to nobody else', async () => {
    const { data: entry } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'waitlisted').single()

    expect(await waitlistPosition(asCaller(seed.attendeeId), entry!.id)).toBe(1)
    expect(await waitlistPosition(asCaller(seed.hostProfileId), entry!.id)).toBe(1)
    expect(await waitlistPosition(asCaller(stranger), entry!.id)).toBeNull()
  })

  it('has no position for a booking that is not in the line', async () => {
    const { data: confirmed } = await db
      .from('bookings').select('id, attendee_id').eq('event_id', seed.eventId).eq('status', 'confirmed').single()
    expect(await waitlistPosition(asCaller(confirmed!.attendee_id), confirmed!.id)).toBeNull()
  })

  it('lets the attendee withdraw, which frees them to rejoin', async () => {
    const { data: entry } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'waitlisted').single()

    expect(await cancelBooking(asCaller(seed.attendeeId), entry!.id, 'attendee')).toEqual({ ok: true })

    const rejoined = await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(rejoined.ok).toBe(true)
  })
})

describe('claimOfferedSeat', () => {
  let seed: SeededEvent
  let filler = { buyer: '', bookingId: '' }
  let stranger = ''

  beforeAll(async () => {
    // Cash, so the offer is claimed rather than paid.
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, allowsCash: true, hasWaitlist: true })
    filler = await fill(seed, 1)
    stranger = await createTestUser(db)
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'cash')
    // Freeing the seat promotes Asha — the offer now exists.
    await db.rpc('cancel_booking', { p_booking_id: filler.bookingId, p_reason: 'test' })
  })

  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler.buyer, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
  })

  it('refuses everyone but the attendee, with one sentence for all of them', async () => {
    const { data: offer } = await db
      .from('bookings').select('id').eq('attendee_id', seed.attendeeId).single()

    for (const who of [stranger, seed.hostProfileId]) {
      expect(await claimOfferedSeat(asCaller(who), offer!.id)).toEqual({
        ok: false,
        error: 'That seat offer is not yours to claim.',
      })
    }
    // And an id that is not a booking at all gets the same answer — no oracle.
    expect(
      await claimOfferedSeat(asCaller(seed.attendeeId), '00000000-0000-4000-8000-00000000dead'),
    ).toEqual({ ok: false, error: 'That seat offer is not yours to claim.' })

    const { data: after } = await db.from('bookings').select('status').eq('id', offer!.id).single()
    expect(after!.status).toBe('awaiting_payment')
  })

  it('confirms the seat with a ticket per person, and is idempotent', async () => {
    const { data: offer } = await db
      .from('bookings').select('id').eq('attendee_id', seed.attendeeId).single()

    expect(await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).toEqual({ ok: true })

    const { data: after } = await db
      .from('bookings').select('status, payment_mode, total_paise').eq('id', offer!.id).single()
    expect(after).toMatchObject({ status: 'confirmed', payment_mode: 'cash', total_paise: 50_000 })

    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', offer!.id)
    expect(count).toBe(1)

    // A double tap must not issue a second ticket. confirm_booking returns
    // early on an already-confirmed row, so the second claim is refused before
    // it ever gets there — the status is no longer awaiting_payment.
    expect((await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).ok).toBe(false)
    const { count: still } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', offer!.id)
    expect(still).toBe(1)
  })
})

describe('claimOfferedSeat on offers it must not touch', () => {
  it('refuses an online offer — that one is paid for, not claimed', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    const filler = await fill(seed, 1)
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    await db.rpc('cancel_booking', { p_booking_id: filler.bookingId, p_reason: 'test' })

    const { data: offer } = await db
      .from('bookings').select('id, status').eq('attendee_id', seed.attendeeId).single()
    expect(offer!.status).toBe('awaiting_payment')
    expect(await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).toEqual({
      ok: false,
      error: 'There is no seat to claim on this booking right now.',
    })

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler.buyer).catch(() => {})
  })

  it('claims a FREE offer, where there is no online money to ask for', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 0, hasWaitlist: true })
    const buyer = await createTestUser(db)
    const { data: booked } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: buyer,
      p_quantity: 1,
      p_attendee_name: 'Filler',
    })
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    await db.rpc('cancel_booking', { p_booking_id: booked!.id, p_reason: 'test' })

    const { data: offer } = await db
      .from('bookings').select('id, total_paise').eq('attendee_id', seed.attendeeId).single()
    expect(offer!.total_paise).toBe(0)
    expect(await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).toEqual({ ok: true })

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(buyer).catch(() => {})
  })

  it('refuses a lapsed offer, and the settle turns it into an expired one', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, allowsCash: true, hasWaitlist: true })
    const filler = await fill(seed, 1)
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'cash')
    await db.rpc('cancel_booking', { p_booking_id: filler.bookingId, p_reason: 'test' })

    const { data: offer } = await db.from('bookings').select('id').eq('attendee_id', seed.attendeeId).single()
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', offer!.id)

    expect((await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).ok).toBe(false)
    // The claim's own settle did it: the row is expired and the seat is back.
    const { data: after } = await db.from('bookings').select('status').eq('id', offer!.id).single()
    expect(after!.status).toBe('expired')

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler.buyer).catch(() => {})
  })
})

/**
 * The one control the host's waitlist section has, proved against the engine.
 *
 * Nothing here is new behaviour — cancel_booking already promotes on its way
 * out and mayCancel already admits the host. That is the point: the page built
 * on top of it offers no promote button, so removing a stuck head is the host's
 * only way to unblock a line, and a later edit to the cancel path must not be
 * able to take that away quietly.
 */
describe('the host removing somebody from the line', () => {
  // Hoisted out of the test body so the teardown below can reach them. The
  // alternative — cleaning up on the last lines of the `it` — runs only when
  // every assertion above it passed, which is precisely when cleanup does not
  // matter; this suite's shared dev database still carries seeded events left
  // behind by exactly that shape.
  let seed: SeededEvent | undefined
  let filler = { buyer: '', bookingId: '' }
  let bigHead = ''

  afterAll(async () => {
    // Guarded because a seedEvent that threw leaves nothing to delete, and an
    // unguarded hook would bury the real failure under a TypeError. The user
    // ids are guarded for the same reason one step later.
    if (!seed) return
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler.buyer, bigHead]) {
      if (id) await db.auth.admin.deleteUser(id).catch(() => {})
    }
  })

  it('removes them and lets the line move, without touching money', async () => {
    seed = await seedEvent(db, { quantity: 3, pricePaise: 50_000, hasWaitlist: true, maxPerOrder: 3 })
    filler = await fill(seed, 3)
    // A three-seat head blocking a one-seat entry behind it.
    bigHead = await createTestUser(db)
    await joinWaitlist(asCaller(bigHead), seed.ticketTypeId, 3, 'Head of three', 'online')
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')

    // One seat comes back; the head cannot use it and nobody may pass them.
    await db.from('bookings').update({ quantity: 2 }).eq('id', filler.bookingId)
    await db.from('ticket_types').update({ reserved_count: 2 }).eq('id', seed.ticketTypeId)
    await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })

    // The line has to be genuinely stuck before the host touches it, or this
    // test proves nothing about the removal. Against a promoter that skipped
    // whoever does not fit, Asha would already hold the seat by now and every
    // assertion below would still pass while strict FIFO — the only reason a
    // queue nobody can cut is worth joining — had quietly gone.
    const { data: stillWaiting } = await db
      .from('bookings').select('attendee_id').eq('event_id', seed.eventId).eq('status', 'waitlisted')
    expect(stillWaiting).toHaveLength(2)

    const { data: head } = await db.from('bookings').select('id').eq('attendee_id', bigHead).single()
    // The host removes the blocking entry — the same cancelBooking a guest's
    // own withdraw goes through, with 'host' as the initiator.
    expect(await cancelBooking(asCaller(seed.hostProfileId), head!.id, 'host')).toEqual({ ok: true })

    const { data: after } = await db
      .from('bookings').select('status, cancellation_reason').eq('id', head!.id).single()
    expect(after).toMatchObject({ status: 'cancelled', cancellation_reason: 'cancelled by host' })

    // No refund row could exist — a waitlist entry never had a payment.
    const { data: payments } = await db.from('payments').select('id').eq('booking_id', head!.id)
    expect(payments).toHaveLength(0)

    // And the line moved: Asha now holds the seat that was stuck behind them.
    const { data: asha } = await db
      .from('bookings').select('status').eq('attendee_id', seed.attendeeId).single()
    expect(asha!.status).toBe('awaiting_payment')

    // Two seats still with the filler, one now with Asha. The removal returned
    // none of its own, because a waitlist entry never held a seat to return:
    // were cancel_booking to credit three back for it, this would read 1 and a
    // room of three would have two more seats to sell than it has chairs.
    const { data: ticketType } = await db
      .from('ticket_types').select('reserved_count').eq('id', seed.ticketTypeId).single()
    expect(ticketType!.reserved_count).toBe(3)
  })
})
