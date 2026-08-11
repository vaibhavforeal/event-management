import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { mayApprove, mayCancel } from '@/lib/bookings/authorize'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import type { Caller } from '@/lib/bookings/caller'
import type { CancelInitiator } from '@/lib/payments/refund-policy'
import { refundIfOwed } from '@/lib/payments/service'

/**
 * Every booking write in the product, and the only file allowed to hold the
 * service role.
 *
 * `bookings` and `tickets` have no write grant to `authenticated` on purpose —
 * 20260808000003 says inventory and money "can never be mutated by a crafted
 * PostgREST call" — so the functions that write them are unreachable from a
 * browser and must be called as the service role instead.
 *
 * Which means RLS does not scope anything below. It filters reads; it does not
 * see these writes at all. Every authorisation decision in this file is the
 * whole of the rule, and a missing one is a stranger cancelling someone's seat
 * rather than an ordinary bug. eslint.config.mjs stops a second file joining
 * this one, so there is one place to audit rather than a grep.
 *
 * Identity is a `Caller`, never a string: nothing outside lib/bookings/caller.ts
 * can produce one, so a form field cannot become an attendee id.
 */

export type BookingResult = { ok: true; reference: string } | { ok: false; error: string }
export type CancelResult = { ok: true } | { ok: false; error: string }

/**
 * The single refusal for cancellation, deliberately identical for "not yours",
 * "does not exist" and "the lookup failed".
 *
 * One string for every path that fails to establish the caller's right, so
 * there is one sentence to audit and nothing an outsider can tell apart. See
 * cancelBooking for why that matters.
 */
const NOT_YOURS = 'That booking is not yours to cancel.'

export async function bookFreeTickets(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  note?: string,
): Promise<BookingResult> {
  const db = createAdminClient()

  const { data, error } = await db.rpc('book_free_tickets', {
    p_ticket_type_id: ticketTypeId,
    // The caller's own id. There is no parameter through which a request could
    // supply someone else's, and there must never be one.
    p_attendee_id: caller.id,
    p_quantity: quantity,
    // What the host will read at the door. Free text the attendee chose, not an
    // identity claim — profiles are unreadable to a host and full_name is null
    // for everyone, so this is the only name there is.
    p_attendee_name: attendeeName,
    // Omitted rather than sent as null when absent: `p_attendee_note text
    // default null` means the two are the same row, and passing `undefined`
    // keeps this argument matching the generated signature exactly.
    p_attendee_note: note,
  })

  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: data.reference }
}

