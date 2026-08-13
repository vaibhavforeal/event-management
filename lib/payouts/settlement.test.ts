import { describe, expect, it } from 'vitest'
import { joinPaymentFacts, settle, type SettlementBooking } from '@/lib/payouts/settlement'
import { MoneyError } from '@/lib/money'

function booking(over: Partial<SettlementBooking> = {}): SettlementBooking {
  return {
    id: 'b1',
    status: 'confirmed',
    payment_mode: 'online',
    subtotal_paise: 50_000,
    commission_paise: 0,
    has_captured_payment: true,
    has_refund: false,
    ...over,
  }
}

describe('settle', () => {
  it('counts a confirmed online booking with a captured payment', () => {
    const result = settle([booking({ id: 'b1' })])
    expect(result.grossPaise).toBe(50_000)
    expect(result.netPaise).toBe(50_000)
    expect(result.forfeitedPaise).toBe(0)
    expect(result.countedBookingIds).toEqual(['b1'])
  })

  it('counts a cancelled booking whose money was kept, and marks it forfeited', () => {
    const result = settle([booking({ id: 'b1', status: 'cancelled' })])
    expect(result.grossPaise).toBe(50_000)
    expect(result.forfeitedPaise).toBe(50_000)
    expect(result.countedBookingIds).toEqual(['b1'])
  })

  it('excludes a cancelled booking that does have a refund', () => {
    const result = settle([booking({ id: 'b1', status: 'cancelled', has_refund: true })])
    expect(result.grossPaise).toBe(0)
    expect(result.forfeitedPaise).toBe(0)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a confirmed booking whose refund row exists but payment is still captured', () => {
    // applyRefundEvent inserts the refund row BEFORE flipping payments.status to
    // 'refunded'. If that second write throws, a processed refund sits against a
    // still-captured payment on a still-confirmed booking until Razorpay redelivers.
    // Paying it out would double-pay: once to the attendee (refund succeeded), once
    // to the host (payout). has_refund disqualifies it.
    const result = settle([booking({ id: 'b1', status: 'confirmed', has_refund: true })])
    expect(result.grossPaise).toBe(0)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a refunded booking even when its refund failed', () => {
    // has_refund is true whatever the refund's own status, so a 'failed' refund
    // — where the money may still be ours — is still not paid out. An
    // underpayment is a correction; an overpayment is a conversation.
    const result = settle([booking({ id: 'b1', status: 'refunded', has_refund: true })])
    expect(result.grossPaise).toBe(0)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a refunded booking even with no refund row at all', () => {
    // Status alone disqualifies. Nothing about the refunds table rescues it.
    const result = settle([booking({ id: 'b1', status: 'refunded', has_refund: false })])
    expect(result.grossPaise).toBe(0)
  })

  it('keeps cash out of gross and reports it separately', () => {
    const result = settle([
      booking({ id: 'b1', payment_mode: 'cash', has_captured_payment: false }),
    ])
    expect(result.grossPaise).toBe(0)
    expect(result.netPaise).toBe(0)
    expect(result.cashPaise).toBe(50_000)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a confirmed online booking with no captured payment', () => {
    const result = settle([booking({ id: 'b1', has_captured_payment: false })])
    expect(result.grossPaise).toBe(0)
  })

  it.each(['pending_approval', 'awaiting_payment', 'expired', 'waitlisted'])(
    'excludes %s bookings, where no money ever moved',
    (status) => {
      const result = settle([booking({ id: 'b1', status })])
      expect(result.grossPaise).toBe(0)
    },
  )

  it('subtracts commission from gross to get net', () => {
    // Zero across the pilot, non-zero here on purpose: this is the assertion
    // that the ledger is already correct on the day fees turn on, and it is
    // tested rather than asserted in prose.
    const result = settle([booking({ id: 'b1', subtotal_paise: 50_000, commission_paise: 5_000 })])
    expect(result.grossPaise).toBe(50_000)
    expect(result.commissionPaise).toBe(5_000)
    expect(result.netPaise).toBe(45_000)
  })

  it('takes commission on a forfeited seat too, from the same booking row', () => {
    const result = settle([
      booking({ id: 'b1', status: 'cancelled', subtotal_paise: 20_000, commission_paise: 2_000 }),
    ])
    expect(result.grossPaise).toBe(20_000)
    expect(result.forfeitedPaise).toBe(20_000)
    expect(result.commissionPaise).toBe(2_000)
    expect(result.netPaise).toBe(18_000)
  })

  it('sums commission across multiple counted bookings', () => {
    const result = settle([
      booking({ id: 'b1', subtotal_paise: 50_000, commission_paise: 5_000 }),
      booking({ id: 'b2', subtotal_paise: 30_000, commission_paise: 3_000 }),
      booking({ id: 'b3', subtotal_paise: 20_000, commission_paise: 2_000, status: 'cancelled' }),
    ])
    expect(result.grossPaise).toBe(100_000)
    expect(result.commissionPaise).toBe(10_000)
    expect(result.netPaise).toBe(90_000)
  })

  it('sums a mixed event', () => {
    const result = settle([
      booking({ id: 'b1', subtotal_paise: 50_000 }),
      booking({ id: 'b2', subtotal_paise: 30_000, status: 'cancelled' }),
      booking({ id: 'b3', subtotal_paise: 40_000, status: 'refunded', has_refund: true }),
      booking({ id: 'b4', subtotal_paise: 25_000, payment_mode: 'cash', has_captured_payment: false }),
      booking({ id: 'b5', subtotal_paise: 10_000, status: 'expired' }),
    ])
    expect(result.grossPaise).toBe(80_000)
    expect(result.forfeitedPaise).toBe(30_000)
    expect(result.cashPaise).toBe(25_000)
    expect(result.netPaise).toBe(80_000)
    expect(result.countedBookingIds.sort()).toEqual(['b1', 'b2'])
  })

  it('settles an all-cash event', () => {
    const result = settle([
      booking({ id: 'b1', subtotal_paise: 30_000, payment_mode: 'cash', has_captured_payment: false }),
      booking({ id: 'b2', subtotal_paise: 20_000, payment_mode: 'cash', has_captured_payment: false }),
    ])
    expect(result.grossPaise).toBe(0)
    expect(result.cashPaise).toBe(50_000)
    expect(result.countedBookingIds).toEqual([])
  })

  it('settles an event that is entirely forfeits', () => {
    const result = settle([
      booking({ id: 'b1', subtotal_paise: 40_000, status: 'cancelled' }),
      booking({ id: 'b2', subtotal_paise: 30_000, status: 'cancelled' }),
    ])
    expect(result.grossPaise).toBe(70_000)
    expect(result.forfeitedPaise).toBe(70_000)
    expect(result.netPaise).toBe(70_000)
    expect(result.countedBookingIds.sort()).toEqual(['b1', 'b2'])
  })

  it('settles an event with no bookings to zero rather than throwing', () => {
    const result = settle([])
    expect(result).toMatchObject({
      grossPaise: 0,
      commissionPaise: 0,
      netPaise: 0,
      forfeitedPaise: 0,
      cashPaise: 0,
    })
    expect(result.countedBookingIds).toEqual([])
  })

  it('settles a free event to zero', () => {
    const result = settle([booking({ id: 'b1', subtotal_paise: 0 })])
    expect(result.grossPaise).toBe(0)
    expect(result.netPaise).toBe(0)
    expect(result.countedBookingIds).toEqual(['b1'])
  })

  it('excludes a cash booking with a captured payment, because the host holds it', () => {
    // Captured payment on a cash booking is inconsistent, but if it happens
    // (say, a mode toggle after payment), the cash rule wins — the host took
    // the money at the door, so paying it again would be double-paying.
    const result = settle([booking({ id: 'b1', payment_mode: 'cash', has_captured_payment: true })])
    expect(result.grossPaise).toBe(0)
    expect(result.cashPaise).toBe(50_000)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a cancelled cash booking', () => {
    const result = settle([booking({ id: 'b1', payment_mode: 'cash', status: 'cancelled', has_captured_payment: false })])
    expect(result.cashPaise).toBe(0)
  })

  it('excludes an expired cash booking', () => {
    const result = settle([booking({ id: 'b1', payment_mode: 'cash', status: 'expired', has_captured_payment: false })])
    expect(result.cashPaise).toBe(0)
  })

  it('refuses a non-integer or negative amount rather than settling it', () => {
    expect(() => settle([booking({ subtotal_paise: 1.5 })])).toThrow(MoneyError)
    expect(() => settle([booking({ subtotal_paise: -1 })])).toThrow(MoneyError)
  })

  it('refuses a commission that exceeds the subtotal', () => {
    expect(() => settle([booking({ subtotal_paise: 10_000, commission_paise: 11_000 })])).toThrow(MoneyError)
  })
})

