import { assertPaise, type Paise } from '@/lib/money'
import type { SettleableEvent } from '@/lib/payouts/queries'

/**
 * Pure math from the snapshot row (and the console's settlement statements)
 * to display values. Pure on purpose, following lib/payouts/settlement.ts:
 * handed numbers, it returns numbers — no database, no clock — so the whole
 * of the business arithmetic is testable in milliseconds.
 *
 * Rates are fractions (0.25), null when the denominator is empty: "no data
 * yet" is not 0% and must not render as it.
 */

/** One row of raw platform aggregates from admin_business_snapshot(). */
export interface BusinessSnapshot {
  gmv_paise: number
  refunds_processed_paise: number
  commission_paise: number
  cash_confirmed_paise: number
  online_confirmed_paise: number
  cash_confirmed_count: number
  confirmed_count: number
  events_live: number
  events_ended: number
  capacity_seats: number
  confirmed_seats: number
  tickets_issued: number
  tickets_checked_in: number
  waitlisted_count: number
}

/** The v1 design doc's rethink-threshold: cash at or past this share of confirmed bookings. */
export const CASH_RATIO_THRESHOLD = 0.3

/** numerator/denominator as a fraction, or null when there is nothing to divide by. */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return numerator / denominator
}

export function cashCountRatio(s: BusinessSnapshot): number | null {
  return ratio(s.cash_confirmed_count, s.confirmed_count)
}

export function cashValueRatio(s: BusinessSnapshot): number | null {
  return ratio(s.cash_confirmed_paise, s.cash_confirmed_paise + s.online_confirmed_paise)
}

/** True at or past the threshold — at the threshold IS at the threshold. */
export function cashFlag(s: BusinessSnapshot): boolean {
  const r = cashCountRatio(s)
  return r !== null && r >= CASH_RATIO_THRESHOLD
}

export function fillRate(s: BusinessSnapshot): number | null {
  return ratio(s.confirmed_seats, s.capacity_seats)
}

export function checkInRate(s: BusinessSnapshot): number | null {
  return ratio(s.tickets_checked_in, s.tickets_issued)
}

export function takeRate(s: BusinessSnapshot): number | null {
  return ratio(s.commission_paise, s.gmv_paise)
}

export function netGmvPaise(s: BusinessSnapshot): Paise {
  const net = s.gmv_paise - s.refunds_processed_paise
  assertPaise(net, 'netGmvPaise')
  return net
}

/**
 * Owed and settled, summed from the statements the console already computes
 * via listSettleableEvents — settle() stays the only interpreter of owed
 * money; these two numbers never get a second SQL definition. A paid row
 * contributes its FROZEN net (what left the bank); everything else — no
 * payout yet, or on hold — is still owed.
 */
export function payoutTotals(
  rows: Array<Pick<SettleableEvent, 'statement' | 'payout'>>,
): { owedPaise: Paise; settledPaise: Paise } {
  let owedPaise = 0
  let settledPaise = 0
  for (const row of rows) {
    if (row.payout?.status === 'paid') settledPaise += row.payout.net_paise
    else owedPaise += row.statement.netPaise
  }
  assertPaise(owedPaise, 'owedPaise')
  assertPaise(settledPaise, 'settledPaise')
  return { owedPaise, settledPaise }
}
