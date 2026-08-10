import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Caller } from '@/lib/bookings/caller'
import type { PaymentProvider, ProviderPayment, ProviderPaymentStatus } from '@/lib/payments/provider'
import { razorpayProvider } from '@/lib/payments/razorpay'
import { mapPaymentRpcError } from '@/lib/payments/rpc-errors'
import type { Json } from '@/lib/supabase/types'

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

export type WebhookOutcome = 'processed' | 'duplicate'

type AdminDb = ReturnType<typeof createAdminClient>

/**
 * One processor, two feeders (this entry for the webhook route,
 * reconcileBooking for page loads and the sweep). The receipt goes down FIRST,
 * before any business logic — (provider, provider_event_id) is the dedup — and
 * every write below it is idempotent, so the same truth arriving twice, from
 * either feeder, lands once.
 *
 * Throws on processing failure ON PURPOSE, after stamping the receipt's error:
 * the route answers 500, Razorpay redelivers, and a redelivery is exactly what
 * a half-processed event needs.
 */
export async function processWebhookEvent(input: {
  providerEventId: string
  eventType: string
  payload: unknown
}): Promise<WebhookOutcome> {
  const db = createAdminClient()

  const { data: receipt, error: receiptError } = await db
    .from('provider_webhook_events')
    .upsert(
      {
        provider: 'razorpay',
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        payload: input.payload as Json,
      },
      { onConflict: 'provider,provider_event_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle()

  if (receiptError) throw new Error(`could not record the webhook receipt: ${receiptError.message}`)
  if (!receipt) return 'duplicate'

  try {
    switch (input.eventType) {
      case 'payment.captured':
      case 'payment.failed': {
        const entity = paymentEntity(input.payload)
        await applyPayment(db, entity, entity as unknown as Json)
        break
      }
      case 'refund.processed':
        await applyRefundEvent(db, refundEntity(input.payload), 'processed')
        break
      case 'refund.failed':
        await applyRefundEvent(db, refundEntity(input.payload), 'failed')
        break
      default:
        // We only subscribe to the four above; anything else is recorded in
        // the receipts table (raw payloads live forever) and needs no writes.
        break
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await db.from('provider_webhook_events').update({ error: message }).eq('id', receipt.id)
    throw cause
  }

  await db.from('provider_webhook_events').update({ processed_at: new Date().toISOString() }).eq('id', receipt.id)
  return 'processed'
}

/** payload.payment.entity, shape-checked — a verified sender can still drift its schema. */
function paymentEntity(payload: unknown): ProviderPayment {
  const entity = (payload as { payload?: { payment?: { entity?: Record<string, unknown> } } })?.payload?.payment?.entity
  const status = entity?.status as ProviderPaymentStatus
  if (
    !entity ||
    typeof entity.id !== 'string' ||
    typeof entity.order_id !== 'string' ||
    typeof entity.amount !== 'number' ||
    typeof status !== 'string'
  ) {
    throw new Error('malformed payment webhook payload')
  }
  return {
    paymentId: entity.id,
    orderId: entity.order_id,
    amountPaise: entity.amount,
    status,
    method: typeof entity.method === 'string' ? entity.method : null,
    errorCode: typeof entity.error_code === 'string' ? entity.error_code : null,
    errorDescription: typeof entity.error_description === 'string' ? entity.error_description : null,
  }
}

interface RefundEntityShape {
  refundId: string
  providerPaymentId: string
  amountPaise: number
}

function refundEntity(payload: unknown): RefundEntityShape {
  const entity = (payload as { payload?: { refund?: { entity?: Record<string, unknown> } } })?.payload?.refund?.entity
  if (!entity || typeof entity.id !== 'string' || typeof entity.payment_id !== 'string' || typeof entity.amount !== 'number') {
    throw new Error('malformed refund webhook payload')
  }
  return { refundId: entity.id, providerPaymentId: entity.payment_id, amountPaise: entity.amount }
}

/**
 * The single write path for a payment fact, whichever feeder carried it.
 * One payments row per order, last write wins — except that 'refunded' and
 * 'captured' never regress to 'failed' (Razorpay allows failed attempts and a
 * success against one order, delivered in any order).
 */
async function applyPayment(db: AdminDb, p: ProviderPayment, raw: Json): Promise<void> {
  if (p.status !== 'captured' && p.status !== 'failed') return // created/authorized: not terminal, nothing to record

  const { data: payment, error } = await db
    .from('payments')
    .select('id, booking_id, status, provider_payment_id, amount_paise')
    .eq('provider', 'razorpay')
    .eq('provider_order_id', p.orderId)
    .maybeSingle()
  if (error) throw new Error(`could not read the payments row: ${error.message}`)
  if (!payment) throw new Error(`no payments row for order ${p.orderId}`)

  if (p.status === 'failed') {
    if (payment.status === 'captured' || payment.status === 'refunded') return // stale news
    const { error: failError } = await db
      .from('payments')
      .update({
        provider_payment_id: p.paymentId,
        status: 'failed',
        method: p.method,
        error_code: p.errorCode,
        error_description: p.errorDescription,
        raw_payload: raw,
      })
      .eq('id', payment.id)
    if (failError) throw new Error(`could not record the failure: ${failError.message}`)
    return
  }

  // captured —
  const { data: booking, error: bookingError } = await db
    .from('bookings')
    .select('id, status, ticket_type_id, total_paise')
    .eq('id', payment.booking_id)
    .single()
  if (bookingError) throw new Error(`could not read the booking: ${bookingError.message}`)

  const { error: captureError } = await db
    .from('payments')
    .update({
      provider_payment_id: p.paymentId,
      // A capture never un-refunds: if refund.processed already landed, the
      // row keeps saying so and this write only fills the capture details.
      status: payment.status === 'refunded' ? 'refunded' : 'captured',
      method: p.method,
      error_code: null,
      error_description: null,
      raw_payload: raw,
    })
    .eq('id', payment.id)
  if (captureError) throw new Error(`could not record the capture: ${captureError.message}`)

  // The order amount is server-set, so a mismatch should be unreachable — the
  // EH021 "believed unreachable, one predicate" precedent. Record, stamp for
  // the sweep, admit nobody, answer 200 (a retry cannot fix a wrong amount).
  if (p.amountPaise !== booking.total_paise) {
    await db
      .from('payments')
      .update({
        error_code: 'amount_mismatch',
        error_description: `captured ${p.amountPaise} paise against a booking of ${booking.total_paise}`,
      })
      .eq('id', payment.id)
    console.error(`[payments] amount mismatch on order ${p.orderId}: ${p.amountPaise} vs ${booking.total_paise}`)
    return
  }

  // Force the expiry decision by the clock before looking at status — the
  // same inline call reserve_tickets makes. Without it, "expired" depends on
  // whether the sweeper happened to run.
  const { error: releaseError } = await db.rpc('release_expired_holds', { p_ticket_type_id: booking.ticket_type_id })
  if (releaseError) throw new Error(`could not settle expiries: ${releaseError.message}`)

  const { data: fresh, error: freshError } = await db.from('bookings').select('status').eq('id', booking.id).single()
  if (freshError) throw new Error(`could not re-read the booking: ${freshError.message}`)

  if (fresh.status === 'awaiting_payment') {
    const { error: confirmError } = await db.rpc('confirm_booking', { p_booking_id: booking.id })
    if (confirmError) throw new Error(`could not confirm booking ${booking.id}: ${confirmError.message}`)
    return
  }
  if (fresh.status === 'confirmed') return // replay of a done deal

  // expired or cancelled: money never sits against a seat that does not
  // exist. The booking's ending stands; the refund makes the dawdle harmless.
  await ensureRefund(
    db,
    { id: payment.id, provider_payment_id: p.paymentId, amount_paise: payment.amount_paise },
    'capture after the booking ended',
  )
}

/** At most one refund per payment; the unique provider_refund_id backstops this check. */
async function ensureRefund(
  db: AdminDb,
  payment: { id: string; provider_payment_id: string | null; amount_paise: number },
  reason: string,
): Promise<void> {
  const { data: existing, error: readError } = await db
    .from('refunds')
    .select('id')
    .eq('payment_id', payment.id)
    .maybeSingle()
  if (readError) throw new Error(`could not read refunds: ${readError.message}`)
  if (existing) return

  const { data: row, error: insertError } = await db
    .from('refunds')
    .insert({ payment_id: payment.id, amount_paise: payment.amount_paise, status: 'pending', reason })
    .select('id')
    .single()
  if (insertError) throw new Error(`could not create the refund row: ${insertError.message}`)

  await settleRefund(db, row.id, payment.provider_payment_id)
}

/**
 * The provider half of a refund, separated so the sweep can retry it. Never
 * throws: the row already says a refund is owed; a failed call leaves it
 * pending with no provider_refund_id, which is exactly what the sweep looks
 * for. Returns whether the provider call landed.
 */
async function settleRefund(db: AdminDb, refundId: string, providerPaymentId: string | null): Promise<boolean> {
  if (!providerPaymentId) return false
  try {
    const provider = razorpayProvider()
    const created = await provider.createRefund(providerPaymentId)
    const { error } = await db
      .from('refunds')
      .update({ provider_refund_id: created.refundId, status: created.status })
      .eq('id', refundId)
    if (error) throw new Error(error.message)
    return true
  } catch (cause) {
    console.error(`[payments] refund ${refundId} not sent yet; the sweep retries`, cause)
    return false
  }
}

/**
 * refund.processed / refund.failed move the row; the booking's ending was
 * decided at cancel time and does not change here. A refund with no row was
 * made outside the app (the Razorpay dashboard); it is recorded against the
 * payment so the books stay honest.
 */
async function applyRefundEvent(db: AdminDb, r: RefundEntityShape, status: 'processed' | 'failed'): Promise<void> {
  const { data: row, error } = await db.from('refunds').select('id').eq('provider_refund_id', r.refundId).maybeSingle()
  if (error) throw new Error(`could not read refunds: ${error.message}`)

  if (row) {
    const { error: updateError } = await db.from('refunds').update({ status }).eq('id', row.id)
    if (updateError) throw new Error(`could not move the refund: ${updateError.message}`)
  } else {
    const { data: payment, error: paymentError } = await db
      .from('payments')
      .select('id')
      .eq('provider_payment_id', r.providerPaymentId)
      .maybeSingle()
    if (paymentError) throw new Error(`could not read payments: ${paymentError.message}`)
    if (!payment) throw new Error(`refund ${r.refundId} names a payment this app never saw`)
    const { error: insertError } = await db.from('refunds').insert({
      payment_id: payment.id,
      provider_refund_id: r.refundId,
      amount_paise: r.amountPaise,
      status,
      reason: 'created outside the app',
    })
    if (insertError) throw new Error(`could not record the outside refund: ${insertError.message}`)
  }

  if (status === 'processed') {
    const { error: flipError } = await db
      .from('payments')
      .update({ status: 'refunded' })
      .eq('provider_payment_id', r.providerPaymentId)
    if (flipError) throw new Error(`could not mark the payment refunded: ${flipError.message}`)
  }
}

