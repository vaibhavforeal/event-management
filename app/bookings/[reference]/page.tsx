import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { currentCaller } from '@/lib/bookings/caller'
import { getBookingByReference } from '@/lib/bookings/queries'
import { waitlistPosition } from '@/lib/bookings/service'
import {
  approvedPaySentence,
  LAPSED_OFFER_SENTENCE,
  offerClaimSentence,
  offerPaySentence,
  waitlistPositionLine,
} from '@/lib/bookings/waitlist-copy'
import { serverEnv } from '@/lib/env'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { refundPolicySentence } from '@/lib/payments/refund-policy'
import { reconcileBooking } from '@/lib/payments/service'
import { ticketQrSvg } from '@/lib/tickets/qr'
import { listBookingTickets } from '@/lib/tickets/queries'
import { CancelButton } from '../cancel-button'
import { ApprovedPayPanel } from './approved-pay-panel'
import { CheckoutPanel } from './checkout-panel'
import { ClaimSeatPanel } from './claim-seat-panel'

// Not "Your booking": getBookingByReference deliberately also resolves for the
// host of the event, who is looking at somebody else's.
export const metadata = { title: 'Booking' }

/**
 * One ending, one sentence. Every booking status the schema can produce has an
 * entry, so the fallback below it is for a status this page has never heard of
 * — a migration ahead of a deploy — not for anything routine.
 */
const STATUS_LINE: Record<string, string> = {
  confirmed: "You're going",
  awaiting_payment: 'Complete your payment',
  pending_approval: 'Request sent — the host will review it',
  waitlisted: "You're in line",
  expired: 'This booking expired — nothing was charged',
  cancelled: 'Booking cancelled',
  refunded: 'Booking cancelled — refund on its way',
}

/**
 * Whether the payment hold is still live. A function rather than an inline
 * `Date.now()` at the call site because `react-hooks/purity` rejects a clock
 * read in a component body — the same trade `hasStarted` documents in
 * lib/events/datetime.ts: this page is an async Server Component that renders
 * once per request, so reading the clock per render is exactly right, and a
 * named function is a better answer to the rule than a suppression comment.
 *
 * Fails closed: an unreadable hold_expires_at is NaN, every comparison against
 * NaN is false, and "not live" costs a missing pay button rather than a
 * checkout against a deadline nobody can read.
 */
function holdIsLive(holdExpiresAt: string | null): boolean {
  return !!holdExpiresAt && new Date(holdExpiresAt).getTime() > Date.now()
}

