import { applyBps, assertPaise, MoneyError, type Paise } from '@/lib/money'

/**
 * The fee model, as a pure function.
 *
 * Two separate flows of money, deliberately kept distinct:
 *
 *   Attendee pays   subtotal + convenience fee
 *   Host receives   subtotal - commission
 *
 * The convenience fee exists because Razorpay charges ~2% + 18% GST on every
 * instrument including UPI, and at tier-2/3 ticket prices a percentage-only
 * take rate does not cover it. The minimum floor is what actually makes a ₹100
 * ticket viable.
 */

export interface FeeRule {
  convenienceFeeBps: number
  convenienceFeeMinPaise: Paise
  convenienceFeeMaxPaise: Paise | null
  commissionBps: number
}

export type PaymentMode = 'online' | 'cash'

export interface PriceInput {
  unitPricePaise: Paise
  quantity: number
  paymentMode: PaymentMode
  rule: FeeRule
}

export interface PriceBreakdown {
  /** Ticket face value × quantity. */
  subtotalPaise: Paise
  /** Added on top, paid by the attendee. */
  conveniencePaise: Paise
  /** What the attendee is charged. */
  totalPaise: Paise
  /** Platform's cut, deducted from the host. */
  commissionPaise: Paise
  /** What the host is owed at settlement. */
  hostPayoutPaise: Paise
  /**
   * How much of `totalPaise` actually moves through the payment gateway.
   * Zero for cash, where the host collects at the door and we never see it.
   * Carried on the breakdown so downstream margin maths cannot forget.
   */
  chargedOnlinePaise: Paise
}

export function calculatePrice(input: PriceInput): PriceBreakdown {
  const { unitPricePaise, quantity, paymentMode, rule } = input

  assertPaise(unitPricePaise, 'unitPricePaise')
  assertPaise(rule.convenienceFeeMinPaise, 'convenienceFeeMinPaise')
  if (rule.convenienceFeeMaxPaise !== null) {
    assertPaise(rule.convenienceFeeMaxPaise, 'convenienceFeeMaxPaise')
    if (rule.convenienceFeeMaxPaise < rule.convenienceFeeMinPaise) {
      throw new MoneyError('convenienceFeeMaxPaise must not be below convenienceFeeMinPaise')
    }
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new MoneyError(`quantity must be a positive integer, got ${quantity}`)
  }

  const subtotalPaise = unitPricePaise * quantity
  assertPaise(subtotalPaise, 'subtotalPaise')

  // A free event is free. Applying the minimum convenience fee here would turn
  // a ₹0 board-game night into a ₹10 one, which is not what the host published.
  if (subtotalPaise === 0) {
    return {
      subtotalPaise: 0,
      conveniencePaise: 0,
      totalPaise: 0,
      commissionPaise: 0,
      hostPayoutPaise: 0,
      chargedOnlinePaise: 0,
    }
  }

  // Cash never touches us, so there is nothing to charge a fee on and no
  // commission we could collect. This is a known leak in the take rate — see
  // the design doc — and is why cash is a per-event opt-in, not the default.
  if (paymentMode === 'cash') {
    return {
      subtotalPaise,
      conveniencePaise: 0,
      totalPaise: subtotalPaise,
      commissionPaise: 0,
      hostPayoutPaise: subtotalPaise,
      chargedOnlinePaise: 0,
    }
  }

  const rawConvenience = applyBps(subtotalPaise, rule.convenienceFeeBps)
  let conveniencePaise = Math.max(rawConvenience, rule.convenienceFeeMinPaise)
  if (rule.convenienceFeeMaxPaise !== null) {
    conveniencePaise = Math.min(conveniencePaise, rule.convenienceFeeMaxPaise)
  }

  const commissionPaise = applyBps(subtotalPaise, rule.commissionBps)

  return {
    subtotalPaise,
    conveniencePaise,
    totalPaise: subtotalPaise + conveniencePaise,
    commissionPaise,
    hostPayoutPaise: subtotalPaise - commissionPaise,
    chargedOnlinePaise: subtotalPaise + conveniencePaise,
  }
}

/**
 * What Razorpay will actually take, for margin sanity checks.
 * 2% platform fee + 18% GST on that fee, applied to the full charged amount.
 */
export const RAZORPAY_FEE_BPS = 200
export const GST_BPS = 1800

export function estimateGatewayCost(totalPaise: Paise): Paise {
  const fee = applyBps(totalPaise, RAZORPAY_FEE_BPS)
  return fee + applyBps(fee, GST_BPS)
}

/** Platform margin after the gateway is paid. Can be negative — that is the point. */
export function netPlatformMargin(breakdown: PriceBreakdown): number {
  const revenue = breakdown.conveniencePaise + breakdown.commissionPaise
  // Cash bookings cost nothing to process because nothing is processed.
  return revenue - estimateGatewayCost(breakdown.chargedOnlinePaise)
}
