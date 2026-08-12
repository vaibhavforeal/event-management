/**
 * Every sentence the waitlist says, in one place.
 *
 * Pure: no clock, no locale, no money formatting. Amounts arrive as strings
 * from formatPaise and deadlines as strings from formatIst, both computed on
 * the server that owns the rupee format and the timezone — so this module
 * cannot be the reason a price or a time is wrong, only the reason a sentence
 * is.
 *
 * Here rather than in the four components that print these, because copy in
 * JSX is copy nothing can assert. Four surfaces say "a seat opened up" in this
 * phase and they have to say it identically; a test file is the only thing
 * that makes that survive the next edit.
 */

/** Seats, said the way a person would. */
function seatsPhrase(seats: number): string {
  return `${seats} ${seats === 1 ? 'seat' : 'seats'}`
}

/** Where the attendee stands, on their own booking page. */
export function waitlistPositionLine(position: number, seats: number): string {
  return `You’re #${position} in line for ${seatsPhrase(seats)}.`
}

/** The same fact in a list row, where the seats are already in the line above. */
export function waitlistShortPosition(position: number): string {
  return `#${position} in line`
}

/**
 * The join panel's headline. Its whole job is that joining costs nothing now —
 * the price is real but conditional, and a bare "₹500" over a Join button reads
 * as a charge about to happen.
 *
 * `null` means a free event, where there is no amount to qualify and the
 * sentence has to earn its place some other way.
 */
export function waitlistPriceLine(amountLabel: string | null): string {
  return amountLabel === null
    ? 'Free — you’re in only if a seat opens for you'
    : `${amountLabel} — you pay only if a seat opens for you`
}

/** How long the line is, for a stranger deciding whether it is worth joining. */
export function lineLengthLine(length: number): string {
  if (length === 0) return 'Nobody waiting yet'
  return `${length} ${length === 1 ? 'person' : 'people'} waiting`
}

/**
 * 5a's approval offer, moved here verbatim from approved-pay-panel.tsx so that
 * it and the waitlist offer below are written next to each other. They are the
 * same event to the machinery — awaiting_payment, approved_at, a 24-hour hold —
 * and deliberately different news to the person: one is a host saying yes, the
 * other is a seat coming free.
 */
export function approvedPaySentence(amountLabel: string, deadlineLabel: string): string {
  return `You’re approved! Pay ${amountLabel} by ${deadlineLabel} to confirm your seat.`
}

/** An online offer: the news first, then what it costs to take. */
export function offerPaySentence(amountLabel: string, deadlineLabel: string): string {
  return `A seat opened up — pay ${amountLabel} by ${deadlineLabel} to take it.`
}

/**
 * A free or cash offer. Nothing is charged here — cash pays at the door, as
 * everywhere in this product — so the deadline is a deadline to *act*, and
 * saying so is the only thing standing between an attendee and a seat that
 * quietly lapses to the next person.
 *
 * `doorAmountLabel` is null on a free event and the amount on a cash one.
 */
export function offerClaimSentence(deadlineLabel: string, doorAmountLabel: string | null): string {
  const claim = `A seat opened up — claim it by ${deadlineLabel}.`
  return doorAmountLabel === null
    ? claim
    : `${claim} You’ll pay ${doorAmountLabel} in cash at the door.`
}

/**
 * The ending for an offer nobody took. Names the next move, because there is
 * one: the one-active index ignores 'expired', so rejoining is allowed — at
 * the back of the line, which the sentence does not promise otherwise.
 */
export const LAPSED_OFFER_SENTENCE = 'Your seat offer expired — you can rejoin the waitlist.'

/**
 * What removing a waitlist entry does, stated beside the host's control the
 * way cancelConsequence states a refund. Deliberately not routed through
 * cancelConsequence: that function answers a question about money, and the
 * honest answer here is that there is none — no payment was taken and no seat
 * was held — so it would return null and the host would get no sentence at all
 * where one is owed.
 */
export const REMOVE_FROM_WAITLIST_CONSEQUENCE = 'Removing takes them off the waitlist.'
