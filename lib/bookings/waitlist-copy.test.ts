import { describe, expect, it } from 'vitest'
import {
  approvedPaySentence,
  LAPSED_OFFER_SENTENCE,
  lineLengthLine,
  offerClaimSentence,
  offerPaySentence,
  REMOVE_FROM_WAITLIST_CONSEQUENCE,
  waitlistPositionLine,
  waitlistPriceLine,
  waitlistShortPosition,
} from '@/lib/bookings/waitlist-copy'

const DEADLINE = '12 Aug 2026, 7:00 pm'

describe('the attendee position in the line', () => {
  it('says the position and the seats, singular and plural', () => {
    expect(waitlistPositionLine(3, 2)).toBe(`You're #3 in line for 2 seats.`)
    expect(waitlistPositionLine(1, 1)).toBe(`You're #1 in line for 1 seat.`)
  })

  it('has a short form for a list row', () => {
    expect(waitlistShortPosition(4)).toBe('#4 in line')
  })
})

describe('the join panel price line', () => {
  it('promises payment only on an offer', () => {
    expect(waitlistPriceLine('₹500')).toBe('₹500 — you pay only if a seat opens for you')
  })

  it('says something true about a free event, where there is nothing to pay', () => {
    expect(waitlistPriceLine(null)).toBe(`Free — you're in only if a seat opens for you`)
  })
})

describe('the line length, for a stranger deciding whether to join', () => {
  it('counts people, not seats', () => {
    expect(lineLengthLine(0)).toBe('Nobody waiting yet')
    expect(lineLengthLine(1)).toBe('1 person waiting')
    expect(lineLengthLine(7)).toBe('7 people waiting')
  })
})

describe('the two offers', () => {
  it('keeps 5a approval sentence intact', () => {
    expect(approvedPaySentence('₹500', DEADLINE)).toBe(
      `You're approved! Pay ₹500 by 12 Aug 2026, 7:00 pm to confirm your seat.`,
    )
  })

  it('leads a waitlist offer with the news, not the bill', () => {
    expect(offerPaySentence('₹500', DEADLINE)).toBe(
      'A seat opened up — pay ₹500 by 12 Aug 2026, 7:00 pm to take it.',
    )
  })

  it('asks a free offer to be claimed, with nothing about money', () => {
    expect(offerClaimSentence(DEADLINE, null)).toBe(
      'A seat opened up — claim it by 12 Aug 2026, 7:00 pm.',
    )
  })

  it('tells a cash offer where the money happens', () => {
    expect(offerClaimSentence(DEADLINE, '₹500')).toBe(
      `A seat opened up — claim it by 12 Aug 2026, 7:00 pm. You'll pay ₹500 in cash at the door.`,
    )
  })
})

describe('the two endings', () => {
  it('names the next move after a lapse', () => {
    expect(LAPSED_OFFER_SENTENCE).toBe('Your seat offer expired — you can rejoin the waitlist.')
  })

  it('promises no money when the host removes someone from the line', () => {
    // Nothing was paid and no seat was held, so this must not read like
    // cancelConsequence's refund promise.
    expect(REMOVE_FROM_WAITLIST_CONSEQUENCE).toBe('Removing takes them off the waitlist.')
  })
})
