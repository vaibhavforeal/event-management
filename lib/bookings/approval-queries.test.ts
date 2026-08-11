import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

const { listEventRequests, listApprovedUnpaid, listEventAttendees, listMyBookings } = await import(
  '@/lib/bookings/queries'
)

// The Phase 5a reads — the host's approval queue, the approved-unpaid strip,
// and the widened booking columns — in their own file rather than appended to
// lib/bookings/queries.test.ts, whose assertions are order-dependent on its
// shared seed (the queries-embeds precedent).

const db = adminClient()

let approval: SeededEvent
let cash: SeededEvent
// Every extra attendee is minted: one attendee can hold only one ACTIVE
// booking per event (pending_approval, awaiting_payment and confirmed all
// count), so each of the four rows on the approval event needs its own user.
let requester2 = ''
let approvedUser = ''
let decoyUser = ''
let stranger = ''

let pendingRef1 = ''
let pendingRef2 = ''
let approvedRef = ''
let decoyRef = ''
let cashRef = ''

async function phoneOf(userId: string): Promise<string> {
  const { data } = await db.from('profiles').select('phone').eq('id', userId).single()
  return data!.phone
}

beforeAll(async () => {
  // Seeded WITHOUT requires_approval, deliberately: begin_paid_booking refuses
  // an approval-gated event with EH031, and the decoy this suite exists for —
  // an awaiting_payment row whose approved_at is null, on the SAME event as a
  // real approval — arises in production by exactly this sequence: a direct
  // paid checkout takes its hold, then the host flips approvals on.
  approval = await seedEvent(db, {
    quantity: 10,
    pricePaise: 50_000,
    allowsCash: true,
    status: 'published',
  })

  decoyUser = await createTestUser(db)
  const decoy = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: approval.ticketTypeId,
    p_attendee_id: decoyUser,
    p_quantity: 1,
    p_attendee_name: 'Dhruv',
  })
  if (decoy.error) throw new Error(`setup decoy hold failed: ${decoy.error.message}`)
  decoyRef = decoy.data!.reference

  await db.from('events').update({ requires_approval: true }).eq('id', approval.eventId)

  // Two pending requests, in this order — "oldest first" is only an assertion
  // when there is a second row to come after the first.
  const first = await db.rpc('request_booking', {
    p_ticket_type_id: approval.ticketTypeId,
    p_attendee_id: approval.attendeeId,
    p_quantity: 2,
    p_attendee_name: 'Asha',
    p_attendee_note: 'first-timer, friend of Ravi',
    p_payment_mode: 'online',
  })
  if (first.error) throw new Error(`setup first request failed: ${first.error.message}`)
  pendingRef1 = first.data!.reference

  requester2 = await createTestUser(db)
  const second = await db.rpc('request_booking', {
    p_ticket_type_id: approval.ticketTypeId,
    p_attendee_id: requester2,
    p_quantity: 1,
    p_attendee_name: 'Bala',
    p_payment_mode: 'cash',
  })
  if (second.error) throw new Error(`setup second request failed: ${second.error.message}`)
  pendingRef2 = second.data!.reference

  // Priced at 50_000 a seat, so approval reprices and stops at
  // awaiting_payment with approved_at stamped — a free event would confirm
  // straight through and leave nothing for listApprovedUnpaid to find.
  approvedUser = await createTestUser(db)
  const request = await db.rpc('request_booking', {
    p_ticket_type_id: approval.ticketTypeId,
    p_attendee_id: approvedUser,
    p_quantity: 2,
    p_attendee_name: 'Chitra',
  })
  if (request.error) throw new Error(`setup approvable request failed: ${request.error.message}`)
  const approved = await db.rpc('approve_booking', { p_booking_id: request.data!.id })
  if (approved.error) throw new Error(`setup approval failed: ${approved.error.message}`)
  approvedRef = approved.data!.reference

  // A second event for the confirmed cash row: book_cash_tickets refuses an
  // approval event with EH058, and the guest-list assertions need a confirmed
  // row somewhere.
  cash = await seedEvent(db, { quantity: 10, pricePaise: 50_000, allowsCash: true })
  const cashBooking = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: cash.ticketTypeId,
    p_attendee_id: cash.attendeeId,
    p_quantity: 1,
    p_attendee_name: 'Esha',
  })
  if (cashBooking.error) throw new Error(`setup cash booking failed: ${cashBooking.error.message}`)
  cashRef = cashBooking.data!.reference

  stranger = await createTestUser(db)
})

afterAll(async () => {
  // Scoped to what this file created: cleanupEvent deletes by our event ids,
  // and only then can the minted users go — attendee_id is ON DELETE RESTRICT.
  await cleanupEvent(db, approval)
  await cleanupEvent(db, cash)
  for (const id of [requester2, approvedUser, decoyUser, stranger]) {
    if (id) await db.auth.admin.deleteUser(id).catch(() => {})
  }
})