export async function cancelBooking(
  caller: Caller,
  bookingId: string,
  initiator: CancelInitiator,
): Promise<CancelResult> {
  const db = createAdminClient()

  // Read as the service role, so this sees the booking whoever is asking —
  // which is exactly why the answer below has to be computed rather than
  // assumed. The embed fetches the host of the event in the same round trip so
  // there is no window between reading the owner and checking against them.
  const { data: booking, error: readError } = await db
    .from('bookings')
    .select('attendee_id, events(hosts(profile_id))')
    .eq('id', bookingId)
    .maybeSingle()

  if (readError) {
    // A failed lookup is not evidence that the caller may cancel, so it refuses
    // — with the same sentence as the other two, so an outage cannot be told
    // apart from a refusal from outside. Logged because the alternative is an
    // outage that reads to everyone as a permissions problem.
    console.error('[bookings] could not read booking for cancellation', readError)
    return { ok: false, error: NOT_YOURS }
  }

  // Same answer for a booking that is not theirs and one that does not exist.
  // Distinguishing them turns this into an oracle for whether a given id is a
  // real booking, which is not something a stranger needs to know.
  if (!booking) return { ok: false, error: NOT_YOURS }

  // No cast. `bookings.event_id` and `events.host_id` are both NOT NULL with a
  // foreign key behind them, so the generated types infer this embed as
  // `{ events: { hosts: { profile_id: string } } }` — present at every level,
  // and PostgREST agrees at runtime because the referenced rows must exist.
  //
  // Worth stating because the tempting shortcut here is
  // `as unknown as { events: … }`, and that would be strictly worse than the
  // checked type: it would keep compiling if either column became nullable, and
  // the failure would surface as an undefined host id quietly authorising
  // nobody, or worse, matching an empty caller id. Left checked, that same
  // schema change is a compile error in this file, which is where someone
  // should have to think about it.
  const hostProfileId = booking.events.hosts.profile_id

  if (
    !mayCancel(caller, {
      attendee_id: booking.attendee_id,
      event_host_profile_id: hostProfileId,
    })
  ) {
    return { ok: false, error: NOT_YOURS }
  }

  // The stored prose is derived here rather than passed in: the initiator is a
  // two-value type, so no caller can write anything else into
  // bookings.cancellation_reason — dashboards and EH021 already speak these two
  // sentences.
  const reason = initiator === 'attendee' ? 'cancelled by attendee' : 'cancelled by host'

  const { error } = await db.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_reason: reason,
  })

  // Only reachable by someone already authorised above, so this message is not
  // telling a stranger anything. cancel_booking is idempotent, so a second
  // cancellation is a success rather than an error to translate.
  if (error) return { ok: false, error: error.message }

  // Seat first, then money. refundIfOwed never throws; a refund that could
  // not be sent is the sweep's job, not a failed cancel.
  await refundIfOwed(bookingId, initiator)

  return { ok: true }
}

/** One refusal for approve and decline alike — "not yours", "does not exist"
 *  and "the lookup failed" must be indistinguishable from outside. */
const NOT_YOURS_TO_DECIDE = 'That request is not yours to decide.'

export type ApproveResult = { ok: true } | { ok: false; error: string }

export async function requestBooking(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  paymentMode: 'online' | 'cash',
  note?: string,
): Promise<BookingResult> {
  const db = createAdminClient()
  const { data, error } = await db.rpc('request_booking', {
    p_ticket_type_id: ticketTypeId,
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
    p_attendee_note: note,
    p_payment_mode: paymentMode,
  })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: data.reference }
}

export async function bookCashTickets(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  note?: string,
): Promise<BookingResult> {
  const db = createAdminClient()
  const { data, error } = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: ticketTypeId,
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
    p_attendee_note: note,
  })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: data.reference }
}

/** The host-scoped read approve and decline share: the booking's status and
 *  its event's host, in one round trip, service-role like every read that
 *  precedes a service-role write. Null means "refuse with the one sentence". */
async function readForDecision(
  db: ReturnType<typeof createAdminClient>,
  bookingId: string,
): Promise<{ status: string; event_host_profile_id: string } | null> {
  const { data: booking, error } = await db
    .from('bookings')
    .select('status, events(hosts(profile_id))')
    .eq('id', bookingId)
    .maybeSingle()
  if (error) {
    console.error('[bookings] could not read booking for an approval decision', error)
    return null
  }
  if (!booking) return null
  return { status: booking.status, event_host_profile_id: booking.events.hosts.profile_id }
}

export async function approveBooking(caller: Caller, bookingId: string): Promise<ApproveResult> {
  const db = createAdminClient()
  const booking = await readForDecision(db, bookingId)
  if (!booking || !mayApprove(caller, booking)) {
    return { ok: false, error: NOT_YOURS_TO_DECIDE }
  }
  // Fees deliberately not passed: they stay 0 this pilot and the RPC's
  // defaults do it. approve_booking's fee parameters are the future wiring
  // point for lib/pricing, not this call's business.
  const { error } = await db.rpc('approve_booking', { p_booking_id: bookingId })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true }
}

