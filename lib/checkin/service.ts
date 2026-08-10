import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { mayCheckIn } from '@/lib/checkin/authorize'
import { mapCheckinRpcError } from '@/lib/checkin/rpc-errors'
import type { Caller } from '@/lib/bookings/caller'

/**
 * Every check-in write in the product. One of exactly three files permitted to
 * import lib/supabase/admin.ts — with lib/bookings/service.ts and
 * lib/payments/service.ts; the ESLint fence names all three.
 *
 * Same contract as lib/bookings/service.ts: RLS does not see these writes, so
 * the authorisation below is the whole of the rule, and identity is a Caller
 * that only lib/bookings/caller.ts can mint. The Caller brand is reused rather
 * than re-declared because a second brand would mean a second thing to audit.
 */

export type CheckInResult =
  | {
      ok: true
      outcome: 'checked_in' | 'already_checked_in'
      attendeeName: string | null
      checkedInAt: string
      reference: string
      ticketsTotal: number
      /**
       * Display only, and may under-count by one: when two next-ticket taps
       * race, each admits its own ticket (SKIP LOCKED) but counts under READ
       * COMMITTED, so the loser's count can miss the winner's still-uncommitted
       * write. The next render reads the settled rows. Do not gate anything on
       * this number.
       */
      ticketsIn: number
    }
  | { ok: false; error: string }

/**
 * One sentence for "not your event", "no such event" and "the lookup failed",
 * for the same reason cancelBooking has NOT_YOURS: every path that fails to
 * establish the caller's right refuses identically, so there is nothing an
 * outsider can tell apart.
 */
const NOT_YOUR_DOOR = 'That is not your event to check tickets in for.'

/** Loads the event's host and applies mayCheckIn. Null means refuse. */
async function authorizedEventHost(caller: Caller, eventId: string): Promise<boolean> {
  const db = createAdminClient()
  const { data: event, error } = await db
    .from('events')
    .select('hosts(profile_id)')
    .eq('id', eventId)
    .maybeSingle()

  if (error) {
    console.error('[checkin] could not read event for authorisation', error)
    return false
  }
  if (!event) return false
  return mayCheckIn(caller, { host_profile_id: event.hosts.profile_id })
}

export async function checkInTicket(
  caller: Caller,
  eventId: string,
  code: string,
): Promise<CheckInResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const { data, error } = await db
    .rpc('check_in_ticket', {
      p_event_id: eventId,
      p_code: code,
      // The verified caller, never a form field: who admitted this guest.
      p_checked_in_by: caller.id,
    })
    .single()

  if (error) return { ok: false, error: mapCheckinRpcError(error) }
  return {
    ok: true,
    outcome: data.outcome as 'checked_in' | 'already_checked_in',
    attendeeName: data.attendee_name,
    checkedInAt: data.checked_in_at,
    reference: data.reference,
    ticketsTotal: data.tickets_total,
    ticketsIn: data.tickets_in,
  }
}

export async function checkInNextTicket(
  caller: Caller,
  eventId: string,
  bookingId: string,
): Promise<CheckInResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const { data, error } = await db
    .rpc('check_in_next_ticket', {
      p_event_id: eventId,
      p_booking_id: bookingId,
      p_checked_in_by: caller.id,
    })
    .single()

  if (error) return { ok: false, error: mapCheckinRpcError(error) }
  return {
    ok: true,
    outcome: data.outcome as 'checked_in' | 'already_checked_in',
    attendeeName: data.attendee_name,
    checkedInAt: data.checked_in_at,
    reference: data.reference,
    ticketsTotal: data.tickets_total,
    ticketsIn: data.tickets_in,
  }
}
