import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

const { listMyBookings, listEventAttendees } = await import('@/lib/bookings/queries')

// The Phase 2b and Phase 3 widenings of the booking reads, in their own file
// rather than appended to lib/bookings/queries.test.ts — that suite's
// assertions are order-dependent on its shared seed, and these need only one
// booking.

const db = adminClient()
let event: SeededEvent

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })

  const { error } = await db.rpc('book_free_tickets', {
    p_ticket_type_id: event.ticketTypeId,
    p_attendee_id: event.attendeeId,
    p_quantity: 2,
    p_attendee_name: 'Priya',
    p_attendee_note: null,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)
})

afterAll(async () => {
  await cleanupEvent(db, event)
})

describe('the widened booking embeds', () => {
  it('MyBooking carries the event id for the QR page', async () => {
    signInAs(event.attendeeId)
    const bookings = await listMyBookings()

    expect(bookings[0].events?.id).toBe(event.eventId)
  })

  it('each attendee row carries its ticket check-in states', async () => {
    signInAs(event.hostProfileId)
    const attendees = await listEventAttendees(event.eventId)

    expect(attendees[0].tickets).toHaveLength(2)
    expect(attendees[0].tickets.every((t) => t.checked_in_at === null)).toBe(true)
  })

  it('MyBooking carries the Phase 3 checkout columns', async () => {
    // The booking page's checkout branches read all of these. On a free,
    // confirmed booking they are the quiet values — zero rupees, no hold, an
    // empty payments embed — and the page renders exactly as it did before.
    signInAs(event.attendeeId)
    const [booking] = await listMyBookings()

    expect(booking.total_paise).toBe(0)
    expect(booking.hold_expires_at).toBeNull()
    expect(booking.attendee_name).toBe('Priya')
    expect(booking.events?.refund_cutoff_hours).toBe(24)
    // An array, not null: the embed resolves for the attendee (payments_select_own)
    // and a free booking simply has no rows in it.
    expect(booking.payments).toEqual([])
  })
})
