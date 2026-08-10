import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { getBookingByReference } from '@/lib/bookings/queries'
import { serverEnv } from '@/lib/env'
import { formatIst } from '@/lib/events/datetime'
import { refundPolicySentence } from '@/lib/payments/refund-policy'
import { reconcileBooking } from '@/lib/payments/service'
import { ticketQrSvg } from '@/lib/tickets/qr'
import { listBookingTickets } from '@/lib/tickets/queries'
import { CheckoutPanel } from './checkout-panel'

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
  pending_approval: 'Waiting for the host',
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
  await requireUser()

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

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <p className="font-mono text-[13px] tracking-wide text-muted">
        {STATUS_LINE[booking.status] ?? `Booking ${booking.status}`}
      </p>

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
              <dd className="break-words">{[event.venue_name, event.city].filter(Boolean).join(', ')}</dd>
            </div>
          </>
        )}
      </dl>

      {/* The money rule, restated where the booking lives — the same sentence
          the event page showed before the tap. Paid bookings only: "free
          cancellation" under a free booking reads as a price, not a policy. */}
      {booking.total_paise > 0 && event && (
        <p className="text-muted mt-4 text-sm">{refundPolicySentence(event.refund_cutoff_hours)}</p>
      )}

      {booking.status === 'awaiting_payment' && payment && holdLive && keyId && event && (
        <CheckoutPanel
          reference={booking.reference}
          orderId={payment.provider_order_id}
          amountPaise={booking.total_paise}
          keyId={keyId}
          eventTitle={event.title}
          holdExpiresAt={booking.hold_expires_at!}
          attendeeName={booking.attendee_name}
        />
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
