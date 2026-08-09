import type { PostgrestError } from '@supabase/supabase-js'

/** The ticket type is not free. Payment is Phase 3. */
const NOT_FREE = 'EH010'
/** The event requires host approval. That flow is Phase 5. */
const NEEDS_APPROVAL = 'EH011'
/** This attendee already holds an active booking on this event. */
const ALREADY_BOOKED = 'EH012'
/** The event has started. */
const STARTED = 'EH013'

/**
 * Turns a refusal from book_free_tickets into a sentence an attendee can read.
 *
 * Only the two guards this phase added are remapped. Everything reserve_tickets
 * raises — "only 3 seats remain", "sales have closed", "cannot book more than 10
 * per order" — is already written for a person and carries a number the
 * attendee needs, so it passes through rather than being flattened into
 * something generic.
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
  return error.message
}
