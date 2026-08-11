import { describe, expect, it } from 'vitest'
import { istLocalToUtc } from '@/lib/events/datetime'
import { cancelConsequence, refundCutoffAt, refundDecision, refundPolicySentence } from '@/lib/payments/refund-policy'

// A supper club at 7:30 pm IST on 15 Aug, cutoff 24 h → refunds end 7:30 pm IST on 14 Aug.
const startsAt = istLocalToUtc('2026-08-15T19:30').toISOString()
const cutoff = istLocalToUtc('2026-08-14T19:30')

describe('refundCutoffAt', () => {
  it('subtracts whole hours from the start', () => {
    expect(refundCutoffAt(startsAt, 24).getTime()).toBe(cutoff.getTime())
  })
  it('cutoff 0 is the start itself', () => {
    expect(refundCutoffAt(startsAt, 0).toISOString()).toBe(startsAt)
  })
})

describe('refundDecision', () => {
  it('host cancels: full, any time — even mid-event', () => {
    expect(refundDecision({ initiator: 'host', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-15T20:00') })).toBe('full')
  })
  it('attendee inside the window: full', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-13T10:00') })).toBe('full')
  })
  it('attendee one minute before the cutoff: full', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-14T19:29') })).toBe('full')
  })
  it('attendee exactly at the cutoff: none — the boundary fails closed', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: cutoff })).toBe('none')
  })
  it('attendee past the cutoff: none', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-15T10:00') })).toBe('none')
  })
  it('cutoff 0: refundable until the start instant', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 0, now: istLocalToUtc('2026-08-15T19:29') })).toBe('full')
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 0, now: istLocalToUtc('2026-08-15T19:30') })).toBe('none')
  })
  it('an unreadable start time fails closed for the attendee', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt: 'nonsense', cutoffHours: 24, now: cutoff })).toBe('none')
  })
})

describe('refundPolicySentence', () => {
  it('names the window', () => {
    expect(refundPolicySentence(24)).toBe('Free cancellation until 24 h before start.')
  })
  it('cutoff 0 reads as until-start', () => {
    expect(refundPolicySentence(0)).toBe('Free cancellation until the event starts.')
  })
})

describe('cancelConsequence', () => {
  const paid = { totalPaise: 100_000, startsAt, cutoffHours: 24 }
  it('is silent for free bookings', () => {
    expect(cancelConsequence({ initiator: 'attendee', totalPaise: 0, startsAt, cutoffHours: 24 })).toBeNull()
  })
  it('tells the attendee the amount inside the window', () => {
    expect(cancelConsequence({ initiator: 'attendee', ...paid, now: istLocalToUtc('2026-08-13T10:00') })).toBe(
      "You'll be refunded ₹1,000.",
    )
  })
  it('tells the attendee there is no refund outside it', () => {
    expect(cancelConsequence({ initiator: 'attendee', ...paid, now: istLocalToUtc('2026-08-15T10:00') })).toBe(
      'Past the refund window — no refund.',
    )
  })
  it('tells the host removal always refunds', () => {
    expect(cancelConsequence({ initiator: 'host', ...paid, now: istLocalToUtc('2026-08-15T10:00') })).toBe(
      'Removing refunds ₹1,000 in full.',
    )
  })
})

describe('cancelConsequence for cash', () => {
  it('promises nothing when the money never moved', () => {
    expect(
      cancelConsequence({
        initiator: 'host',
        totalPaise: 50_000,
        startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
        cutoffHours: 24,
        paymentMode: 'cash',
      }),
    ).toBeNull()
  })
  it('still promises the refund for online money', () => {
    expect(
      cancelConsequence({
        initiator: 'host',
        totalPaise: 50_000,
        startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
        cutoffHours: 24,
        paymentMode: 'online',
      }),
    ).toBe('Removing refunds ₹500 in full.')
  })
})
