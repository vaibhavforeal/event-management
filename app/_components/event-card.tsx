import Image from 'next/image'
import Link from 'next/link'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import type { FeedEvent } from '@/lib/events/queries'
import { coverFallbackClass } from '@/lib/events/cover-fallback'

/**
 * What a card is actually painted at, so next/image can pick a variant that
 * fits instead of guessing from the 800px `width` prop.
 *
 * Derived from the feed's own layout: <main> is max-w-3xl (768px) with px-4, and
 * the grid is one column until sm (640px) and two with gap-4 above it. So a card
 * is the full content width on a phone, half of it minus the gap in between, and
 * a flat 360px once the page stops growing. Without this a 390px Android was
 * served the 828px variant of a cover — on the connection a forwarded WhatsApp
 * link is usually opened over, that is the difference between loading and not.
 */
const CARD_SIZES = '(min-width: 768px) 360px, (min-width: 640px) calc((100vw - 48px) / 2), calc(100vw - 32px)'

export function EventCard({ event, preload = false }: { event: FeedEvent; preload?: boolean }) {
  const ticket = event.ticket_types[0]

  return (
    <Link
      href={`/e/${event.slug}`}
      className="block overflow-hidden rounded-xl bg-white shadow-[0_2px_12px_rgba(124,45,18,0.10)] transition hover:shadow-[0_4px_16px_rgba(124,45,18,0.16)]"
    >
      {event.cover_image_url ? (
        <Image
          src={event.cover_image_url}
          alt=""
          width={800}
          height={400}
          // `preload`, not `priority`: Next 16 deprecated the latter in favour
          // of this, to make the behaviour it actually has — inserting a <link>
          // in the head — say so. Only ever set on the first card, the one above
          // the fold and so the likely largest contentful paint; the docs warn
          // against preloading several images that each might be the LCP,
          // because then none of them is prioritised.
          preload={preload}
          sizes={CARD_SIZES}
          className="h-40 w-full object-cover"
        />
      ) : (
        <div className={`h-40 w-full ${coverFallbackClass(event.category)}`} />
      )}
      <div className="space-y-1 p-4">
        <p className="text-[11px] tracking-[0.08em] uppercase text-ember font-semibold">{formatIst(new Date(event.starts_at))}</p>
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
        <h2 className="font-display text-[16px] font-semibold leading-snug break-words">{event.title}</h2>
        <p className="text-[11px] tracking-[0.08em] uppercase text-muted break-words">{event.venue_name ?? event.city}</p>
        {ticket && (
          <p className="text-sm font-bold text-accent">
            {ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)}
          </p>
        )}
      </div>
    </Link>
  )
}
