import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const admin = adminClient()

// The helper's client is untyped, so the functions' one-row return is named
// here; it mirrors the RETURNS TABLE in 20260811000001_ticket_checkin.sql.
interface CheckInRow {
  outcome: string
  attendee_name: string | null
  checked_in_at: string
  reference: string
  tickets_total: number
  tickets_in: number
}

let free: SeededEvent
let eventId: string
let otherEventId: string
// checked_in_by references profiles(id), so the host is their profile id here,
// not the hosts-table row.
let hostId: string
// The main booking's two ticket codes: codes[0] is scanned and re-scanned by
// the early tests, codes[1] is kept clean for the race.
let codes: string[]
let freshUserId: string
let freshBookingId: string
let pairUserId: string
let pairBookingId: string

/**
 * Books two seats on the free event and reads back the issued codes. Each
 * booking needs its own attendee — bookings_one_active_per_attendee allows one
 * active booking per person per event.
 */
async function bookTwoSeats(attendeeId: string, name: string): Promise<{ id: string; codes: string[] }> {
  const { data, error } = await admin.rpc('book_free_tickets', {
    p_ticket_type_id: free.ticketTypeId,
    p_attendee_id: attendeeId,
    p_quantity: 2,
    p_attendee_name: name,
    p_attendee_note: null,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)

  const bookingId = (data as { id: string }).id
  const { data: tickets, error: ticketsError } = await admin
    .from('tickets')
    .select('code')
    .eq('booking_id', bookingId)
  if (ticketsError) throw new Error(`setup ticket read failed: ${ticketsError.message}`)
  return { id: bookingId, codes: tickets!.map((t) => t.code as string) }
}

beforeAll(async () => {
  free = await seedEvent(admin, { quantity: 10, pricePaise: 0, status: 'published' })
  eventId = free.eventId
  hostId = free.hostProfileId

  const main = await bookTwoSeats(free.attendeeId, 'Asha')
  codes = main.codes

  // Untouched bookings for the next-ticket tests, each under its own attendee.
  freshUserId = await createTestUser(admin)
  freshBookingId = (await bookTwoSeats(freshUserId, 'Bala')).id
  pairUserId = await createTestUser(admin)
  pairBookingId = (await bookTwoSeats(pairUserId, 'Chitra')).id

  // A second event under the same host, so the wrong-event refusals test the
  // event match in the functions rather than event ownership.
  const { data: other, error: otherError } = await admin
    .from('events')
    .insert({
      host_id: free.hostId,
      slug: `test-event-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Test Supper Club, the other night',
      city: 'Indore',
      starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      status: 'published',
      published_at: new Date().toISOString(),
    })
    .select()
    .single<{ id: string }>()
  if (otherError) throw new Error(`seed other event failed: ${otherError.message}`)
  otherEventId = other!.id
})

afterAll(async () => {
  // Bookings before users (ON DELETE RESTRICT); the other event before
  // cleanupEvent, which deletes the host both events hang off.
  await admin.from('events').delete().eq('id', otherEventId)
  await cleanupEvent(admin, free)
  await admin.auth.admin.deleteUser(freshUserId).catch(() => {})
  await admin.auth.admin.deleteUser(pairUserId).catch(() => {})
})

describe('check_in_ticket', () => {
  it('checks a ticket in and reports the counts', async () => {
    const { data, error } = await admin
      .rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[0], p_checked_in_by: hostId })
      .single<CheckInRow>()
    expect(error).toBeNull()
    expect(data!.outcome).toBe('checked_in')
    expect(data!.attendee_name).toBe('Asha') // what book_free_tickets stored
    expect(data!.tickets_total).toBe(2)
    expect(data!.tickets_in).toBe(1)
    expect(data!.checked_in_at).toBeTruthy()
  })

  it('reports a second scan as already checked in, with the original time', async () => {
    const first = await admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[0], p_checked_in_by: hostId }).single<CheckInRow>()
    const again = await admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[0], p_checked_in_by: hostId }).single<CheckInRow>()
    expect(again.data!.outcome).toBe('already_checked_in')
    expect(again.data!.checked_in_at).toBe(first.data!.checked_in_at)
  })

  it('refuses a code that belongs to a different event with EH020', async () => {
    const { error } = await admin.rpc('check_in_ticket', { p_event_id: otherEventId, p_code: codes[0], p_checked_in_by: hostId }).single<CheckInRow>()
    expect(error?.code).toBe('EH020')
  })

  it('refuses an unknown code with EH020', async () => {
    const { error } = await admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: 'f'.repeat(32), p_checked_in_by: hostId }).single<CheckInRow>()
    expect(error?.code).toBe('EH020')
  })

  it('exactly one of two simultaneous scans wins', async () => {
    const scans = await Promise.all([
      admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[1], p_checked_in_by: hostId }).single<CheckInRow>(),
      admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[1], p_checked_in_by: hostId }).single<CheckInRow>(),
    ])
    const outcomes = scans.map((s) => s.data!.outcome).sort()
    expect(outcomes).toEqual(['already_checked_in', 'checked_in'])
  })
})

describe('check_in_next_ticket', () => {
  it('next-ticket picks unchecked tickets until none remain, then EH022', async () => {
    const one = await admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single<CheckInRow>()
    expect(one.data!.outcome).toBe('checked_in')
    expect(one.data!.tickets_in).toBe(1)
    const two = await admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single<CheckInRow>()
    expect(two.data!.tickets_in).toBe(2)
    const dry = await admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single<CheckInRow>()
    expect(dry.error?.code).toBe('EH022')
  })

  it('two simultaneous next-ticket taps take two different tickets', async () => {
    const taps = await Promise.all([
      admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: pairBookingId, p_checked_in_by: hostId }).single<CheckInRow>(),
      admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: pairBookingId, p_checked_in_by: hostId }).single<CheckInRow>(),
    ])
    expect(taps.every((t) => t.data?.outcome === 'checked_in')).toBe(true)
    const { count } = await admin.from('tickets').select('*', { count: 'exact', head: true })
      .eq('booking_id', pairBookingId).not('checked_in_at', 'is', null)
    expect(count).toBe(2)
  })

  it('refuses a booking id from a different event with EH020', async () => {
    const { error } = await admin.rpc('check_in_next_ticket', { p_event_id: otherEventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single<CheckInRow>()
    expect(error?.code).toBe('EH020')
  })
})
