/**
 * The check-in sentences said in more than one place. Everything said once
 * stays next to its refusal; a sentence graduates here the day a second module
 * needs it verbatim — because the pairs really are the same utterance, not two
 * that happen to match. No 'server-only' import: the scanner and the guest
 * list's button say these from the client.
 */

/**
 * The one generic failure at the door. Shared by the action's junk-shape guard
 * and the scanner's dead-network catch, because the host's next move is the
 * same in both: scan again.
 */
export const RESCAN_SENTENCE = 'Something went wrong. Rescan the ticket.'

/**
 * EH022, in words. Shared by the RPC-error map and the disabled check-in
 * button's title, so hover and a handcrafted POST meet the same vocabulary.
 */
export const ALL_SEATS_IN_SENTENCE = 'All seats on this booking are already checked in.'

/**
 * The offline amber for a valid-but-unknown ticket. Shared by the scanner's
 * card and the sync report, which explains the same scan again after it
 * resolves. The ambiguity is real: cancellation deletes unscanned tickets, so
 * offline the roster cannot tell "booked after caching" from "cancelled since".
 */
export const NOT_ON_ROSTER_SENTENCE =
  'Valid ticket, but not on the cached roster — booked after it, or since cancelled. Queued to sync; admit at your discretion.'

/**
 * IndexedDB refused to open (private mode, storage pressure). Scanning still
 * works with signal; there is just nowhere durable to put a queue. Said by the
 * scanner banner and by the offline path's refusal card, the same words.
 */
export const ARMING_UNAVAILABLE_SENTENCE =
  'Offline mode unavailable on this browser. Scanning needs signal.'