describe('joinPaymentFacts', () => {
  const raw = { id: 'b1', status: 'confirmed', payment_mode: 'online' as const, subtotal_paise: 100, commission_paise: 0 }

  it('marks a booking with a captured payment', () => {
    const [row] = joinPaymentFacts([raw], [{ id: 'p1', booking_id: 'b1', status: 'captured' }], [])
    expect(row.has_captured_payment).toBe(true)
    expect(row.has_refund).toBe(false)
  })

  it('ignores a payment that never captured', () => {
    const [row] = joinPaymentFacts([raw], [{ id: 'p1', booking_id: 'b1', status: 'created' }], [])
    expect(row.has_captured_payment).toBe(false)
  })

  it('marks a refund against the captured payment', () => {
    const [row] = joinPaymentFacts(
      [raw],
      [{ id: 'p1', booking_id: 'b1', status: 'captured' }],
      [{ payment_id: 'p1' }],
    )
    expect(row.has_refund).toBe(true)
  })

  it('does not attribute another booking\'s refund', () => {
    const [row] = joinPaymentFacts(
      [raw],
      [{ id: 'p1', booking_id: 'b1', status: 'captured' }],
      [{ payment_id: 'p_other' }],
    )
    expect(row.has_refund).toBe(false)
  })

  it('handles a booking with no payment rows at all', () => {
    const [row] = joinPaymentFacts([raw], [], [])
    expect(row.has_captured_payment).toBe(false)
    expect(row.has_refund).toBe(false)
  })

  it('sees a refund on ANY captured payment, matching host_settlement_rows', () => {
    // The pathological row the payments flow never produces: two captured
    // payments, the refund against the second. First-captured semantics
    // would count this booking; SQL's any-captured semantics disqualify it.
    // One fact, one definition.
    const [row] = joinPaymentFacts(
      [raw],
      [
        { id: 'p1', booking_id: 'b1', status: 'captured' },
        { id: 'p2', booking_id: 'b1', status: 'captured' },
      ],
      [{ payment_id: 'p2' }],
    )
    expect(row.has_captured_payment).toBe(true)
    expect(row.has_refund).toBe(true)
  })

  it('ignores a refund whose payment never captured, matching host_settlement_rows', () => {
    // SQL joins refunds through payments WHERE status = 'captured' — a refund
    // row against an uncaptured payment is not a refund of held money.
    const [row] = joinPaymentFacts(
      [raw],
      [
        { id: 'p1', booking_id: 'b1', status: 'captured' },
        { id: 'p2', booking_id: 'b1', status: 'created' },
      ],
      [{ payment_id: 'p2' }],
    )
    expect(row.has_captured_payment).toBe(true)
    expect(row.has_refund).toBe(false)
  })

  it('joins payment facts to the correct booking when multiple bookings exist', () => {
    const raw1 = { id: 'b1', status: 'confirmed', payment_mode: 'online' as const, subtotal_paise: 100, commission_paise: 0 }
    const raw2 = { id: 'b2', status: 'confirmed', payment_mode: 'online' as const, subtotal_paise: 200, commission_paise: 0 }
    const [row1, row2] = joinPaymentFacts(
      [raw1, raw2],
      [{ id: 'p1', booking_id: 'b1', status: 'captured' }],
      [],
    )
    expect(row1.has_captured_payment).toBe(true)
    expect(row2.has_captured_payment).toBe(false)
  })

  it('attributes a refund to the correct booking when multiple bookings exist', () => {
    const raw1 = { id: 'b1', status: 'confirmed', payment_mode: 'online' as const, subtotal_paise: 100, commission_paise: 0 }
    const raw2 = { id: 'b2', status: 'confirmed', payment_mode: 'online' as const, subtotal_paise: 200, commission_paise: 0 }
    const [row1, row2] = joinPaymentFacts(
      [raw1, raw2],
      [
        { id: 'p1', booking_id: 'b1', status: 'captured' },
        { id: 'p2', booking_id: 'b2', status: 'captured' },
      ],
      [{ payment_id: 'p2' }],
    )
    expect(row1.has_refund).toBe(false)
    expect(row2.has_refund).toBe(true)
  })
})
