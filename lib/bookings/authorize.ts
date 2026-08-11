import type { Caller } from '@/lib/bookings/caller'

/** The fields of a booking that decide who may cancel it. */
export interface CancellableBooking {
  attendee_id: string
  /** `profiles.id` of the host who owns the event this booking is for. */
  event_host_profile_id: string
}

/**
 * Who may cancel a booking: the attendee who made it, or the host whose event
 * it is.
 *
 * Pure and separately tested because RLS does not enforce this — the write goes
 * through the service role, so this function is the whole of the rule. Both
 * call sites ask it rather than each writing the comparison out, so there is one
 * answer rather than two that can drift.
 */
export function mayCancel(caller: Caller, booking: CancellableBooking): boolean {
  // An absent id must never match an absent column. Two blanks are equal.
  if (!caller.id) return false
  return caller.id === booking.attendee_id || caller.id === booking.event_host_profile_id
}

/** The fields of a booking that decide who may approve or decline its request. */
export interface ApprovableBooking {
  /** `profiles.id` of the host who owns the event this request is for. */
  event_host_profile_id: string
}

/**
 * Who may approve or decline a request: the host whose event it is, and
 * nobody else — the attendee withdraws via cancelBooking, which mayCancel
 * already permits. Pure and separately tested for the same reason mayCancel
 * is: the write goes through the service role, so this function is the whole
 * of the rule.
 */
export function mayApprove(caller: Caller, booking: ApprovableBooking): boolean {
  // An absent id must never match an absent column. Two blanks are equal.
  if (!caller.id) return false
  return caller.id === booking.event_host_profile_id
}
