import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock
import type { Caller } from '@/lib/bookings/caller'

const { listMyBookings, getBookingByReference, listEventAttendees } = await import(
  '@/lib/bookings/queries'
)
const { bookFreeTickets } = await import('@/lib/bookings/service')

const db = adminClient()
let event: SeededEvent
let strangerId: string
let reference: string

function callerOf(id: string): Caller {
  return { id } as Caller
}

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
  strangerId = await createTestUser(db)

  const result = await bookFreeTickets(callerOf(event.attendeeId), event.ticketTypeId, 2, 'Priya')
  if (!result.ok) throw new Error(`setup booking failed: ${result.error}`)
  reference = result.reference
})

afterAll(async () => {
  await cleanupEvent(db, event)
  await db.auth.admin.deleteUser(strangerId).catch(() => {})
})

describe('listMyBookings', () => {
  it('returns the attendee\'s own bookings with their event', async () => {
    signInAs(event.attendeeId)
    const bookings = await listMyBookings()

    expect(bookings).toHaveLength(1)
    expect(bookings[0].reference).toBe(reference)
    expect(bookings[0].events?.title).toBe('Test Supper Club')
  })

  it('returns nothing for someone else', async () => {
    // RLS, not a filter we wrote: bookings_select_own scopes on auth.uid().
    signInAs(strangerId)
    expect(await listMyBookings()).toHaveLength(0)
  })

  it('returns nothing when signed out', async () => {
    signInAs(null)
    expect(await listMyBookings()).toHaveLength(0)
  })
})

describe('getBookingByReference', () => {
  it('finds the attendee\'s own booking', async () => {
    signInAs(event.attendeeId)
    const booking = await getBookingByReference(reference)
    expect(booking?.quantity).toBe(2)
  })

  it('returns null for a stranger holding the reference', async () => {
    // The reference is short and quotable, so it will be overheard. It must not
    // be a password.
    signInAs(strangerId)
    expect(await getBookingByReference(reference)).toBeNull()
  })
})

describe('listEventAttendees', () => {
  it('lets the host see who is coming, by name', async () => {
    signInAs(event.hostProfileId)
    const attendees = await listEventAttendees(event.eventId)

    expect(attendees).toHaveLength(1)
    expect(attendees[0].quantity).toBe(2)
    // The two assertions this file exists for. Counting rows cannot tell a
    // working guest list from one where every row reads "Guest" with a blank
    // phone — which is exactly what this query produced before
    // profiles_select_for_host existed, silently and with no error.
    expect(attendees[0].attendee_name).toBe('Priya')
    // Compared against the seeded user's stored phone, not a pattern. GoTrue
    // strips the leading `+` on the way in — `lib/auth/phone-otp.test.ts:69`
    // has pinned that since Phase 0 — so `/^\+/` is unsatisfiable, and a
    // pattern loose enough to pass would not prove the right row came back.
    const { data: expected } = await db
      .from('profiles')
      .select('phone')
      .eq('id', event.attendeeId)
      .single()
    expect(attendees[0].profiles?.phone).toBe(expected!.phone)
  })

  it('shows another host nothing', async () => {
    signInAs(strangerId)
    expect(await listEventAttendees(event.eventId)).toHaveLength(0)
  })
})
