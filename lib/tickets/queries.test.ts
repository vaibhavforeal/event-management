import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

const { listBookingTickets } = await import('@/lib/tickets/queries')

const db = adminClient()
let event: SeededEvent
let strangerId: string
let bookingId: string

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
  strangerId = await createTestUser(db)

  // Booked via the SQL function directly because the test needs the booking id,
  // which lib/bookings/service.ts deliberately does not return.
  const { data, error } = await db.rpc('book_free_tickets', {
    p_ticket_type_id: event.ticketTypeId,
    p_attendee_id: event.attendeeId,
    p_quantity: 2,
    p_attendee_name: 'Priya',
    p_attendee_note: null,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)
  bookingId = (data as { id: string }).id
})

afterAll(async () => {
  // Bookings (and their tickets, by cascade) go with the event; users after.
  await cleanupEvent(db, event)
  await db.auth.admin.deleteUser(strangerId).catch(() => {})
})

describe('listBookingTickets', () => {
  it('returns the booker their own tickets, codes included', async () => {
    signInAs(event.attendeeId)
    const tickets = await listBookingTickets(bookingId)

    expect(tickets).toHaveLength(2)
    expect(tickets[0].code).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns the event host the same tickets', async () => {
    signInAs(event.hostProfileId)
    const tickets = await listBookingTickets(bookingId)

    expect(tickets).toHaveLength(2)
  })

  it('returns a stranger nothing — RLS filters, it does not refuse', async () => {
    signInAs(strangerId)
    const tickets = await listBookingTickets(bookingId)

    expect(tickets).toEqual([])
  })

  it('returns nobody anything when signed out', async () => {
    signInAs(null) // no session installed
    const tickets = await listBookingTickets(bookingId)

    expect(tickets).toEqual([])
  })
})
