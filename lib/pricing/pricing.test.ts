import { describe, expect, it } from 'vitest'
import {
  calculatePrice,
  estimateGatewayCost,
  netPlatformMargin,
  type FeeRule,
} from '@/lib/pricing'
import { MoneyError } from '@/lib/money'

/** The pilot defaults seeded in the fee_rules table: 5% + ₹10 floor, 10% commission. */
const PILOT: FeeRule = {
  convenienceFeeBps: 500,
  convenienceFeeMinPaise: 1000,
  convenienceFeeMaxPaise: null,
  commissionBps: 1000,
}

describe('calculatePrice', () => {
  it('applies the percentage fee when it clears the floor', () => {
    // ₹500 ticket: 5% = ₹25, comfortably above the ₹10 floor.
    const result = calculatePrice({
      unitPricePaise: 50_000,
      quantity: 1,
      paymentMode: 'online',
      rule: PILOT,
    })

    expect(result).toEqual({
      subtotalPaise: 50_000,
      conveniencePaise: 2_500,
      totalPaise: 52_500,
      commissionPaise: 5_000,
      hostPayoutPaise: 45_000,
      chargedOnlinePaise: 52_500,
    })
  })

  it('raises a cheap ticket to the minimum fee', () => {
    // ₹100 ticket: 5% = ₹5, which would not cover the gateway. Floor to ₹10.
    const result = calculatePrice({
      unitPricePaise: 10_000,
      quantity: 1,
      paymentMode: 'online',
      rule: PILOT,
    })

    expect(result.conveniencePaise).toBe(1_000)
    expect(result.totalPaise).toBe(11_000)
  })

  it('charges the fee once per order, not per ticket', () => {
    const result = calculatePrice({
      unitPricePaise: 50_000,
      quantity: 4,
      paymentMode: 'online',
      rule: PILOT,
    })

    expect(result.subtotalPaise).toBe(200_000)
    expect(result.conveniencePaise).toBe(10_000) // 5% of the order total
    expect(result.totalPaise).toBe(210_000)
    expect(result.commissionPaise).toBe(20_000)
    expect(result.hostPayoutPaise).toBe(180_000)
  })

  it('respects a maximum fee cap', () => {
    const capped: FeeRule = { ...PILOT, convenienceFeeMaxPaise: 5_000 }
    // 5% of ₹5000 would be ₹250; capped at ₹50.
    const result = calculatePrice({
      unitPricePaise: 500_000,
      quantity: 1,
      paymentMode: 'online',
      rule: capped,
    })

    expect(result.conveniencePaise).toBe(5_000)
  })

  it('keeps a free event free rather than applying the floor', () => {
    const result = calculatePrice({
      unitPricePaise: 0,
      quantity: 3,
      paymentMode: 'online',
      rule: PILOT,
    })

    expect(result.totalPaise).toBe(0)
    expect(result.conveniencePaise).toBe(0)
    expect(result.commissionPaise).toBe(0)
    expect(result.hostPayoutPaise).toBe(0)
  })

  it('takes no fee and no commission on cash bookings', () => {
    const result = calculatePrice({
      unitPricePaise: 50_000,
      quantity: 2,
      paymentMode: 'cash',
      rule: PILOT,
    })

    expect(result.subtotalPaise).toBe(100_000)
    expect(result.conveniencePaise).toBe(0)
    expect(result.totalPaise).toBe(100_000)
    expect(result.commissionPaise).toBe(0)
    // The host keeps everything: we never see the money, so we cannot bill it.
    expect(result.hostPayoutPaise).toBe(100_000)
  })

  it('never lets the parts disagree with the total', () => {
    const prices = [0, 1, 99, 100, 4_999, 10_000, 33_333, 250_000, 1_000_000]
    for (const unitPricePaise of prices) {
      for (const quantity of [1, 2, 7]) {
        const r = calculatePrice({
          unitPricePaise,
          quantity,
          paymentMode: 'online',
          rule: PILOT,
        })
        expect(r.totalPaise).toBe(r.subtotalPaise + r.conveniencePaise)
        expect(r.hostPayoutPaise).toBe(r.subtotalPaise - r.commissionPaise)
        expect(Number.isInteger(r.totalPaise)).toBe(true)
        expect(Number.isInteger(r.conveniencePaise)).toBe(true)
        expect(r.hostPayoutPaise).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('rounds fractional paise to whole paise', () => {
    // 333 paise at 5% = 16.65 paise -> 17. Floor does not apply since we set it to 0.
    const noFloor: FeeRule = { ...PILOT, convenienceFeeMinPaise: 0 }
    const result = calculatePrice({
      unitPricePaise: 333,
      quantity: 1,
      paymentMode: 'online',
      rule: noFloor,
    })

    expect(result.conveniencePaise).toBe(17)
    expect(Number.isInteger(result.commissionPaise)).toBe(true)
  })

  it('rejects nonsense input rather than silently coercing it', () => {
    expect(() =>
      calculatePrice({ unitPricePaise: -1, quantity: 1, paymentMode: 'online', rule: PILOT }),
    ).toThrow(MoneyError)

    expect(() =>
      calculatePrice({ unitPricePaise: 100.5, quantity: 1, paymentMode: 'online', rule: PILOT }),
    ).toThrow(MoneyError)

    expect(() =>
      calculatePrice({ unitPricePaise: 100, quantity: 0, paymentMode: 'online', rule: PILOT }),
    ).toThrow(MoneyError)

    expect(() =>
      calculatePrice({ unitPricePaise: 100, quantity: 1.5, paymentMode: 'online', rule: PILOT }),
    ).toThrow(MoneyError)

    expect(() =>
      calculatePrice({
        unitPricePaise: 100,
        quantity: 1,
        paymentMode: 'online',
        rule: { ...PILOT, convenienceFeeMaxPaise: 500, convenienceFeeMinPaise: 1000 },
      }),
    ).toThrow(MoneyError)
  })
})

describe('gateway cost and margin', () => {
  it('estimates Razorpay 2% plus 18% GST on the fee', () => {
    // ₹525 charged -> 2% = ₹10.50 -> +18% GST = ₹12.39
    expect(estimateGatewayCost(52_500)).toBe(1_239)
  })

  it('shows the pilot defaults are profitable on a ₹500 ticket', () => {
    const breakdown = calculatePrice({
      unitPricePaise: 50_000,
      quantity: 1,
      paymentMode: 'online',
      rule: PILOT,
    })
    // ₹25 fee + ₹50 commission = ₹75 revenue, less ₹12.39 gateway.
    expect(netPlatformMargin(breakdown)).toBe(6_261)
  })

  it('shows a cash booking is a pure loss of take rate', () => {
    const breakdown = calculatePrice({
      unitPricePaise: 50_000,
      quantity: 1,
      paymentMode: 'cash',
      rule: PILOT,
    })
    // No gateway cost either, so it nets zero rather than going negative.
    expect(netPlatformMargin(breakdown)).toBe(0)
  })
})
