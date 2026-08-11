import { formatPaise } from '@/lib/money'

/**
 * The whole cutoff rule, in one tested place.
 *
 * The arithmetic is zone-free on purpose: starts_at is an absolute instant and
 * the cutoff is N hours before it, which no timezone can change. IST enters
 * only where humans do — the tests speak IST wall-clock via istLocalToUtc, and
 * the UI formats instants with lib/events/datetime.ts. India has no DST, so
 * there is no wall-clock trap hiding in the subtraction.
 */

export type CancelInitiator = 'attendee' | 'host'
export type RefundDecision = 'full' | 'none'

export function refundCutoffAt(startsAt: string, cutoffHours: number): Date {
  return new Date(new Date(startsAt).getTime() - cutoffHours * 60 * 60 * 1000)
}

export function refundDecision(input: {
  initiator: CancelInitiator
  startsAt: string
  cutoffHours: number
  now?: Date
}): RefundDecision {
  // The host is choosing to give the seat back; the clock never applies.
  if (input.initiator === 'host') return 'full'

  const cutoff = refundCutoffAt(input.startsAt, input.cutoffHours).getTime()
  const now = (input.now ?? new Date()).getTime()

  // Fail closed, the hasStarted precedent: NaN comparisons are all false, so
  // without this branch an unreadable start time would decide whichever way
  // the expression happened to be written. Money errs toward not moving.
  if (Number.isNaN(cutoff) || Number.isNaN(now)) return 'none'

  return now < cutoff ? 'full' : 'none'
}

/** The one-sentence policy the public event page and the booking page carry. */
export function refundPolicySentence(cutoffHours: number): string {
  if (cutoffHours === 0) return 'Free cancellation until the event starts.'
  return `Free cancellation until ${cutoffHours} h before start.`
}

/** What the cancel tap will do to the money, stated before the tap. Null when no money moved. */
export function cancelConsequence(input: {
  initiator: CancelInitiator
  totalPaise: number
  startsAt: string
  cutoffHours: number
  /** 'cash' means no money ever moved online, so there is nothing to promise. */
  paymentMode?: 'online' | 'cash'
  now?: Date
}): string | null {
  if (input.totalPaise === 0) return null
  if (input.paymentMode === 'cash') return null
  if (input.initiator === 'host') return `Removing refunds ${formatPaise(input.totalPaise)} in full.`
  return refundDecision(input) === 'full'
    ? `You'll be refunded ${formatPaise(input.totalPaise)}.`
    : 'Past the refund window — no refund.'
}
