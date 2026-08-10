import type { PostgrestError } from '@supabase/supabase-js'

/** The ticket type is free; the paid path does not apply. */
const FREE = 'EH030'
/** The event requires host approval; that flow is Phase 5. */
const NEEDS_APPROVAL = 'EH031'
/** The event has already started. */
const STARTED = 'EH032'
/** This attendee already has an active booking on this event. */
const ALREADY_BOOKED = 'EH033'

/**
 * begin_paid_booking refusals as sentences an attendee can act on. Anything
 * unmapped passes through: reserve_tickets' messages are already human-written.
 */
export function mapPaymentRpcError(error: PostgrestError): string {
  if (error.code === FREE) return 'This event is free — book it without paying.'
  if (error.code === NEEDS_APPROVAL) {
    return 'This host approves guests before booking, which is not available yet.'
  }
  if (error.code === STARTED) return 'This event has already started.'
  if (error.code === ALREADY_BOOKED) {
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
  return error.message
}
