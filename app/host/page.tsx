import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { listHostEvents, type HostEvent } from '@/lib/events/queries'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'

export const metadata = { title: 'Your events' }

/**
 * One treatment per status, rather than "published or not".
 *
 * Nothing sets `cancelled` or `completed` yet, but rendering them in the same
 * grey as `draft` would read as "not live yet" — the opposite of what happened
 * to a cancelled event, and an invitation to try publishing it. Typed as a
 * Record over the union so adding a value to the `event_status` enum fails the
 * typecheck here instead of silently falling back to grey.
 */
const STATUS_BADGE: Record<HostEvent['status'], string> = {
  // The palette tokens for the neutral state; the other three keep Tailwind's
  // semantic hues — green/red/blue are statuses, not chrome, and the warm
  // neutrals have no equivalent of "live" or "cancelled".
  draft: 'bg-raised text-muted',
  published: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
  completed: 'bg-blue-100 text-blue-700',
}

export default async function HostDashboard() {
  await requireUser()
  const events = await listHostEvents()

  // `w-full` alongside `mx-auto max-w-*` is the standing rule for every <main>
  // in this app. <body> used to be a column flex container, and a flex item with
  // auto cross-axis margins is exempt from stretching — so main was sized
  // shrink-to-fit and settled at its own max-width, 768px, on a 390px phone.
  // Task 8.5 removed that `flex`, which makes `w-full` redundant today; it stays
  // because it costs nothing and makes the page immune should any ancestor
  // become a flex or grid container again.
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your events</h1>
        <div className="flex items-center gap-3">
          <Link href="/host/payouts" className="text-muted text-sm hover:underline">
            Payouts
          </Link>
          <Link href="/host/events/new" className="bg-ink text-paper rounded-lg px-4 py-2 text-sm">
            New event
          </Link>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="border-line text-muted rounded-xl border border-dashed p-8 text-center">
          No events yet. Create one and you will get a link to share.
        </p>
      ) : (
        <ul className="space-y-3">
          {events.map((event) => {
            const ticket = event.ticket_types[0]
            return (
              <li key={event.id} className="border-line rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  {/* min-w-0 because a flex item defaults to min-width:auto, which
                      refuses to shrink below its content. A 140-character
                      unbroken title is valid — the schema CHECK allows it — and
                      without this it widened the row past the viewport, scrolled
                      the whole page sideways and pushed the badge off screen,
                      wrecking every other row with it. break-words then lets the
                      title itself wrap mid-word. */}
                  <div className="min-w-0">
                    <Link
                      href={`/host/events/${event.id}/edit`}
                      className="font-medium break-words hover:underline"
                    >
                      {event.title}
                    </Link>
                    <p className="text-muted text-sm break-words">
                      {formatIst(new Date(event.starts_at))} · {event.city}
                    </p>
                    {ticket && (
                      <p className="text-muted text-sm">
                        {formatPaise(ticket.price_paise)} · {ticket.reserved_count}/{ticket.quantity} taken
                      </p>
                    )}
                  </div>
                  {/* shrink-0 so the badge keeps its width and stays on screen
                      rather than being squeezed by a long title. */}
                  <span
                    className={`shrink-0 rounded-full px-2 py-1 text-xs ${STATUS_BADGE[event.status]}`}
                  >
                    {event.status}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
