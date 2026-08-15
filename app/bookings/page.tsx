import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { currentCaller } from '@/lib/bookings/caller'
import { listMyBookings } from '@/lib/bookings/queries'
import { waitlistPosition } from '@/lib/bookings/service'
import { waitlistShortPosition } from '@/lib/bookings/waitlist-copy'
import { formatIst } from '@/lib/events/datetime'
import { cancelConsequence } from '@/lib/payments/refund-policy'
import { CancelButton } from './cancel-button'

export const metadata = { title: 'Your bookings' }

export default async function BookingsPage() {
  // Before the read, not instead of it. listMyBookings returns [] when signed
  // out, so without this a signed-out visitor gets a page that says they have
  // booked nothing — true of everyone, and an answer to a question they were
  // never asked. requireUser() redirects to /login carrying this path.
  await requireUser()
  const bookings = await listMyBookings()

  // One position per waitlisted row. Two round trips each, which is why it is
  // scoped to the rows that need it — a person has a handful of bookings, and
  // most of them are never in a line.
  const caller = await currentCaller()
  const waiting = bookings.filter((b) => b.status === 'waitlisted')
  const resolved = caller
    ? await Promise.all(waiting.map((b) => waitlistPosition(caller, b.id)))
    : []
  const positions = new Map<string, number>()
  waiting.forEach((b, index) => {
    const place = resolved[index]
    if (place !== null && place !== undefined) positions.set(b.id, place)
  })

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <h1 className="font-display text-2xl font-semibold">Your bookings</h1>

      {bookings.length === 0 ? (
        <p className="text-muted mt-8 text-[15px]">
          Nothing booked yet.{' '}
          <Link href="/" className="underline">
            Find something to go to
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-8 space-y-4">
          {bookings.map((booking) => (
            <li key={booking.id} className="rounded-xl bg-white p-4 shadow-[0_2px_12px_rgba(124,45,18,0.10)]">
              {/* break-words on the title: a 140-character unbroken one is valid
                  under the schema CHECK, and without this it scrolls the whole
                  page sideways. Same rule as the host dashboard. */}
              <Link
                href={`/bookings/${booking.reference}`}
                className="font-medium break-words underline"
              >
                {booking.events?.title ?? 'Event'}
              </Link>
              <p className="text-muted mt-1 font-mono text-[13px]">
                {booking.events && `${formatIst(new Date(booking.events.starts_at))} · `}
                {booking.quantity} {booking.quantity === 1 ? 'seat' : 'seats'} ·{' '}
                <span className={
                  booking.status === 'confirmed' ? 'text-accent'
                  : booking.status === 'cancelled' || booking.status === 'refunded' ? 'text-muted'
                  : 'text-ember'
                }>{booking.status}</span>
                {positions.has(booking.id) && ` · ${waitlistShortPosition(positions.get(booking.id)!)}`}
              </p>
              {/* A confirmed booking is cancelled, a pending request is
                  withdrawn, a waitlist entry is left — same cancel_booking
                  underneath, three verbs on the surface because they are three
                  different things to the person doing them. Not offered on a
                  cancelled row: cancel_booking is idempotent so it would be
                  harmless, and still wrong — it would read as though the row
                  might come back. */}
              {(booking.status === 'confirmed' ||
                booking.status === 'pending_approval' ||
                booking.status === 'waitlisted') && (
                <CancelButton
                  bookingId={booking.id}
                  slug={booking.events?.slug ?? ''}
                  label={
                    booking.status === 'pending_approval'
                      ? 'Withdraw request'
                      : booking.status === 'waitlisted'
                        ? 'Leave the waitlist'
                        : undefined
                  }
                  /* What the tap will do to the money, computed here because the
                     server owns the clock. Already gated on `confirmed`, so a
                     waitlist entry gets null without a new branch — and
                     correctly: nothing was paid and no seat was held. */
                  consequence={
                    booking.status === 'confirmed' && booking.events
                      ? cancelConsequence({
                          initiator: 'attendee',
                          totalPaise: booking.total_paise,
                          startsAt: booking.events.starts_at,
                          cutoffHours: booking.events.refund_cutoff_hours,
                          paymentMode: booking.payment_mode === 'cash' ? 'cash' : 'online',
                        })
                      : null
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
