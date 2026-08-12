import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { getOwnedEvent } from '@/lib/events/queries'
import {
  listApprovedUnpaid,
  listEventAttendees,
  listEventRequests,
  listEventWaitlist,
  type EventRequest,
} from '@/lib/bookings/queries'
import { REMOVE_FROM_WAITLIST_CONSEQUENCE } from '@/lib/bookings/waitlist-copy'
import { cancelConsequence } from '@/lib/payments/refund-policy'
import { formatPaise } from '@/lib/money'
import { formatIst } from '@/lib/events/datetime'
import { ApproveRequestButton } from './approve-request-button'
import { CancelAttendeeButton } from './cancel-attendee-button'
import { CheckInButton } from './check-in-button'
import { DeclineRequestButton } from './decline-request-button'

export const metadata = { title: 'Guest list' }

/**
 * The stored phone as something a handset will actually dial.
 *
 * `profiles.phone` is written by the signup trigger from `auth.users.phone`, and
 * GoTrue stores E.164 with the leading `+` stripped — "919999900001", not
 * "+919999900001". Under RFC 3966 a `tel:` URI without the `+` is a *local*
 * number carrying no phone-context, so a handset dials it as typed: twelve
 * digits beginning 91 connects to nothing in India and could never connect from
 * outside it. The number was on screen and not dialable, which is the one thing
 * this page exists for.
 *
 * Guarded rather than unconditional because the two sources of truth disagree
 * about the stored shape: 20260808000001_core_schema.sql:49 documents the column
 * as E.164 *with* the plus, while GoTrue writes it without and
 * lib/auth/phone-otp.test.ts:69 pins that stripped form. Prefixing blindly would
 * produce "++91…" the day the migration's comment becomes true.
 *
 * Local to this file because this is its only caller today. Phase 4 sends
 * WhatsApp messages to this same column and will need exactly this rule — lift
 * it into lib/ then, with a test, rather than writing a second copy.
 */
