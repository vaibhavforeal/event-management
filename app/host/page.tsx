import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { listHostEvents } from '@/lib/events/queries'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'

export const metadata = { title: 'Your events' }

export default async function HostDashboard() {
  await requireUser()
  const events = await listHostEvents()

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your events</h1>
        <Link href="/host/events/new" className="rounded-lg bg-black px-4 py-2 text-sm text-white">
          New event
        </Link>
      </div>

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          No events yet. Create one and you will get a link to share.
        </p>
      ) : (
        <ul className="space-y-3">
          {events.map((event) => {
            const ticket = event.ticket_types[0]
            return (
              <li key={event.id} className="rounded-xl border border-zinc-200 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Link href={`/host/events/${event.id}/edit`} className="font-medium hover:underline">
                      {event.title}
                    </Link>
                    <p className="text-sm text-zinc-500">
                      {formatIst(new Date(event.starts_at))} · {event.city}
                    </p>
                    {ticket && (
                      <p className="text-sm text-zinc-500">
                        {formatPaise(ticket.price_paise)} · {ticket.reserved_count}/{ticket.quantity} taken
                      </p>
                    )}
                  </div>
                  <span
                    className={
                      event.status === 'published'
                        ? 'rounded-full bg-green-100 px-2 py-1 text-xs text-green-800'
                        : 'rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600'
                    }
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
