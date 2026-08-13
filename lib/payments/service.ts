import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Caller } from '@/lib/bookings/caller'
import type { PaymentProvider, ProviderPayment, ProviderPaymentStatus } from '@/lib/payments/provider'
import { razorpayProvider } from '@/lib/payments/razorpay'
import type { CancelInitiator } from '@/lib/payments/refund-policy'
import { refundDecision } from '@/lib/payments/refund-policy'
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

export type ApprovedCheckoutStart = { ok: true } | { ok: false; error: string }

/** One refusal for "not yours", "does not exist" and "the lookup failed". */
const NOT_YOURS_TO_PAY = 'That booking is not yours to pay for.'
const NOT_PAYABLE = 'There is nothing to pay on this booking right now.'

/**
 * The missing piece between an approval and the Phase 3 rails: the Razorpay
 * order, created lazily on the explicit Pay tap — never on a page load — for
 * a booking approve_booking left awaiting_payment. Once the payments row
 * exists, the existing CheckoutPanel, first-poll proof, webhook and
 * reconcile paths run unchanged.
 *
 * Idempotent by the payments_one_per_booking index: a second tap (or a lost
 * race) finds or collides with the existing row and reports ok — one order
 * per booking's lifetime, Phase 3's rule.
 *
 * Unlike startPaidCheckout, a failure here never cancels the booking: the
 * approval hold is the host's yes, and it must survive a Razorpay outage so
 * the attendee can retry inside the 24-hour window.
 */
export async function beginApprovedCheckout(
  caller: Caller,
  bookingId: string,
): Promise<ApprovedCheckoutStart> {
  let provider: PaymentProvider
  try {
    provider = razorpayProvider()
  } catch (error) {
    console.error('[payments] beginApprovedCheckout refused: Razorpay env vars missing', error)
    return { ok: false, error: NOT_CONFIGURED }
  }

  const db = createAdminClient()

  const { data: booking, error } = await db
    .from('bookings')
    .select('id, attendee_id, status, total_paise, reference, approved_at, payment_mode, hold_expires_at')
    .eq('id', bookingId)
    .maybeSingle()
  if (error) {
    console.error('[payments] could not read the booking for an approved checkout', error)
    return { ok: false, error: NOT_YOURS_TO_PAY }
  }
  // Same answer for missing and not-theirs — no oracle for strangers.
  if (!booking || booking.attendee_id !== caller.id) return { ok: false, error: NOT_YOURS_TO_PAY }

  if (
    booking.status !== 'awaiting_payment' ||
    !booking.approved_at ||
    booking.payment_mode !== 'online' ||
    !booking.hold_expires_at ||
    new Date(booking.hold_expires_at).getTime() <= Date.now()
  ) {
    return { ok: false, error: NOT_PAYABLE }
  }

  const { data: existing, error: existingError } = await db
    .from('payments')
    .select('id')
    .eq('booking_id', booking.id)
    .maybeSingle()
  if (existingError) {
    console.error('[payments] could not read payments for an approved checkout', existingError)
    return { ok: false, error: COULD_NOT_START }
  }
  if (existing) return { ok: true }

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
    if (insertError) {
      // Two taps raced past the read: payments_one_per_booking let exactly
      // one insert win, and the loser's order dies unpaid at Razorpay. The
      // attendee has an order either way.
      if (insertError.code === '23505') return { ok: true }
      throw new Error(`could not record the order: ${insertError.message}`)
    }
  } catch (cause) {
    console.error('[payments] approved checkout could not start; the Pay button retries', cause)
    return { ok: false, error: COULD_NOT_START }
  }

  return { ok: true }
}

export type WebhookOutcome = 'processed' | 'duplicate'

type AdminDb = ReturnType<typeof createAdminClient>