function dialable(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`
}

/** What approving takes and what the guest then owes, stated beside the
    button before the tap — the approval queue's counterpart of
    cancelConsequence. Computed here because this page is where the price is
    known: getOwnedEvent carries ticket_types(price_paise). */
function approveConsequence(request: EventRequest, pricePaise: number): string {
  const total = pricePaise * request.quantity
  const seats = `${request.quantity} ${request.quantity === 1 ? 'seat' : 'seats'}`
  if (total === 0) return `Approving confirms ${seats}.`
  if (request.payment_mode === 'cash') {
    return `Approving takes ${seats}; they pay ${formatPaise(total)} at the door.`
  }
  return `Approving takes ${seats}; they pay ${formatPaise(total)} within 24 hours.`
}

export default async function AttendeesPage(
  props: PageProps<'/host/events/[id]/attendees'>,
) {
  const { id } = await props.params
  await requireUser()

  // getOwnedEvent scopes on host_id, so this is also the ownership check for
  // the page: a host who does not own this event gets a 404 rather than an
  // empty guest list, which would read as "nobody is coming".
  const event = await getOwnedEvent(id)
  if (!event) notFound()

  const [attendees, requests, unpaid, waitlist] = await Promise.all([
    listEventAttendees(id),
    listEventRequests(id),
    listApprovedUnpaid(id),
    listEventWaitlist(id),
  ])
  const seats = attendees.reduce((total, a) => total + a.quantity, 0)
  // The one price this pilot's single ticket type carries — what
  // approveConsequence turns into "they pay ₹X".
  const price = event.ticket_types[0]?.price_paise ?? 0

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <Link href={`/host/events/${id}/edit`} className="font-mono text-[13px] underline">
        ← {event.title}
      </Link>

      <h1 className="mt-4 text-2xl font-semibold">Guest list</h1>
      <p className="text-muted mt-1 font-mono text-[13px]">
        {seats} {seats === 1 ? 'seat' : 'seats'} taken by {attendees.length}{' '}
        {attendees.length === 1 ? 'booking' : 'bookings'}
        {/* The host's one-glance answer to "is anything waiting on me?" —
            confirmed seats stay the headline count, and the queue's three
            numbers ride beside it only while any of them is non-zero. An
            event runs one queue or the other, never both, so in practice two
            of these three are always zero; printing all three keeps the line
            one shape to read rather than one per event kind. */}
        {(requests.length > 0 || unpaid.length > 0 || waitlist.length > 0) &&
          ` · ${requests.length} requested · ${unpaid.length} approved unpaid · ${waitlist.length} waiting`}
      </p>
      {/* The door's main entrance. The buttons below are its fallback for a
          guest with no QR, no camera, or no Chrome. */}
      <p className="mt-3">
        <Link href={`/host/events/${id}/scan`} className="font-mono text-[13px] underline">
          Scan tickets →
        </Link>
      </p>

      {/* The approval queue, above the guest list because it is the part
          waiting on the host: a request sits pending until somebody taps one
          of these two buttons. Rendered only while there is one, so a host
          whose event takes no approvals never sees the machinery. */}
      {requests.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Requests</h2>
          <p className="text-muted mt-1 font-mono text-[13px]">
            {requests.length} {requests.length === 1 ? 'request' : 'requests'} waiting on you
          </p>
          <ul className="divide-line mt-4 divide-y">
            {requests.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.attendee_name ?? 'Guest'}</p>
                  <p className="text-muted font-mono text-[12px]">
                    {r.quantity} {r.quantity === 1 ? 'seat' : 'seats'} · {r.reference} ·{' '}
                    {formatIst(new Date(r.created_at))}
                  </p>
                  {/* The note is the request's whole case — "it's my sister's
                      birthday" is what the host decides on. Quoted so the
                      guest's words read as the guest's, not the page's. */}
                  {r.attendee_note && <p className="mt-1 text-[13px]">“{r.attendee_note}”</p>}
                  {r.profiles?.phone && (
                    <a
                      href={`tel:${dialable(r.profiles.phone)}`}
                      className="font-mono text-[12px] underline"
                    >
                      {dialable(r.profiles.phone)}
                    </a>
                  )}
                </div>
                {/* Two forms, stacked: each button owns its pending and error
                    state, and nesting forms is not HTML — the same split as
                    the guest list's check-in/cancel pair below. */}
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <ApproveRequestButton
                    bookingId={r.id}
                    eventId={id}
                    slug={event.slug}
                    consequence={approveConsequence(r, price)}
                  />
                  <DeclineRequestButton bookingId={r.id} eventId={id} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Approved but not yet paid: seats these guests hold that money has not
          confirmed. The host's move here is chasing (the phone link) or
          freeing the seat — and cancelling costs the guest nothing, because
          nothing was paid, which is why the consequence is null.

          One strip, two queues. The rows are identical because a seat offer and
          an approval genuinely are the same row — awaiting_payment carrying
          approved_at — so only the two strings below differ. events_one_queue
          forbids an event running both, which is what makes has_waitlist the
          whole of the answer to which queue produced these. */}
      {unpaid.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">
            {event.has_waitlist ? 'Seat offers — waiting on the guest' : 'Approved — payment pending'}
          </h2>
          <ul className="divide-line mt-4 divide-y">
            {unpaid.map((u) => (
              <li key={u.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{u.attendee_name ?? 'Guest'}</p>
                  <p className="text-muted font-mono text-[12px]">
                    {/* "Offer expires" rather than "Pay by", because a waitlist
                        offer may be a claim rather than a payment: a cash or
                        free offer is taken with a tap, not a card, and a host
                        ringing round must not be told to ask for money that
                        settles at the door. The row does not say which of the
                        two it is — listApprovedUnpaid does not select
                        payment_mode and does not need to, because the deadline
                        is the fact the host needs either way. */}
                    {u.quantity} {u.quantity === 1 ? 'seat' : 'seats'} ·{' '}
                    {formatPaise(u.total_paise)} ·{' '}
                    {event.has_waitlist ? 'Offer expires ' : 'Pay by '}
                    {u.hold_expires_at ? formatIst(new Date(u.hold_expires_at)) : '—'}
                  </p>
                  {u.profiles?.phone && (
                    <a
                      href={`tel:${dialable(u.profiles.phone)}`}
                      className="font-mono text-[12px] underline"
                    >
                      {dialable(u.profiles.phone)}
                    </a>
                  )}
                </div>
                <div className="flex shrink-0 items-start">
                  <CancelAttendeeButton
                    bookingId={u.id}
                    eventId={id}
                    slug={event.slug}
                    consequence={null}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The line, in the order it will be served — below the strip above and
          above the guest list below, because the strip is what is waiting on
          somebody NOW while the line is waiting on a seat that may never come
          free. Rendered only when there is a line, so a host whose event keeps
          none never sees the machinery.

          There is deliberately no promote button. Promotion is automatic and
          strictly FIFO, and a control that fired it by hand would let a host
          reorder a queue whose entire value is that it cannot be reordered.
          The one action a host legitimately has here is removing somebody.

          The number in front of each name is the array index, not a stored
          column: listEventWaitlist orders by the same (created_at, id) that
          promote_from_waitlist promotes by, so the position on screen cannot
          disagree with the engine. True per ticket type — see that query. */}
      {waitlist.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Waitlist</h2>
          <p className="text-muted mt-1 font-mono text-[13px]">
            {waitlist.length} {waitlist.length === 1 ? 'person' : 'people'} waiting. Seats are
            offered automatically, in this order.
          </p>
          <ul className="divide-line mt-4 divide-y">
            {waitlist.map((entry, index) => (
              <li key={entry.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <span className="text-muted font-mono text-[12px]">#{index + 1}</span>{' '}
                    {entry.attendee_name ?? 'Guest'}
                  </p>
                  <p className="text-muted font-mono text-[12px]">
                    {/* No amount on these rows, and none to show: a waitlist
                        entry stores 0/0/0 and is priced at offer time from
                        whatever the host charges then. The payment mode is
                        what they chose for the offer they are waiting for. */}
                    {entry.quantity} {entry.quantity === 1 ? 'seat' : 'seats'} ·{' '}
                    {entry.payment_mode === 'cash' ? 'cash' : 'online'} · {entry.reference} ·{' '}
                    joined {formatIst(new Date(entry.created_at))}
                  </p>
                  {entry.profiles?.phone && (
                    <a
                      href={`tel:${dialable(entry.profiles.phone)}`}
                      className="font-mono text-[12px] underline"
                    >
                      {dialable(entry.profiles.phone)}
                    </a>
                  )}
                </div>
                <div className="flex shrink-0 items-start">
                  {/* The existing host cancel, and the only reason this list is
                      not read-only: a head whose entry no longer fits the room
                      blocks everyone behind it, and removing them is what
                      unblocks the line. Its consequence is not
                      cancelConsequence's — no money moved and no seat was held,
                      so that function would return null and leave the control
                      with nothing beside it. */}
                  <CancelAttendeeButton
                    bookingId={entry.id}
                    eventId={id}
                    slug={event.slug}
                    consequence={REMOVE_FROM_WAITLIST_CONSEQUENCE}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {attendees.length === 0 ? (
        <p className="text-muted mt-8 text-[15px]">Nobody has booked yet.</p>
      ) : (
        // divide-line and not a bare divide-y: Tailwind v4 defaults every
        // border colour to currentColor, so the unpinned version rules the
        // list in near-black text colour instead of a hairline. Same reason
        // every `border` in this repo carries a colour beside it.
        <ul className="divide-line mt-8 divide-y">
          {attendees.map((a) => {
            const ticketsIn = a.tickets.filter((t) => t.checked_in_at).length
            // What removing this guest does to their money, stated beside the
            // control. cancelConsequence and not a hand-written sentence, so the
            // copy lives in the one tested place; for a host it never consults
            // the clock — removal refunds in full — and it returns null for free
            // bookings, so those rows keep their plain Cancel. The status guard
            // is belt over the query's own confirmed-only filter: if that filter
            // ever loosens, a pending row must not promise a refund.
            const consequence =
              a.status === 'confirmed'
                ? cancelConsequence({
                    initiator: 'host',
                    totalPaise: a.total_paise,
                    startsAt: event.starts_at,
                    cutoffHours: event.refund_cutoff_hours,
                    // A cash guest paid nothing online, so removing them must
                    // not promise a refund — cancelConsequence returns null.
                    paymentMode: a.payment_mode === 'cash' ? 'cash' : 'online',
                  })
                : null
            return (
              <li key={a.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  {/* The name the attendee typed when booking. Nullable because
                      the Phase 3 and Phase 5 booking paths will not collect one,
                      so the fallback is needed even though 2a always writes it. */}
                  <p className="truncate font-medium">{a.attendee_name ?? 'Guest'}</p>
                  <p className="text-muted font-mono text-[12px]">
                    {a.quantity} {a.quantity === 1 ? 'seat' : 'seats'} · {ticketsIn} of{' '}
                    {a.tickets.length} in · {a.reference}
                  </p>
                  {/* A tel: link, because the host is on a phone and the whole
                      point of having this is contacting the guest. Null only if
                      profiles_select_for_host stopped matching, which would mean
                      the policy broke — so it renders nothing rather than an
                      empty link that looks tappable. */}
                  {a.profiles?.phone && (
                    <a
                      href={`tel:${dialable(a.profiles.phone)}`}
                      className="font-mono text-[12px] underline"
                    >
                      {/* The label is the normalised number and not the raw
                          column, so what the host reads is what their handset
                          dials — and so a number copied out by eye into WhatsApp
                          is the one that works. The two are free to differ: the
                          href has to satisfy RFC 3966, the label only has to be
                          legible. Do not "simplify" either back to
                          `a.profiles.phone`; see dialable() above. */}
                      {dialable(a.profiles.phone)}
                    </a>
                  )}
                </div>
                {/* Two forms, not one: each button owns its pending and error
                    state, and nesting forms is not HTML. Aligned to the top so
                    either one's error line pushes down without dragging the
                    other button with it. */}
                <div className="flex shrink-0 items-start gap-4">
                  <CheckInButton
                    bookingId={a.id}
                    eventId={id}
                    remaining={a.tickets.length - ticketsIn}
                  />
                  <CancelAttendeeButton
                    bookingId={a.id}
                    eventId={id}
                    slug={event.slug}
                    consequence={consequence}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