export default async function BookingPage(props: PageProps<'/bookings/[reference]'>) {
  const { reference } = await props.params
  const user = await requireUser()

  let booking = await getBookingByReference(reference)
  // RLS already refused someone else's booking, so "not found" and "not yours"
  // arrive here as the same thing — which is what we want them to look like.
  if (!booking) notFound()

  // The page-load heal: a dropped webhook fixed exactly where someone is
  // staring at "payment pending". Only when an order actually exists — a
  // paid hold with no payments row has nothing to reconcile against — and
  // reconcileBooking never throws, so a Razorpay outage costs this render
  // nothing but a log line. Refetched after, because the heal may have just
  // confirmed or expired the booking; re-guarded, because notFound() is how
  // this page answers a read that stopped resolving.
  if (booking.status === 'awaiting_payment' && booking.payments.length > 0) {
    await reconcileBooking(booking.id)
    booking = await getBookingByReference(reference)
    if (!booking) notFound()
  }

  const event = booking.events

  const tickets = event
    ? await listBookingTickets(booking.id)
    : [] // no event id → no key to derive; the reference is still the fallback
  const qrs = await Promise.all(
    tickets.map((t) => ticketQrSvg(serverEnv().TICKET_SIGNING_SECRET, event!.id, t.code)),
  )

  // The checkout panel mounts only while there is something to pay for: an
  // awaiting_payment booking whose Razorpay order exists, whose hold is still
  // live, on a server that has keys. Optional() in lib/env.ts means keyId can
  // be absent; the panel without a key would be a button that cannot open.
  const payment = booking.payments[0] ?? null
  const keyId = serverEnv().RAZORPAY_KEY_ID
  const holdLive = holdIsLive(booking.hold_expires_at)

  // Load-bearing, not a nicety: the payments embed is RLS-scoped to the
  // attendee, so it is [] for a host viewing a guest's booking — without this
  // guard, "no order yet" below would show the HOST a Pay button for someone
  // else's approval.
  const isAttendee = booking.attendee_id === user.id

  // Which queue this booking came from decides what an approved_at row means.
  // The two flags are mutually exclusive (events_one_queue), so this is a
  // clean either/or rather than a precedence question.
  const isWaitlistEvent = !!event?.has_waitlist
  const isOffer = booking.status === 'awaiting_payment' && !!booking.approved_at && isWaitlistEvent
  const lapsedOffer = booking.status === 'expired' && !!booking.approved_at && isWaitlistEvent
  // An offer with nothing to pay online is claimed, not paid: cash settles at
  // the door and free settles nowhere. Never true on an approval event —
  // approve_booking confirms both of those straight through — but derived from
  // the booking rather than the event, so it stays right if that ever changes.
  const claimable = booking.payment_mode === 'cash' || booking.total_paise === 0

  // Where they stand in the line. currentCaller() rather than the `user`
  // above because waitlistPosition takes a Caller, which only that module can
  // mint; requireUser() has already established there is one.
  const caller = await currentCaller()
  const position =
    caller && booking.status === 'waitlisted' ? await waitlistPosition(caller, booking.id) : null

  // The declined ending is a cancel with a particular stored reason — the same
  // prose-as-fact pattern the initiator uses in cancel_booking.
  const statusLine =
    booking.status === 'cancelled' && booking.cancellation_reason === 'declined by host'
      ? "The host couldn't fit you in this time"
      : isOffer
        ? 'A seat opened up for you'
        : lapsedOffer
          ? 'Your seat offer expired'
          : (STATUS_LINE[booking.status] ?? `Booking ${booking.status}`)

  // The address joins the Where row only once the viewer is entitled — this is
  // what makes hide_venue_until_approved's public-page promise true.
  const venueRevealed =
    !event?.hide_venue_until_approved || !!booking.approved_at || booking.status === 'confirmed'

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <p className="font-mono text-[13px] tracking-wide text-muted">{statusLine}</p>

      <h1 className="mt-2 text-2xl font-semibold break-words">{event?.title ?? 'Event'}</h1>

      <dl className="mt-8 space-y-4 font-mono text-[14px]">
        <div>
          <dt className="text-muted">Reference</dt>
          {/* The string a host reads aloud at the door. Big, and selectable. */}
          <dd className="text-[22px] font-semibold tracking-[0.2em] select-all">
            {booking.reference}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Seats</dt>
          <dd>{booking.quantity}</dd>
        </div>
        {/* The whole block is conditional because the embed is nullable in the
            type: a booking whose event row has gone still has a reference and a
            seat count worth showing, and half a "When / Where" pair is worse
            than none. */}
        {event && (
          <>
            <div>
              <dt className="text-muted">When</dt>
              {/* formatIst takes a Date; starts_at arrives as an ISO string. */}
              <dd>{formatIst(new Date(event.starts_at))}</dd>
            </div>
            <div>
              <dt className="text-muted">Where</dt>
              <dd className="break-words">
                {[event.venue_name, event.city].filter(Boolean).join(', ')}
                {event.venue_address && venueRevealed && (
                  <p className="text-muted text-[13px] break-words">{event.venue_address}</p>
                )}
              </dd>
            </div>
          </>
        )}
      </dl>

      {booking.status === 'pending_approval' && booking.attendee_note && (
        <p className="text-muted mt-4 text-sm">Your note to the host: “{booking.attendee_note}”</p>
      )}

      {booking.status === 'waitlisted' && (
        <section className="mt-6">
          {position !== null && (
            <p className="text-[15px]">{waitlistPositionLine(position, booking.quantity)}</p>
          )}
          <p className="text-muted mt-1 text-sm">
            Nothing is charged unless a seat opens for you. You&rsquo;ll have 24 hours to take it.
          </p>
          {isAttendee && (
            <CancelButton
              bookingId={booking.id}
              slug={event?.slug ?? ''}
              label="Leave the waitlist"
              /* No money moved and no seat was held, so there is no
                 consequence to state — cancelConsequence would return null for
                 this row anyway. */
              consequence={null}
            />
          )}
        </section>
      )}

      {/* The money rule, restated where the booking lives — the same sentence
          the event page showed before the tap. Paid bookings only: "free
          cancellation" under a free booking reads as a price, not a policy.
          And online only: a cutoff sentence under a cash booking promises
          money movement that cannot happen. */}
      {booking.total_paise > 0 && booking.payment_mode !== 'cash' && event && (
        <p className="text-muted mt-4 text-sm">{refundPolicySentence(event.refund_cutoff_hours)}</p>
      )}

      {booking.status === 'awaiting_payment' &&
        booking.approved_at &&
        isAttendee &&
        !claimable &&
        !payment &&
        holdLive &&
        keyId &&
        event && (
          <ApprovedPayPanel
            reference={booking.reference}
            amountLabel={formatPaise(booking.total_paise)}
            sentence={
              isWaitlistEvent
                ? offerPaySentence(
                    formatPaise(booking.total_paise),
                    formatIst(new Date(booking.hold_expires_at!)),
                  )
                : approvedPaySentence(
                    formatPaise(booking.total_paise),
                    formatIst(new Date(booking.hold_expires_at!)),
                  )
            }
          />
        )}

      {/* No keyId in this gate — there is no payment provider in this path at
          all, which is the whole reason it exists. */}
      {isOffer && isAttendee && claimable && holdLive && (
        <ClaimSeatPanel
          reference={booking.reference}
          sentence={offerClaimSentence(
            formatIst(new Date(booking.hold_expires_at!)),
            booking.payment_mode === 'cash' ? formatPaise(booking.total_paise) : null,
          )}
        />
      )}

      {lapsedOffer && <p className="text-muted mt-6 text-sm">{LAPSED_OFFER_SENTENCE}</p>}

      {booking.status === 'awaiting_payment' && payment && holdLive && keyId && event && (
        <CheckoutPanel
          reference={booking.reference}
          orderId={payment.provider_order_id}
          amountPaise={booking.total_paise}
          keyId={keyId}
          eventTitle={event.title}
          holdExpiresAt={booking.hold_expires_at!}
          attendeeName={booking.attendee_name}
          deadlineLabel={formatIst(new Date(booking.hold_expires_at!))}
        />
      )}

      {booking.status === 'confirmed' && booking.payment_mode === 'cash' && (
        <p className="border-line mt-6 rounded-lg border p-3 text-sm">
          Pay {formatPaise(booking.total_paise)} in cash at the door.
        </p>
      )}

      {tickets.length > 0 && (
        <section className="mt-10">
          <h2 className="text-muted font-mono text-[13px]">
            {tickets.length === 1 ? 'Your ticket' : `Your tickets — one per person`}
          </h2>
          <ul className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {tickets.map((ticket, index) => (
              <li key={ticket.id} className="border-line rounded-xl border bg-white p-3">
                {/* dangerouslySetInnerHTML is safe here by construction: the SVG is
                    generated by the qrcode library from a payload this server built
                    out of hex and dots. Nothing user-authored is in it. */}
                <div aria-hidden dangerouslySetInnerHTML={{ __html: qrs[index] }} />
                <p className="mt-2 font-mono text-[12px]">
                  Ticket {index + 1} of {tickets.length}
                </p>
                {/* The tail lets a host eyeball-match a screenshot to a row without
                    scanning. Six characters of a 32-char code identify without
                    admitting: admission needs the signature, which only a scan reads. */}
                <p className="text-muted font-mono text-[11px]">…{ticket.code.slice(-6)}</p>
                {ticket.checked_in_at && (
                  <p className="text-muted mt-1 font-mono text-[11px]">Checked in</p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-muted mt-3 text-[13px]">
            Going as a group? Send each person a screenshot of their own ticket.
          </p>
        </section>
      )}

      <div className="mt-10 flex gap-4 text-[14px]">
        <Link href="/bookings" className="underline">
          All your bookings
        </Link>
        {event && (
          <Link href={`/e/${event.slug}`} className="underline">
            Event page
          </Link>
        )}
      </div>
    </main>
  )
}
