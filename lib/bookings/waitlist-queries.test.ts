import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

const { listEventWaitlist, waitlistLength, listMyBookings, listApprovedUnpaid } = await import(
  '@/lib/bookings/queries'
)

const db = adminClient()

let seed: SeededEvent
let filler = ''
let second = ''
let stranger = ''
let firstRef = ''
let secondRef = ''

async function phoneOf(userId: string): Promise<string> {
  const { data } = await db.from('profiles').select('phone').eq('id', userId).single()
  return data!.phone
}

beforeAll(async () => {
  // Two seats, both sold, so the event is genuinely sold out and Asha's
  // two-seat entry below is a request the room could one day satisfy. On a
  // one-seat event join_waitlist now refuses it outright (EH063 against
  // tt.quantity) — an entry bigger than the whole room can never be promoted
  // and would block the line behind it forever.
  seed = await seedEvent(db, {
    quantity: 2,
    pricePaise: 50_000,
    allowsCash: true,
    hasWaitlist: true,
    maxPerOrder: 3,
  })

  filler = await createTestUser(db)
  const booked = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: filler,
    p_quantity: 2,
    p_attendee_name: 'Filler',
  })
  if (booked.error) throw new Error(`setup fill failed: ${booked.error.message}`)

  // Two in line, in this order — "oldest first" is only an assertion when
  // there is a second row to come after the first.
  const first = await db.rpc('join_waitlist', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: 2,
    p_attendee_name: 'Asha',
    p_payment_mode: 'online',
  })
  if (first.error) throw new Error(`setup first join failed: ${first.error.message}`)
  firstRef = first.data!.reference

  second = await createTestUser(db)
  const next = await db.rpc('join_waitlist', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: second,
    p_quantity: 1,
    p_attendee_name: 'Bala',
    p_payment_mode: 'cash',
  })
  if (next.error) throw new Error(`setup second join failed: ${next.error.message}`)
  secondRef = next.data!.reference

  stranger = await createTestUser(db)
})

afterAll(async () => {
  await db.from('bookings').delete().eq('event_id', seed.eventId)
  await cleanupEvent(db, seed)
  for (const id of [filler, second, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('listEventWaitlist', () => {
  it('gives the host the line in promotion order, with seats, mode and phone', async () => {
    signInAs(seed.hostProfileId)
    const line = await listEventWaitlist(seed.eventId)

    // The order IS the position: index 0 is who gets the next seat that fits.
    expect(line.map((e) => e.reference)).toEqual([firstRef, secondRef])
    expect(line[0].attendee_name).toBe('Asha')
    expect(line[0].quantity).toBe(2)
    expect(line[0].payment_mode).toBe('online')
    expect(line[0].profiles?.phone).toBe(await phoneOf(seed.attendeeId))
    expect(line[1].payment_mode).toBe('cash')
  })

  it('shows a stranger nothing, and a person in the line nothing', async () => {
    signInAs(stranger)
    expect(await listEventWaitlist(seed.eventId)).toHaveLength(0)
    // bookings_select_own matches this caller's own entry, so without the
    // hosts !inner hop this would be a one-row "line" handed to a guest.
    signInAs(seed.attendeeId)
    expect(await listEventWaitlist(seed.eventId)).toHaveLength(0)
  })

  it('shows nothing when signed out', async () => {
    signInAs(null)
    expect(await listEventWaitlist(seed.eventId)).toHaveLength(0)
  })

  it('does not confuse the line with the approved-unpaid strip', async () => {
    // A waitlisted row is not awaiting_payment, so the strip stays empty until
    // somebody is actually offered a seat.
    signInAs(seed.hostProfileId)
    expect(await listApprovedUnpaid(seed.eventId)).toHaveLength(0)
  })
})

describe('waitlistLength', () => {
  // Seeded and torn down around the block rather than inside the test that
  // needs it: a failing assertion aborts the test body, and inline cleanup
  // after one would leak the whole event into a database this suite shares.
  let quiet: SeededEvent

  beforeAll(async () => {
    quiet = await seedEvent(db, { quantity: 5, pricePaise: 50_000, hasWaitlist: true })
  })

  afterAll(async () => {
    await cleanupEvent(db, quiet)
  })

  it('counts the line for a signed-out stranger', async () => {
    // The public event page's whole gate depends on this working with no
    // session at all: `bookings` is granted to `authenticated` alone, so a
    // direct read here would answer 42501 rather than a number.
    signInAs(null)
    expect(await waitlistLength(seed.ticketTypeId)).toBe(2)
  })

  it('is zero for a ticket type nobody is waiting on', async () => {
    signInAs(null)
    expect(await waitlistLength(quiet.ticketTypeId)).toBe(0)
  })
})

describe('the widened booking columns', () => {
  it('carries the event flags a waitlisted booking needs to describe itself', async () => {
    signInAs(seed.attendeeId)
    const [booking] = await listMyBookings()

    expect(booking.reference).toBe(firstRef)
    expect(booking.status).toBe('waitlisted')
    expect(booking.quantity).toBe(2)
    // Both flags, because the booking page picks its sentence from the pair:
    // approved_at on a has_waitlist event is an offer, on a requires_approval
    // event it is an approval. An unselected column reads undefined and would
    // silently choose the wrong branch.
    expect(booking.events?.has_waitlist).toBe(true)
    expect(booking.events?.requires_approval).toBe(false)
  })
})
