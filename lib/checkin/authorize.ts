import type { Caller } from '@/lib/bookings/caller'

/** The fields of an event that decide who may check its tickets in. */
export interface CheckInEvent {
  /** `profiles.id` of the host who owns the event. */
  host_profile_id: string
}

/**
 * Who may check a ticket in: the event's host, and nobody else. An attendee
 * holding a valid ticket is a guest, not a doorkeeper.
 *
 * Pure and separately tested because RLS does not enforce this — the write
 * goes through the service role, so this function is the whole of the rule.
 * Same shape as lib/bookings/authorize.ts for the same reason.
 */
export function mayCheckIn(caller: Caller, event: CheckInEvent): boolean {
  // An absent id must never match an absent column. Two blanks are equal.
  if (!caller.id) return false
  return caller.id === event.host_profile_id
}
