import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { getBookingByReference } from '@/lib/bookings/queries'
import { formatIst } from '@/lib/events/datetime'

// Not "Your booking": getBookingByReference deliberately also resolves for the
// host of the event, who is looking at somebody else's.
export const metadata = { title: 'Booking' }

export default async function BookingPage(props: PageProps<'/bookings/[reference]'>) {
  const { reference } = await props.params
  await requireUser()

  const booking = await getBookingByReference(reference)
  // RLS already refused someone else's booking, so "not found" and "not yours"
  // arrive here as the same thing — which is what we want them to look like.
  if (!booking) notFound()

  const event = booking.events

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <p className="font-mono text-[13px] tracking-wide text-neutral-500">
        {booking.status === 'confirmed' ? "You're going" : `Booking ${booking.status}`}
      </p>

      <h1 className="mt-2 text-2xl font-semibold break-words">{event?.title ?? 'Event'}</h1>

      <dl className="mt-8 space-y-4 font-mono text-[14px]">
        <div>
          <dt className="text-neutral-500">Reference</dt>
          {/* The string a host reads aloud at the door. Big, and selectable. */}
          <dd className="text-[22px] font-semibold tracking-[0.2em] select-all">
            {booking.reference}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Seats</dt>
          <dd>{booking.quantity}</dd>
        </div>
        {/* The whole block is conditional because the embed is nullable in the
            type: a booking whose event row has gone still has a reference and a
            seat count worth showing, and half a "When / Where" pair is worse
            than none. */}
        {event && (
          <>
            <div>
              <dt className="text-neutral-500">When</dt>
              {/* formatIst takes a Date; starts_at arrives as an ISO string. */}
              <dd>{formatIst(new Date(event.starts_at))}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Where</dt>
              <dd className="break-words">{[event.venue_name, event.city].filter(Boolean).join(', ')}</dd>
            </div>
          </>
        )}
      </dl>

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
