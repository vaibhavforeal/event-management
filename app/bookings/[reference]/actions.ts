'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { loginPath } from '@/lib/auth/session'
import { getBookingByReference } from '@/lib/bookings/queries'
import { claimOfferedSeat } from '@/lib/bookings/service'
import { beginApprovedCheckout, reconcileAfterCheckout } from '@/lib/payments/service'

/** The booking reference alphabet (Crockford-ish base32, no I L O U). */
const REFERENCE_PATTERN = /^[0-9A-HJ-NP-TV-Z]{8}$/
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]+$/

export interface BookingStatus {
  status: string
}

/**
 * The small status action the checkout page polls. The first poll after the
 * sheet's success handler carries {payment_id, signature}; the service
 * verifies that proof and reconciles from Razorpay's API — the client's claim
 * triggers a lookup, never a write. Every later poll is a plain RLS read.
 */
export async function pollBookingStatus(
  reference: string,
  attempt?: { paymentId: string; signature: string },
): Promise<BookingStatus> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  if (!REFERENCE_PATTERN.test(reference)) return { status: 'unknown' }

  const booking = await getBookingByReference(reference)
  if (!booking) return { status: 'unknown' }

  if (
    attempt &&
    booking.status === 'awaiting_payment' &&
    PAYMENT_ID_PATTERN.test(attempt.paymentId) &&
    typeof attempt.signature === 'string'
  ) {
    await reconcileAfterCheckout(booking.id, { paymentId: attempt.paymentId, signature: attempt.signature })
    const after = await getBookingByReference(reference)
    return { status: after?.status ?? 'unknown' }
  }

  return { status: booking.status }
}

export interface ApprovedPayState {
  error?: string
}

/**
 * The Pay tap on an approved booking. Orders are created here, on the
 * explicit action — never on a page load — and the service re-checks that
 * the caller IS the attendee: getBookingByReference deliberately also
 * resolves for the event's host, and a host must not be able to open an
 * order against a guest's approval.
 */
export async function startApprovedPayment(
  _previous: ApprovedPayState,
  formData: FormData,
): Promise<ApprovedPayState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const reference = String(formData.get('reference') ?? '')
  if (!REFERENCE_PATTERN.test(reference)) {
    return { error: 'Something went wrong. Reload the page and try again.' }
  }

  const booking = await getBookingByReference(reference)
  if (!booking) return { error: 'Something went wrong. Reload the page and try again.' }

  const result = await beginApprovedCheckout(caller, booking.id)
  if (!result.ok) return { error: result.error }

  // The payments row now exists; the server re-render mounts CheckoutPanel.
  revalidatePath(`/bookings/${reference}`)
  return {}
}

export interface ClaimState {
  error?: string
}

/**
 * The Claim tap on a free or cash seat offer — the twin of startApprovedPayment,
 * for the offers that have no online money to ask for.
 *
 * Same posture: the reference is shape-checked before it is used, the booking
 * is resolved through the RLS read, and the service re-checks that the caller
 * IS the attendee. getBookingByReference deliberately also resolves for the
 * event's host, and a host must not be able to accept a seat on a guest's
 * behalf — accepting is the guest's to do.
 */
export async function claimSeat(
  _previous: ClaimState,
  formData: FormData,
): Promise<ClaimState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const reference = String(formData.get('reference') ?? '')
  if (!REFERENCE_PATTERN.test(reference)) {
    return { error: 'Something went wrong. Reload the page and try again.' }
  }

  const booking = await getBookingByReference(reference)
  if (!booking) return { error: 'Something went wrong. Reload the page and try again.' }

  const result = await claimOfferedSeat(caller, booking.id)
  if (!result.ok) return { error: result.error }

  // The seat is confirmed and tickets exist, so this page owes a QR — and the
  // list owes a status that is no longer "in line".
  revalidatePath(`/bookings/${reference}`)
  revalidatePath('/bookings')
  return {}
}
