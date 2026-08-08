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
        <h2 className="font-medium leading-snug">{event.title}</h2>
        <p className="text-sm text-zinc-500">{event.venue_name ?? event.city}</p>
        {ticket && (
          <p className="text-sm font-medium">
            {ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)}
          </p>
        )}
      </div>
    </Link>
  )
}