describe('listEventRequests', () => {
  it('shows the host the pending queue, oldest first, with note, mode, quantity and phone', async () => {
    signInAs(approval.hostProfileId)
    const requests = await listEventRequests(approval.eventId)

    // Exactly the two pending rows — neither the decoy hold nor the approved
    // booking (both awaiting_payment) belongs in an approval queue.
    expect(requests.map((r) => r.reference)).toEqual([pendingRef1, pendingRef2])

    expect(requests[0].attendee_name).toBe('Asha')
    expect(requests[0].attendee_note).toBe('first-timer, friend of Ravi')
    expect(requests[0].payment_mode).toBe('online')
    expect(requests[0].quantity).toBe(2)
    // Compared against the seeded user's stored phone, not a pattern — GoTrue
    // strips the leading `+` on the way in (lib/auth/phone-otp.test.ts:69), so
    // a pattern loose enough to pass would not prove the right row came back.
    expect(requests[0].profiles?.phone).toBe(await phoneOf(approval.attendeeId))

    expect(requests[1].attendee_name).toBe('Bala')
    expect(requests[1].attendee_note).toBeNull()
    expect(requests[1].payment_mode).toBe('cash')
  })

  it('shows a stranger nothing', async () => {
    signInAs(stranger)
    expect(await listEventRequests(approval.eventId)).toHaveLength(0)
  })

  it('shows a requester their own queue position not at all', async () => {
    // bookings_select_own matches this caller's own pending row, so without
    // the hosts !inner hop this would be a one-row "queue" handed to a guest.
    signInAs(approval.attendeeId)
    expect(await listEventRequests(approval.eventId)).toHaveLength(0)
  })

  it('shows nothing when signed out', async () => {
    signInAs(null)
    expect(await listEventRequests(approval.eventId)).toHaveLength(0)
  })
})

describe('listApprovedUnpaid', () => {
  it('returns only awaiting_payment rows that carry approved_at', async () => {
    signInAs(approval.hostProfileId)
    const rows = await listApprovedUnpaid(approval.eventId)

    // The load-bearing filter: the decoy hold is awaiting_payment on the same
    // event but was never approved — it must not read as an approval to chase.
    expect(rows.map((r) => r.reference)).toEqual([approvedRef])
    expect(rows.map((r) => r.reference)).not.toContain(decoyRef)

    expect(rows[0].attendee_name).toBe('Chitra')
    expect(rows[0].quantity).toBe(2)
    expect(rows[0].total_paise).toBe(100_000)
    expect(rows[0].hold_expires_at).toBeTruthy()
    expect(rows[0].profiles?.phone).toBe(await phoneOf(approvedUser))
  })

  it('shows a stranger nothing', async () => {
    signInAs(stranger)
    expect(await listApprovedUnpaid(approval.eventId)).toHaveLength(0)
  })

  it('shows the approved attendee themselves nothing', async () => {
    // Their own row again matches bookings_select_own; "the host's strip"
    // must mean hosting, not appearing on it.
    signInAs(approvedUser)
    expect(await listApprovedUnpaid(approval.eventId)).toHaveLength(0)
  })

  it('shows nothing when signed out', async () => {
    signInAs(null)
    expect(await listApprovedUnpaid(approval.eventId)).toHaveLength(0)
  })
})

describe('listEventAttendees, after the widening', () => {
  it('still returns only confirmed rows', async () => {
    // The approval event holds four bookings — two pending, one approved
    // awaiting payment, one decoy hold — and a guest list of none of them.
    signInAs(approval.hostProfileId)
    expect(await listEventAttendees(approval.eventId)).toHaveLength(0)
  })

  it('now carries payment_mode', async () => {
    signInAs(cash.hostProfileId)
    const attendees = await listEventAttendees(cash.eventId)

    expect(attendees.map((a) => a.reference)).toEqual([cashRef])
    expect(attendees[0].payment_mode).toBe('cash')
  })
})

describe('the widened MyBooking columns', () => {
  it('carries the approval fields on an approved-unpaid booking', async () => {
    signInAs(approvedUser)
    const [booking] = await listMyBookings()

    expect(booking.reference).toBe(approvedRef)
    expect(booking.attendee_id).toBe(approvedUser)
    expect(booking.payment_mode).toBe('online')
    expect(booking.approved_at).toBeTruthy()
    expect(booking.cancellation_reason).toBeNull()
    // Null and false because the seed sets neither — but present, which is
    // what Task 7's destructuring needs. An unselected column would read
    // undefined and fail both assertions.
    expect(booking.events?.venue_address).toBeNull()
    expect(booking.events?.hide_venue_until_approved).toBe(false)
  })

  it('carries the note on a pending request, with approved_at still null', async () => {
    signInAs(approval.attendeeId)
    const [booking] = await listMyBookings()

    expect(booking.reference).toBe(pendingRef1)
    expect(booking.status).toBe('pending_approval')
    expect(booking.attendee_note).toBe('first-timer, friend of Ravi')
    expect(booking.approved_at).toBeNull()
  })
})
