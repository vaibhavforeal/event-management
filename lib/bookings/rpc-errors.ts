import type { PostgrestError } from '@supabase/supabase-js'

/** The ticket type is not free. Payment is Phase 3. */
const NOT_FREE = 'EH010'
/** The event requires host approval. That flow is Phase 5. */
const NEEDS_APPROVAL = 'EH011'
/** This attendee already holds an active booking on this event. */
const ALREADY_BOOKED = 'EH012'
/** The event has started. */
const STARTED = 'EH013'

/** Phase 5a: the request/approve/cash block. */
const NOT_AN_APPROVAL_EVENT = 'EH050'
const REQUEST_STARTED = 'EH051'
const CASH_NOT_ALLOWED = 'EH052'
const OVER_MAX_PER_ORDER = 'EH053'
const ALREADY_ACTIVE = 'EH054'
const APPROVE_STARTED = 'EH055'
const NOT_PENDING = 'EH056'
const CASH_ON_FREE = 'EH057'
const CASH_NEEDS_APPROVAL = 'EH058'
const CASH_STARTED = 'EH059'

/** Phase 5b: the waitlist block. */
const NO_WAITLIST = 'EH060'
const WAITLIST_STARTED = 'EH061'
const WAITLIST_CASH_NOT_ALLOWED = 'EH062'
const WAITLIST_OVER_MAX_PER_ORDER = 'EH063'
const SEATS_ARE_OPEN = 'EH064'
const WAITLIST_ALREADY_ACTIVE = 'EH065'

/**
 * Turns a refusal from book_free_tickets into a sentence an attendee can read.
 *
 * Maps twenty codes across four phases of booking development: EH010–EH013
 * (free booking), EH050–EH059 (Phase 5a request/approve/cash), and EH060–EH065
 * (Phase 5b waitlist). Everything reserve_tickets raises — "only 3 seats remain",
 * "sales have closed", "cannot book more than 10 per order" — is already written
 * for a person and carries a number the attendee needs, so it passes through
 * rather than being flattened into something generic.
 */
export function mapBookingRpcError(error: PostgrestError): string {
  if (error.code === NOT_FREE) return 'This event is not free yet, so booking has not opened.'
  if (error.code === NEEDS_APPROVAL) {
    return 'This host approves guests before booking, which is not available yet.'
  }
  if (error.code === ALREADY_BOOKED) {
    // Names the next move, because there is a screen for it: /bookings.
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
  if (error.code === STARTED) return 'This event has already started.'
  if (error.code === NOT_AN_APPROVAL_EVENT) return "This event doesn't take requests — book it directly."
  if (error.code === REQUEST_STARTED || error.code === APPROVE_STARTED || error.code === CASH_STARTED) {
    return 'This event has already started.'
  }
  if (error.code === CASH_NOT_ALLOWED) return "This event doesn't take cash bookings."
  if (error.code === OVER_MAX_PER_ORDER) return "That's more seats than this event allows per booking."
  if (error.code === ALREADY_ACTIVE) {
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
  if (error.code === NOT_PENDING) return 'This request was already handled — refresh to see where it stands.'
  if (error.code === CASH_ON_FREE) return 'This event is free — book it without paying.'
  if (error.code === CASH_NEEDS_APPROVAL) return 'This host approves guests first — send a request instead.'
  if (error.code === NO_WAITLIST) return "This event doesn't keep a waitlist."
  if (error.code === WAITLIST_STARTED) return 'This event has already started.'
  if (error.code === WAITLIST_CASH_NOT_ALLOWED) return "This event doesn't take cash bookings."
  if (error.code === WAITLIST_OVER_MAX_PER_ORDER) {
    return "That's more seats than this event allows per booking."
  }
  if (error.code === SEATS_ARE_OPEN) return 'Seats are open — book instead of joining the waitlist.'
  if (error.code === WAITLIST_ALREADY_ACTIVE) {
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
  return error.message
}
