import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { getOwnedEvent } from '@/lib/events/queries'
import { listEventAttendees } from '@/lib/bookings/queries'
import { CancelAttendeeButton } from './cancel-attendee-button'
import { CheckInButton } from './check-in-button'

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

  const attendees = await listEventAttendees(id)
  const seats = attendees.reduce((total, a) => total + a.quantity, 0)

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <Link href={`/host/events/${id}/edit`} className="font-mono text-[13px] underline">
        ← {event.title}
      </Link>

      <h1 className="mt-4 text-2xl font-semibold">Guest list</h1>
      <p className="text-muted mt-1 font-mono text-[13px]">
        {seats} {seats === 1 ? 'seat' : 'seats'} taken by {attendees.length}{' '}
        {attendees.length === 1 ? 'booking' : 'bookings'}
      </p>
      {/* The door's main entrance. The buttons below are its fallback for a
          guest with no QR, no camera, or no Chrome. */}
      <p className="mt-3">
        <Link href={`/host/events/${id}/scan`} className="font-mono text-[13px] underline">
          Scan tickets →
        </Link>
      </p>

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
                  <CancelAttendeeButton bookingId={a.id} eventId={id} slug={event.slug} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
