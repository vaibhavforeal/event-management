import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedEvent,
  type SeededEvent,
} from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

// tests/helpers/db loads .env.local as a side effect, and the service reaches
// lib/env the moment it is imported. The helper import above must therefore
// come first; awaiting the service here keeps that order explicit rather than
// an accident of import hoisting. Same shape as lib/bookings/service.test.ts.
const { checkInTicket, checkInNextTicket, asCheckInOutcome } = await import('@/lib/checkin/service')

const admin = adminClient()

let free: SeededEvent
let eventId: string
/** The event host's PROFILE id — mayCheckIn compares against hosts.profile_id. */
let hostId: string
/** Profile id of a host with no claim on the event above. */
let otherHostId: string
let otherHostRowId: string
/** The one booking: codes[0] goes first, codes[1] is left for next-ticket. */
let bookingId: string
let codes: string[]

/** Application code cannot fabricate a Caller; a test may. */
function caller(id: string): Caller {
  return { id } as Caller
}

beforeAll(async () => {
  free = await seedEvent(admin, { quantity: 10, pricePaise: 0, status: 'published' })
  eventId = free.eventId
  hostId = free.hostProfileId

  // Two seats on one booking, the same setup shape as Task 1's suite.
  const { data, error } = await admin.rpc('book_free_tickets', {
    p_ticket_type_id: free.ticketTypeId,
    p_attendee_id: free.attendeeId,
    p_quantity: 2,
    p_attendee_name: 'Asha',
    p_attendee_note: null,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)
  bookingId = (data as { id: string }).id

  const { data: tickets, error: ticketsError } = await admin
    .from('tickets')
    .select('code')
    .eq('booking_id', bookingId)
  if (ticketsError) throw new Error(`setup ticket read failed: ${ticketsError.message}`)
  codes = tickets!.map((t) => t.code as string)

  // A second host who runs no events, so the refusals below are about *this*
  // event's door rather than about being a host at all.
  otherHostId = await createTestUser(admin)
  const { data: otherHost, error: otherHostError } = await admin
    .from('hosts')
    .insert({ profile_id: otherHostId, display_name: 'Other Test Host' })
    .select()
    .single<{ id: string }>()
  if (otherHostError) throw new Error(`seed other host failed: ${otherHostError.message}`)
  otherHostRowId = otherHost!.id
})

afterAll(async () => {
  await cleanupEvent(admin, free)
  await admin.from('hosts').delete().eq('id', otherHostRowId)
  await admin.auth.admin.deleteUser(otherHostId).catch(() => {})
})

describe('checkInTicket', () => {
  it('checks in by code for the event host', async () => {
    const result = await checkInTicket(caller(hostId), eventId, codes[0])
    expect(result).toMatchObject({ ok: true, outcome: 'checked_in', ticketsIn: 1 })
  })

  it('refuses a caller who does not host the event, with one flat sentence', async () => {
    const result = await checkInTicket(caller(otherHostId), eventId, codes[1])
    expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
    // and nothing moved:
    const { data } = await admin.from('tickets').select('checked_in_at').eq('code', codes[1]).single()
    expect(data!.checked_in_at).toBeNull()
  })

  it('gives an unknown event the same sentence as someone else’s event', async () => {
    const result = await checkInTicket(caller(hostId), '00000000-0000-4000-8000-00000000dead', codes[1])
    expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
  })

  it('maps EH020 to the host sentence', async () => {
    const result = await checkInTicket(caller(hostId), eventId, 'f'.repeat(32))
    expect(result).toEqual({
      ok: false,
      error: 'No such ticket for this event. It may be for a different event, or its booking was cancelled.',
    })
  })
})

describe('asCheckInOutcome', () => {
  // The RPC itself can only say the two words, so the fail-closed branches in
  // the three callers cannot be reached through the real database; the
  // narrowing that guards them is proven here instead.
  it('passes the two words the SQL can say, and only those', () => {
    expect(asCheckInOutcome('checked_in')).toBe('checked_in')
    expect(asCheckInOutcome('already_checked_in')).toBe('already_checked_in')
  })

  it('refuses anything else with null, never a guess', () => {
    expect(asCheckInOutcome('')).toBeNull()
    expect(asCheckInOutcome('CHECKED_IN')).toBeNull()
    expect(asCheckInOutcome('refused')).toBeNull()
    expect(asCheckInOutcome('checked_in ')).toBeNull()
  })
})

describe('checkInNextTicket', () => {
  it('checks in the next ticket by booking id', async () => {
    const result = await checkInNextTicket(caller(hostId), eventId, bookingId)
    expect(result).toMatchObject({ ok: true, outcome: 'checked_in' })
  })

  it('refuses next-ticket for a non-host too', async () => {
    const result = await checkInNextTicket(caller(otherHostId), eventId, bookingId)
    expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
  })
})