/**
 * One processor, two feeders (this entry for the webhook route,
 * reconcileBooking for page loads and the sweep). The receipt goes down FIRST,
 * before any business logic — and the dedup on (provider, provider_event_id)
 * is a dedup of COMPLETED processing, not of receipt existence: an event whose
 * receipt exists but never earned a processed_at is a half-processed event,
 * and its redelivery runs the dispatch again. Every write below the receipt is
 * idempotent, so the same truth arriving twice, from either feeder, lands once.
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

  let receiptId: string
  if (receipt) {
    receiptId = receipt.id
  } else {
    // The receipt exists from an earlier delivery. Finished then? Duplicate.
    // Never finished — the error stamp answered 500 and this is the promised
    // redelivery? Run the dispatch again on the same receipt.
    const { data: existing, error: existingError } = await db
      .from('provider_webhook_events')
      .select('id, processed_at')
      .eq('provider', 'razorpay')
      .eq('provider_event_id', input.providerEventId)
      .single()
    if (existingError) throw new Error(`could not read the webhook receipt: ${existingError.message}`)
    if (existing.processed_at) return 'duplicate'
    receiptId = existing.id
  }

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
    await db.from('provider_webhook_events').update({ error: message }).eq('id', receiptId)
    throw cause
  }

  // error: null because a redelivery may be completing an attempt that
  // stamped one — the receipt should read as settled, not as both.
  await db
    .from('provider_webhook_events')
    .update({ processed_at: new Date().toISOString(), error: null })
    .eq('id', receiptId)
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
  let outcome = fresh.status

  if (outcome === 'awaiting_payment') {
    const { error: confirmError } = await db.rpc('confirm_booking', { p_booking_id: booking.id })
    if (!confirmError) return
    if (!isLostConfirmRace(confirmError)) {
      throw new Error(`could not confirm booking ${booking.id}: ${confirmError.message}`)
    }
    // TOCTOU, closed: between the status read above and confirm_booking's
    // FOR UPDATE, a concurrent delivery or the sweeper ended the booking —
    // release_expired_holds SKIP-LOCKs past a row its winner already holds,
    // so our "force the expiry" call can decide nothing and our read stays
    // stale. The refusal is the lock telling us we lost. Read the settled
    // outcome and handle it exactly as if we had seen it first, instead of
    // answering 500 and leaving the window to the provider's retry.
    const { data: after, error: afterError } = await db
      .from('bookings')
      .select('status')
      .eq('id', booking.id)
      .single()
    if (afterError) {
      throw new Error(`could not re-read booking ${booking.id} after a lost confirm race: ${afterError.message}`)
    }
    outcome = after.status
    if (outcome === 'awaiting_payment') {
      // The refusal proves it was not awaiting_payment under the lock;
      // reading it again means a third transition mid-flight. Let the
      // provider retry find it settled.
      throw new Error(`booking ${booking.id} kept changing during confirmation; leaving it to the retry`)
    }
  }

  if (outcome === 'confirmed') return // replay of a done deal, or the race's winner confirmed it

  // expired or cancelled (or already refunded — ensureRefund's pre-read makes
  // that replay a no-op): money never sits against a seat that does not
  // exist. The booking's ending stands; the refund makes the dawdle harmless.
  await ensureRefund(
    db,
    { id: payment.id, provider_payment_id: p.paymentId, amount_paise: payment.amount_paise },
    'capture after the booking ended',
  )
}

/**
 * confirm_booking's own refusal, and only that: check_violation carrying the
 * function's sentence means the booking's status moved between our read and
 * its FOR UPDATE. Anything else — connection failures, missing rows, a real
 * constraint violation — keeps throwing and keeps the 500-retry contract.
 */
function isLostConfirmRace(error: { code?: string; message?: string }): boolean {
  return error.code === '23514' && (error.message ?? '').includes('cannot confirm a booking with status')
}

