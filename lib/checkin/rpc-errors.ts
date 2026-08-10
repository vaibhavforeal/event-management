import type { PostgrestError } from '@supabase/supabase-js'

/** No ticket with this code — or booking with this id — on this event. */
const NOT_HERE = 'EH020'
/** The ticket's booking is not confirmed. Unreachable today; Phase 3/5 net. */
const NOT_CONFIRMED = 'EH021'
/** next_ticket only: every ticket on the booking is already in. */
const ALL_IN = 'EH022'

/**
 * Turns a check-in refusal into a sentence for the host at the door.
 *
 * EH020 deliberately does not distinguish "wrong event" from "cancelled
 * booking" from "never existed": the function cannot tell them apart either
 * (the row simply is not there from this event's doorway), and the host's next
 * move — turn to the guest list — is the same in every case.
 */
export function mapCheckinRpcError(error: PostgrestError): string {
  if (error.code === NOT_HERE) {
    return 'No such ticket for this event. It may be for a different event, or its booking was cancelled.'
  }
  if (error.code === NOT_CONFIRMED) return 'This booking is not confirmed.'
  if (error.code === ALL_IN) return 'All seats on this booking are already checked in.'
  return error.message
}
