import Image from 'next/image'
import Link from 'next/link'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import type { FeedEvent } from '@/lib/events/queries'

export function EventCard({ event }: { event: FeedEvent }) {
  const ticket = event.ticket_types[0]

  return (
    <Link
      href={`/e/${event.slug}`}
      className="block overflow-hidden rounded-xl border border-zinc-200 transition hover:border-zinc-400"
    >
      {event.cover_image_url ? (
        <Image
          src={event.cover_image_url}
          alt=""
          width={800}
          height={400}
          className="h-40 w-full object-cover"
        />
      ) : (
        <div className="h-40 w-full bg-gradient-to-br from-zinc-200 to-zinc-100" />
      )}
      <div className="space-y-1 p-4">
        <p className="text-sm text-zinc-500">{formatIst(new Date(event.starts_at))}</p>
        {/* break-words on every host-supplied string, the standing rule in this
            app. A 140-character title with no space in it is valid under both
            the Zod schema and the events.title CHECK, and hosts do write them.

            Without this the feed does not scroll sideways — Tailwind's
            grid-cols-* tracks are minmax(0, 1fr), and `overflow-hidden` on the
            card clips whatever escapes — so the usual scrollWidth check passes
            and the bug looks absent. It is not: measured at both 390px and
            1280px, the card silently cut the title mid-word at its own border
            and the visitor read "AntidisestablishmentarianismAntidisestablish"
            with no ellipsis and no way to see the rest. Clipping is the failure
            here, not overflow. */}
        <h2 className="font-medium leading-snug break-words">{event.title}</h2>
        <p className="text-sm break-words text-zinc-500">{event.venue_name ?? event.city}</p>
        {ticket && (
          <p className="text-sm font-medium">
            {ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)}
          </p>
        )}
      </div>
    </Link>
  )
}
