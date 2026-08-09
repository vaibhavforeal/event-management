import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { mayCancel } from '@/lib/bookings/authorize'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import type { Caller } from '@/lib/bookings/caller'

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
  reason?: string,
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

  const { error } = await db.rpc('cancel_booking', {
    p_booking_id: bookingId,
    // As above: absent means the column's default, which is null.
    p_reason: reason,
  })

  // Only reachable by someone already authorised above, so this message is not
  // telling a stranger anything. cancel_booking is idempotent, so a second
  // cancellation is a success rather than an error to translate.
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