export async function declineBooking(caller: Caller, bookingId: string): Promise<ApproveResult> {
  const db = createAdminClient()
  const booking = await readForDecision(db, bookingId)
  if (!booking || !mayApprove(caller, booking)) {
    return { ok: false, error: NOT_YOURS_TO_DECIDE }
  }
  // Declining is only meaningful while the request is pending. Anything else
  // already left the queue — say so rather than cancelling a paid seat under
  // a button labelled Decline.
  if (booking.status !== 'pending_approval') {
    return { ok: false, error: 'This request was already handled — refresh to see where it stands.' }
  }
  const { error } = await db.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_reason: 'declined by host',
  })
  if (error) return { ok: false, error: error.message }
  // No refundIfOwed: a pending_approval booking cannot have a payment — the
  // order is only ever created after approval.
  return { ok: true }
}

/** One refusal for "not yours", "does not exist" and "the lookup failed" — a
 *  stranger must not be able to tell an offer that exists from one that does
 *  not, and an outage must not be distinguishable from a refusal. */
const NOT_YOURS_TO_CLAIM = 'That seat offer is not yours to claim.'
const NOTHING_TO_CLAIM = 'There is no seat to claim on this booking right now.'

export async function joinWaitlist(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  paymentMode: 'online' | 'cash',
): Promise<BookingResult> {
  const db = createAdminClient()
  const { data, error } = await db.rpc('join_waitlist', {
    p_ticket_type_id: ticketTypeId,
    // The caller's own id. There is no parameter through which a request could
    // supply someone else's, and there must never be one.
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
    p_payment_mode: paymentMode,
  })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: data.reference }
}

/**
 * Takes a free or cash seat offer.
 *
 * The online twin of this is beginApprovedCheckout, which needs no waitlist
 * branch: an offer is awaiting_payment with approved_at set, which is every
 * precondition it already checks. This function exists for the two cases that
 * have no online money to ask for — cash pays at the door, free pays nothing —
 * where the honest control is "claim", not "pay".
 *
 * Deliberately NOT owner-or-host like cancelBooking: a host must not be able
 * to claim a seat on a guest's behalf. Claiming is an acceptance, and only the
 * person being offered the seat can accept it.
 */
export async function claimOfferedSeat(caller: Caller, bookingId: string): Promise<ApproveResult> {
  const db = createAdminClient()

  const { data: booking, error: readError } = await db
    .from('bookings')
    .select('id, attendee_id, ticket_type_id')
    .eq('id', bookingId)
    .maybeSingle()

  if (readError) {
    console.error('[bookings] could not read the booking for a seat claim', readError)
    return { ok: false, error: NOT_YOURS_TO_CLAIM }
  }
  if (!booking || booking.attendee_id !== caller.id) return { ok: false, error: NOT_YOURS_TO_CLAIM }

  // Settle before judging, so a hold that ran out an hour ago cannot be
  // claimed by someone who left the tab open. This also hands the seat to the
  // next person in the same call, which is why it happens even though the
  // guard below would have refused anyway: refusing without settling would
  // leave the seat held by a dead offer until something else swept it.
  const { error: settleError } = await db.rpc('release_expired_holds', {
    p_ticket_type_id: booking.ticket_type_id,
  })
  if (settleError) {
    console.error('[bookings] could not settle holds before a seat claim', settleError)
    return { ok: false, error: NOTHING_TO_CLAIM }
  }

  // Re-read AFTER the settle: the row may have just become 'expired', and the
  // whole point of settling first is that this read is the truthful one.
  const { data: fresh, error: freshError } = await db
    .from('bookings')
    .select('status, approved_at, payment_mode, total_paise')
    .eq('id', bookingId)
    .maybeSingle()
  if (freshError || !fresh) {
    console.error('[bookings] could not re-read the booking for a seat claim', freshError)
    return { ok: false, error: NOTHING_TO_CLAIM }
  }

  // An offer, and one with nothing to pay online. An online offer belongs to
  // beginApprovedCheckout, and sending it here would confirm a seat nobody
  // paid for.
  const isOffer = fresh.status === 'awaiting_payment' && !!fresh.approved_at
  const claimable = fresh.payment_mode === 'cash' || fresh.total_paise === 0
  if (!isOffer || !claimable) return { ok: false, error: NOTHING_TO_CLAIM }

  const { error } = await db.rpc('confirm_booking', { p_booking_id: bookingId })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true }
}