/**
 * At most one refund per payment. The refunds_one_per_payment unique index is
 * the guarantee — two feeders carrying the same capture under fresh event ids
 * both reach this function, and the upsert lets exactly one of them win. The
 * pre-read is just the fast path: it saves an upsert round-trip on the common
 * replay of an already-refunded capture.
 */
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
    .upsert(
      { payment_id: payment.id, amount_paise: payment.amount_paise, status: 'pending', reason },
      { onConflict: 'payment_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle()
  if (insertError) throw new Error(`could not create the refund row: ${insertError.message}`)
  if (!row) return // another feeder won the race; its settleRefund handles the provider call

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
 * Money, after the seat. Called by lib/bookings/service.cancelBooking once
 * cancel_booking has freed the inventory — both cancel surfaces keep that one
 * front door. Looks for a captured payment (none: free bookings and abandoned
 * checkouts cost nothing extra), applies the pure cutoff rule, creates at most
 * one refund, and flips the booking to 'refunded' — at refund creation, not at
 * Razorpay settlement, because the attendee's seat decision is final at cancel
 * time.
 *
 * Never throws: the cancel already succeeded, and a refund that could not be
 * sent is a pending row the sweep retries, not a reason to tell the attendee
 * their cancel failed.
 */
export async function refundIfOwed(bookingId: string, initiator: CancelInitiator): Promise<void> {
  try {
    const db = createAdminClient()

    const { data: booking, error } = await db
      .from('bookings')
      .select('id, status, events(starts_at, refund_cutoff_hours)')
      .eq('id', bookingId)
      .maybeSingle()
    if (error || !booking) {
      console.error('[payments] could not read the booking for a refund decision', error)
      return
    }

    const { data: payment, error: paymentError } = await db
      .from('payments')
      .select('id, provider_payment_id, amount_paise')
      .eq('booking_id', bookingId)
      .eq('status', 'captured')
      .maybeSingle()
    if (paymentError) {
      console.error('[payments] could not read payments for a refund decision', paymentError)
      return
    }
    if (!payment) return

    const decision = refundDecision({
      initiator,
      startsAt: booking.events.starts_at,
      cutoffHours: booking.events.refund_cutoff_hours,
    })
    if (decision === 'none') return

    await ensureRefund(db, payment, `cancelled by ${initiator}`)

    // 'refunded' means "refund created", not "settled" — settlement lag lives
    // in refunds.status. Scoped to 'cancelled' so a replayed call is a no-op.
    const { error: flipError } = await db
      .from('bookings')
      .update({ status: 'refunded' })
      .eq('id', bookingId)
      .eq('status', 'cancelled')
    if (flipError) console.error('[payments] refund created but the booking still says cancelled', flipError)
  } catch (cause) {
    console.error('[payments] refundIfOwed failed; the money state is inspectable in payments/refunds', cause)
  }
}

/**
 * refund.processed / refund.failed move the row; the booking's ending was
 * decided at cancel time and does not change here. A refund id we have never
 * stored does NOT always mean a new row: the payment may already carry one —
 * our own pending intent whose provider call never landed (or landed without
 * its row update), now settled from the Razorpay dashboard or by a lost
 * settle. That row is CLAIMED — provider_refund_id and status written onto it
 * — so the books converge and refunds_one_per_payment holds. Only a payment
 * with no refund row at all gets an insert.
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

    const { data: pending, error: pendingError } = await db
      .from('refunds')
      .select('id')
      .eq('payment_id', payment.id)
      .maybeSingle()
    if (pendingError) throw new Error(`could not read refunds: ${pendingError.message}`)

    if (pending) {
      const { error: claimError } = await db
        .from('refunds')
        .update({ provider_refund_id: r.refundId, status })
        .eq('id', pending.id)
      if (claimError) throw new Error(`could not claim the pending refund: ${claimError.message}`)
    } else {
      const { error: insertError } = await db.from('refunds').insert({
        payment_id: payment.id,
        provider_refund_id: r.refundId,
        amount_paise: r.amountPaise,
        status,
        reason: 'created outside the app',
      })
      if (insertError) throw new Error(`could not record the outside refund: ${insertError.message}`)
    }
  }

  if (status === 'processed') {
    const { error: flipError } = await db
      .from('payments')
      .update({ status: 'refunded' })
      .eq('provider_payment_id', r.providerPaymentId)
    if (flipError) throw new Error(`could not mark the payment refunded: ${flipError.message}`)
  }
}

/**
 * The second feeder. Fetches the order's payments from Razorpay and pushes
 * them through the same applyPayment the webhook route uses; the unique
 * constraints make double-application a no-op. Never throws — its callers are
 * a page render and the sweep, and healing must not take either down.
 *
 * A useful side effect: local dev and the physical-phone test can complete a
 * paid booking WITHOUT a webhook tunnel — this does the same work the webhook
 * would have.
 */
export async function reconcileBooking(bookingId: string): Promise<void> {
  try {
    const db = createAdminClient()
    const { data: payment, error } = await db
      .from('payments')
      .select('provider_order_id')
      .eq('booking_id', bookingId)
      .maybeSingle()
    if (error || !payment) return

    const provider = razorpayProvider()
    const attempts = await provider.listOrderPayments(payment.provider_order_id)

    // One row per order, last write wins — and a capture outranks any failure,
    // so apply at most one terminal fact, preferring the capture.
    const terminal = attempts.find((a) => a.status === 'captured') ?? attempts.find((a) => a.status === 'failed')
    if (!terminal) return

    await applyPayment(db, terminal, terminal as unknown as Json)
  } catch (cause) {
    console.error('[payments] reconcile failed; the webhook or the sweep will try again', cause)
  }
}

/**
 * The first status poll after the sheet reports success carries
 * {payment_id, signature}. Verifying that checkout signature — against OUR
 * stored order id, never the client's — earns an immediate reconcile, so
 * confirmation does not wait on webhook latency; the write is still made from
 * Razorpay's API answer, never from the client's claim.
 */
export async function reconcileAfterCheckout(
  bookingId: string,
  attempt: { paymentId: string; signature: string },
): Promise<void> {
  try {
    const db = createAdminClient()
    const { data: payment } = await db
      .from('payments')
      .select('provider_order_id')
      .eq('booking_id', bookingId)
      .maybeSingle()
    if (!payment) return

    const provider = razorpayProvider()
    const genuine = provider.verifyCheckoutSignature({
      orderId: payment.provider_order_id,
      paymentId: attempt.paymentId,
      signature: attempt.signature,
    })
    if (!genuine) {
      console.warn('[payments] checkout signature did not verify; waiting for the webhook')
      return
    }
    await reconcileBooking(bookingId)
  } catch (cause) {
    console.error('[payments] post-checkout reconcile failed; the webhook will land', cause)
  }
}

/**
 * The where-nobody-is-looking sweep. Three arms: lapsed holds that have an
 * order (a dropped webhook may hide a capture), then a global release of pure
 * abandonments, then refunds owed but not yet sent.
 *
 * Scheduled since Phase 4 — app/api/cron/route.ts runs it FIRST on the tick
 * Vercel Cron invokes, ahead of the notification sweep, because a booking this
 * confirms is a booking that sweep then owes a message; running it after would
 * hold that message back a whole interval. `npm run reconcile` remains the
 * by-hand way to run it against a local stack. Still no pg_cron: one scheduler
 * is enough, and the one that already exists can be read in TypeScript.
 */
export async function runReconciliationSweep(): Promise<{
  reconciled: number
  released: number
  refundsRetried: number
}> {
  const db = createAdminClient()

  const { data: stale, error: staleError } = await db
    .from('bookings')
    .select('id, payments(id)')
    .eq('status', 'awaiting_payment')
    .lt('hold_expires_at', new Date().toISOString())
  if (staleError) throw new Error(`the sweep could not list lapsed holds: ${staleError.message}`)

  let reconciled = 0
  for (const booking of stale ?? []) {
    if (booking.payments.length === 0) continue // no order was ever created; release below
    await reconcileBooking(booking.id)
    reconciled += 1
  }

  const { data: released, error: releaseError } = await db.rpc('release_expired_holds')
  if (releaseError) throw new Error(`the sweep could not release holds: ${releaseError.message}`)

  const { data: stuck, error: stuckError } = await db
    .from('refunds')
    .select('id, payments(provider_payment_id)')
    .eq('status', 'pending')
    .is('provider_refund_id', null)
  if (stuckError) throw new Error(`the sweep could not list stuck refunds: ${stuckError.message}`)

  let refundsRetried = 0
  for (const refund of stuck ?? []) {
    if (await settleRefund(db, refund.id, refund.payments.provider_payment_id)) refundsRetried += 1
  }

  return { reconciled, released: released ?? 0, refundsRetried }
}

