import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import { bookFreeTickets, cancelBooking } from '@/lib/bookings/service'

const db = adminClient()
let event: SeededEvent
/** A one-seat event, so a refusal for want of inventory can be provoked. */
let scarce: SeededEvent
let strangerId: string
/** Every attendee this file mints, so afterAll can clear them. */
const minted: string[] = []

/** Application code cannot fabricate a Caller; a test may. */
function callerOf(id: string): Caller {
  return { id } as Caller
}

/**
 * A brand-new attendee.
 *
 * One active booking per attendee per event is enforced by
 * bookings_one_active_per_attendee, so a test that reuses one attendee for two
 * bookings on the same event fails on the index rather than on what it meant to
 * assert. Every booking below therefore gets its own person.
 */
async function newAttendee(): Promise<string> {
  const { createTestUser } = await import('@/tests/helpers/db')
  const id = await createTestUser(db)
  minted.push(id)
  return id
}

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
  scarce = await seedEvent(db, { quantity: 1, pricePaise: 0, status: 'published' })
  strangerId = await newAttendee()
})

afterAll(async () => {
  await cleanupEvent(db, event)
  await cleanupEvent(db, scarce)
  for (const id of minted) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('bookFreeTickets', () => {
  it('returns the reference a host reads at the door', async () => {
    const result = await bookFreeTickets(
      callerOf(event.attendeeId),
      event.ticketTypeId,
      2,
      'Priya',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reference).toMatch(/^[0-9A-HJ-NP-TV-Z]{8}$/)
  })

  it('books for the caller, never for an id it was handed', async () => {
    // The signature has no attendee-id parameter at all. This asserts the row
    // that lands carries the caller's id, so a future refactor that adds one
    // and threads a form field through it fails here.
    const result = await bookFreeTickets(callerOf(strangerId), event.ticketTypeId, 1, 'Stranger')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { data } = await db
      .from('bookings')
      .select('attendee_id, attendee_name')
      .eq('reference', result.reference)
      .single()
    expect(data!.attendee_id).toBe(strangerId)
    expect(data!.attendee_name).toBe('Stranger')
  })

  it('reports a refusal as a sentence, not a constraint', async () => {
    // Two seats asked of the one-seat event, rather than an absurd quantity
    // asked of the ten-seat one: reserve_tickets checks max_per_order before
    // availability, so a quantity of 99 comes back "cannot book more than 10
    // per order" and never reaches the sold-out branch this is about. Both are
    // sentences, but only one of them carries the number an attendee acts on.
    const result = await bookFreeTickets(
      callerOf(await newAttendee()),
      scarce.ticketTypeId,
      2,
      'Hopeful',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('seats remain')
  })

  it('tells a repeat booker what to do instead of showing them an index name', async () => {
    const twice = await newAttendee()
    const first = await bookFreeTickets(callerOf(twice), event.ticketTypeId, 1, 'Priya')
    expect(first.ok).toBe(true)

    const second = await bookFreeTickets(callerOf(twice), event.ticketTypeId, 1, 'Priya')

    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error).toBe(
      'You have already booked this event. Cancel that booking first to change it.',
    )
  })
})

describe('cancelBooking', () => {
  /** A booking by a fresh attendee, so the one-active-booking rule is never in play. */
  async function freshBooking(): Promise<{ bookingId: string; attendeeId: string }> {
    const attendeeId = await newAttendee()
    const result = await bookFreeTickets(callerOf(attendeeId), event.ticketTypeId, 1, 'Guest')
    if (!result.ok) throw new Error(`setup booking failed: ${result.error}`)
    const { data } = await db
      .from('bookings')
      .select('id')
      .eq('reference', result.reference)
      .single()
    return { bookingId: data!.id, attendeeId }
  }

  it('lets the attendee cancel and returns the seat', async () => {
    const { bookingId, attendeeId } = await freshBooking()
    const { data: before } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', event.ticketTypeId)
      .single()

    const result = await cancelBooking(callerOf(attendeeId), bookingId)
    expect(result.ok).toBe(true)

    const { data: after } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', event.ticketTypeId)
      .single()
    expect(after!.reserved_count).toBe(before!.reserved_count - 1)
  })

  it('lets a cancelled attendee book again', async () => {
    // The rule is one *active* booking, not one ever. If this fails, the index
    // predicate is wider than the active statuses.
    const { bookingId, attendeeId } = await freshBooking()
    await cancelBooking(callerOf(attendeeId), bookingId)

    const again = await bookFreeTickets(callerOf(attendeeId), event.ticketTypeId, 2, 'Guest')
    expect(again.ok).toBe(true)
  })

  it('lets the host of the event cancel it', async () => {
    const { bookingId } = await freshBooking()

    const result = await cancelBooking(callerOf(event.hostProfileId), bookingId)

    expect(result.ok).toBe(true)
    const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
    expect(data!.status).toBe('cancelled')
  })

  it('refuses a stranger, writing nothing', async () => {
    // RLS is not in this path — the write goes through the service role — so
    // this assertion is the only thing standing between a stranger and someone
    // else's seat.
    const { bookingId, attendeeId } = await freshBooking()

    const result = await cancelBooking(callerOf(strangerId), bookingId)

    expect(result.ok).toBe(false)
    const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
    expect(data!.status).toBe('confirmed')

    await cancelBooking(callerOf(attendeeId), bookingId)
  })

  it('refuses a booking that does not exist without leaking that fact', async () => {
    const result = await cancelBooking(
      callerOf(event.attendeeId),
      '00000000-0000-0000-0000-000000000000',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('That booking is not yours to cancel.')
  })

  it('answers a real booking and an imaginary one identically', async () => {
    // The two refusals above are each correct on their own and still leak
    // together: if "not yours" and "no such booking" differ by a single word, a
    // stranger can feed ids to this function and learn which ones are real
    // bookings — the reference is eight characters and it is printed on a
    // ticket. Asserting the sentences are equal is what closes that, and it is
    // asserted rather than reviewed because the two returns are far enough
    // apart in the file to drift.
    const { bookingId, attendeeId } = await freshBooking()

    const real = await cancelBooking(callerOf(strangerId), bookingId)
    const imaginary = await cancelBooking(
      callerOf(strangerId),
      '00000000-0000-0000-0000-000000000000',
    )

    expect(real.ok).toBe(false)
    expect(imaginary.ok).toBe(false)
    if (real.ok || imaginary.ok) return
    expect(real.error).toBe(imaginary.error)

    await cancelBooking(callerOf(attendeeId), bookingId)
  })
})