/**
 * Where this booking stands in its line, 1-based. Null when there is no
 * position to show.
 *
 * A read in the writes file, which the module comment above forbids in spirit
 * — but the ESLint fence decides where the service role may be held, and
 * waitlist_position is service-role only for the reason its own SQL comment
 * gives. cancelBooking and readForDecision already read here for the same
 * reason: a service-role read that precedes a decision belongs beside the
 * decision.
 *
 * Owner-or-host, via the same mayCancel that arbitrates withdraw and remove —
 * the two people entitled to act on this entry are exactly the two entitled to
 * see where it stands.
 */
export async function waitlistPosition(caller: Caller, bookingId: string): Promise<number | null> {
  const db = createAdminClient()

  const { data: booking, error: readError } = await db
    .from('bookings')
    .select('attendee_id, events(hosts(profile_id))')
    .eq('id', bookingId)
    .maybeSingle()

  if (readError) {
    console.error('[bookings] could not read the booking for a waitlist position', readError)
    return null
  }
  if (!booking) return null

  if (
    !mayCancel(caller, {
      attendee_id: booking.attendee_id,
      event_host_profile_id: booking.events.hosts.profile_id,
    })
  ) {
    return null
  }

  const { data, error } = await db.rpc('waitlist_position', { p_booking_id: bookingId })
  if (error) {
    console.error('[bookings] could not read a waitlist position', error)
    return null
  }
  // 0 is the function's way of saying "this row is not in the line" — a
  // promoted, withdrawn or expired entry. Null is this module's way of saying
  // the same thing, so no caller has to know about the sentinel.
  return data && data > 0 ? data : null
}

/**
 * Offers newly-added seats to the line, after the host's save has committed.
 *
 * The one seat-appearing path the SQL seams cannot cover. cancel_booking needs
 * a booking and release_expired_holds promotes only what it reclaimed, so a
 * capacity raise frees seats through neither — and reserve_tickets' own
 * promote call cannot do it either, because one PostgREST transaction per RPC
 * means its "only 0 seats remain" raise unwinds the promotion that produced
 * it. Hence a second, committing call from here.
 *
 * Never throws. A failed promote must not turn a successful save into an
 * error the host has to interpret — the seats are added either way, and the
 * next cancel or hold expiry serves the line. Same posture as refundIfOwed.
 *
 * Host-only, and the check is real rather than ceremonial: this is reached
 * from a Server Action carrying an eventId out of a form.
 */
export async function promoteAfterCapacityChange(caller: Caller, eventId: string): Promise<void> {
  try {
    const db = createAdminClient()

    const { data: event, error } = await db
      .from('events')
      .select('id, has_waitlist, hosts(profile_id), ticket_types(id)')
      .eq('id', eventId)
      .maybeSingle()

    if (error) {
      console.error('[bookings] could not read the event to serve its waitlist', error)
      return
    }
    // No event, no waitlist, or not this caller's to touch — all silent, all
    // the same nothing. promote_from_waitlist would refuse the middle one
    // anyway; checking here saves a round trip per ticket type.
    if (!event || !event.has_waitlist) return
    if (!mayApprove(caller, { event_host_profile_id: event.hosts.profile_id })) return

    for (const ticketType of event.ticket_types) {
      const { error: promoteError } = await db.rpc('promote_from_waitlist', {
        p_ticket_type_id: ticketType.id,
      })
      if (promoteError) {
        console.error('[bookings] could not serve the waitlist after a capacity change', promoteError)
      }
    }
  } catch (cause) {
    console.error('[bookings] serving the waitlist after a capacity change threw', cause)
  }
}
