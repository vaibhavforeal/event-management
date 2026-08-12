import { assertPaise, type Paise } from '@/lib/money'

/**
 * What a host is owed for one event, derived from state.
 *
 * Pure on purpose, following lib/notifications/sweep.ts: handed rows, it
 * returns the statement. No database, no clock, no provider — so the whole of
 * the money math is testable in milliseconds, which is the only reasonable
 * posture for the code that decides what leaves a bank account.
 *
 * Commission is read from bookings.commission_paise and from nowhere else —
 * not from hosts.commission_bps, not from fee_rules, not from lib/pricing.
 * Every booking path writes 0 today. That is why this module is correct at the
 * pilot's zero and still correct the day fees turn on, with no change here.
 */

/**
 * A booking with its money facts already attached. The two booleans are a
 * query concern, not a counting rule: the admin path derives them from rows it
 * may read (joinPaymentFacts below), and the host path receives them from
 * host_settlement_rows(), because a host may not read `payments` at all —
 * 20260808000003_rls_policies.sql:157 is explicit that they get aggregates
 * instead. Two routes in, one implementation of the arithmetic.
 */
export interface SettlementBooking {
  id: string
  status: string
  payment_mode: 'online' | 'cash'
  subtotal_paise: number
  commission_paise: number
  has_captured_payment: boolean
  /** Any refund row against the booking's payment, whatever its own status. */
  has_refund: boolean
}

export interface RawPayment {
  id: string
  booking_id: string
  status: string
}

export interface RawRefund {
  payment_id: string
}

export interface Statement {
  /** Face value of every counted booking — the host's money. */
  grossPaise: Paise
  /** The platform's cut, summed from the booking rows. Zero across the pilot. */
  commissionPaise: Paise
  /** gross - commission. Matches the payouts_net_is_consistent CHECK. */
  netPaise: Paise
  /** A SUBSET of gross, not an addend: seats cancelled past the cutoff. */
  forfeitedPaise: Paise
  /** Collected by the host at the door. Never part of a payout. */
  cashPaise: Paise
  countedBookingIds: string[]
}

/** Attaches the two money facts to bookings, for callers that may read payments. */
export function joinPaymentFacts(
  bookings: Array<Omit<SettlementBooking, 'has_captured_payment' | 'has_refund'>>,
  payments: RawPayment[],
  refunds: RawRefund[],
): SettlementBooking[] {
  // Any refund row at all disqualifies, whatever its own status. A 'failed'
  // refund may mean the money is still ours, and we still decline to pay it.
  const refundedPaymentIds = new Set(refunds.map((refund) => refund.payment_id))

  const capturedByBooking = new Map<string, RawPayment>()
  for (const payment of payments) {
    if (payment.status === 'captured' && !capturedByBooking.has(payment.booking_id)) {
      capturedByBooking.set(payment.booking_id, payment)
    }
  }

  return bookings.map((booking) => {
    const payment = capturedByBooking.get(booking.id)
    return {
      ...booking,
      has_captured_payment: payment !== undefined,
      has_refund: payment !== undefined && refundedPaymentIds.has(payment.id),
    }
  })
}

/**
 * Counting rules (what enters gross):
 * - confirmed, online, has_captured_payment, !has_refund → YES (ordinary case)
 * - cancelled, has_captured_payment, !has_refund → YES + forfeitedPaise (cancelled past cutoff, money kept)
 * - confirmed, cash → NO (into cashPaise; host already holds it)
 * - confirmed, online, has_refund → NO (refund row exists but status not yet flipped; window condition)
 * - refunded (any refund status) → NO (money went back)
 * - confirmed, online, !has_captured_payment → NO (we don't pay out money we don't hold)
 * - pending_approval, awaiting_payment, expired, waitlisted → NO (no money ever moved)
 */
export function settle(bookings: SettlementBooking[]): Statement {
  let grossPaise = 0
  let commissionPaise = 0
  let forfeitedPaise = 0
  let cashPaise = 0
  const countedBookingIds: string[] = []

  for (const booking of bookings) {
    assertPaise(booking.subtotal_paise, `booking ${booking.id} subtotal_paise`)
    assertPaise(booking.commission_paise, `booking ${booking.id} commission_paise`)

    if (booking.payment_mode === 'cash') {
      // The host took this at the door. It is reported so a statement
      // reconciles, and it never enters gross — paying it out would be paying
      // the host money they are already holding.
      if (booking.status === 'confirmed') cashPaise += booking.subtotal_paise
      continue
    }

    if (!booking.has_captured_payment) continue

    const isOrdinary = booking.status === 'confirmed' && !booking.has_refund
    const isForfeit = booking.status === 'cancelled' && !booking.has_refund
    if (!isOrdinary && !isForfeit) continue

    grossPaise += booking.subtotal_paise
    commissionPaise += booking.commission_paise
    if (isForfeit) forfeitedPaise += booking.subtotal_paise
    countedBookingIds.push(booking.id)
  }

  assertPaise(grossPaise, 'grossPaise')
  assertPaise(commissionPaise, 'commissionPaise')
  const netPaise = grossPaise - commissionPaise
  assertPaise(netPaise, 'netPaise')

  return { grossPaise, commissionPaise, netPaise, forfeitedPaise, cashPaise, countedBookingIds }
}
