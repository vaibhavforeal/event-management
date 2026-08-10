import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Caller } from '@/lib/bookings/caller'
import type { PaymentProvider } from '@/lib/payments/provider'
import { razorpayProvider } from '@/lib/payments/razorpay'
import { mapPaymentRpcError } from '@/lib/payments/rpc-errors'

/**
 * The third — and last — file permitted to import lib/supabase/admin.ts,
 * beside lib/bookings/service.ts and lib/checkin/service.ts. The ESLint fence
 * in eslint.config.mjs names all three. RLS grants no client any write to
 * payments, refunds or provider_webhook_events; every authorisation decision
 * in this module is therefore the entire rule. Identity is a Caller
 * throughout — never an id read from a form.
 */

export type CheckoutStart = { ok: true; reference: string } | { ok: false; error: string }

const NOT_CONFIGURED = 'Payments are not set up on this server yet.'
const COULD_NOT_START = 'Could not start the payment. Nothing was charged — please try again.'

/**
 * The paid mirror of bookFreeTickets, stopping at the hold: guards + reserve
 * in begin_paid_booking, then a Razorpay order for exactly total_paise, then
 * the payments row that the webhook processor will complete. If the order or
 * the insert fails the hold is cancelled immediately — an attendee must never
 * sit out a 10-minute hold for a checkout that cannot happen.
 */
export async function startPaidCheckout(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
): Promise<CheckoutStart> {
  let provider: PaymentProvider
  try {
    provider = razorpayProvider()
  } catch (error) {
    // Loudly, per the spec: the sentence for the attendee, the cause for the log.
    console.error('[payments] startPaidCheckout refused: Razorpay env vars missing', error)
    return { ok: false, error: NOT_CONFIGURED }
  }

  const db = createAdminClient()

  const { data: booking, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: ticketTypeId,
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
  })

  if (error) return { ok: false, error: mapPaymentRpcError(error) }

  try {
    const order = await provider.createOrder({
      amountPaise: booking.total_paise,
      receipt: booking.reference,
      notes: { booking_reference: booking.reference },
    })
    const { error: insertError } = await db.from('payments').insert({
      booking_id: booking.id,
      provider: 'razorpay',
      provider_order_id: order.orderId,
      amount_paise: booking.total_paise,
      status: 'created',
    })
    if (insertError) throw new Error(`could not record the order: ${insertError.message}`)
  } catch (cause) {
    console.error('[payments] checkout could not start; cancelling the hold', cause)
    // Best effort: if this cancel itself fails, the 10-minute hold and the
    // sweep still return the seats. The attendee sees one sentence either way.
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'checkout could not start' })
    return { ok: false, error: COULD_NOT_START }
  }

  return { ok: true, reference: booking.reference }
}
