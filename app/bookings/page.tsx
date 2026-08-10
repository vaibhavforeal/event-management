import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { listMyBookings } from '@/lib/bookings/queries'
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

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <h1 className="text-2xl font-semibold">Your bookings</h1>

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
            <li key={booking.id} className="border-line rounded-xl border p-4">
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
                {booking.quantity} {booking.quantity === 1 ? 'seat' : 'seats'} · {booking.status}
              </p>
              {/* Only a confirmed booking has anything to cancel. cancel_booking
                  is idempotent, so offering this on a cancelled row would be
                  harmless and still wrong: it would read as though the row might
                  come back. */}
              {booking.status === 'confirmed' && (
                <CancelButton
                  bookingId={booking.id}
                  slug={booking.events?.slug ?? ''}
                  /* What the tap will do to the money, computed here because the
                     server owns the clock. cancelConsequence returns null for
                     free bookings, so free rows keep their plain button. */
                  consequence={
                    booking.events
                      ? cancelConsequence({
                          initiator: 'attendee',
                          totalPaise: booking.total_paise,
                          startsAt: booking.events.starts_at,
                          cutoffHours: booking.events.refund_cutoff_hours,
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
