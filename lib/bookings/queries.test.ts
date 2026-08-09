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

describe('listMyBookings, for a host who is also an attendee', () => {
  // The case every other test in this file misses, because every stranger here
  // hosts nothing and every host has booked nothing.
  //
  // RLS ORs the two SELECT policies on bookings (20260808000003:126-130):
  // bookings_select_own (attendee_id = auth.uid()) OR bookings_select_for_host
  // (owns_event(event_id)). So for someone who both hosts an event and books
  // things, an unfiltered read of `bookings` returns their guests' rows
  // alongside their own — other people's names, seat counts and references,
  // listed on the page that says "your bookings". Being visible to a host is
  // not the same as being theirs, and RLS cannot tell the two apart here.
  let own: SeededEvent
  let myReference: string

  beforeAll(async () => {
    own = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })

    // The host books a seat on their own event — an organiser attending their
    // own supper club, which is ordinary and not an edge case.
    const mine = await bookFreeTickets(callerOf(own.hostProfileId), own.ticketTypeId, 1, 'Organiser')
    if (!mine.ok) throw new Error(`setup host booking failed: ${mine.error}`)
    myReference = mine.reference

    // And a guest books the same event. A different person, because a partial
    // unique index allows one active booking per attendee per event.
    const theirs = await bookFreeTickets(callerOf(own.attendeeId), own.ticketTypeId, 3, 'Guest')
    if (!theirs.ok) throw new Error(`setup guest booking failed: ${theirs.error}`)
  })

  afterAll(async () => {
    await cleanupEvent(db, own)
  })

  it('lists only their own booking, not their guests\'', async () => {
    signInAs(own.hostProfileId)
    const bookings = await listMyBookings()

    expect(bookings).toHaveLength(1)
    expect(bookings[0].reference).toBe(myReference)
    // Named explicitly: a length check alone would still pass if the one row
    // returned were the guest's rather than the host's.
    expect(bookings.map((b) => b.reference)).not.toContain('Guest')
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

  it('returns null when signed out', async () => {
    // anon holds no SELECT grant on bookings at all, so without the signed-in
    // check this is a thrown 42501 rather than "no such booking".
    signInAs(null)
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

  it('shows an attendee of the event nothing', async () => {
    // The same OR of policies that leaks into listMyBookings points the other
    // way here: bookings_select_own matches this caller's own row on this
    // event, so an unfiltered read hands a guest a one-row "guest list" —
    // themselves — on an event they do not host. "Empty unless the caller hosts
    // it" has to mean hosts, not merely "is on".
    signInAs(event.attendeeId)
    expect(await listEventAttendees(event.eventId)).toHaveLength(0)
  })

  it('shows nothing when signed out', async () => {
    signInAs(null)
    expect(await listEventAttendees(event.eventId)).toHaveLength(0)
  })
})
