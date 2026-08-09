import Image from 'next/image'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getPublishedEventBySlug } from '@/lib/events/queries'
import { formatIst, formatIstDateOnly, hasStarted } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { clientEnv } from '@/lib/env'
import { BookPanel } from './book-panel'

/** How much of the description WhatsApp gets. Its card shows rather less. */
const OG_DESCRIPTION_LIMIT = 200

/**
 * Truncates to `limit` characters without splitting a word.
 *
 * A plain slice ends the preview card mid-word — "join us for a five-cour" —
 * which reads as a broken page rather than a truncated one, and this string is
 * the only prose a stranger sees before deciding whether to tap. The ellipsis is
 * added only when something was actually cut, so a short description passes
 * through untouched.
 *
 * Pure and total: no locale, no clock, no I/O, and every input returns a string.
 */
function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text

  // One character is reserved for the ellipsis, so the result is never longer
  // than `limit` — the point of the limit is that it is a limit.
  //
  // `slice` counts UTF-16 code units, so a cut can land between the two halves
  // of a surrogate pair. Emoji are pairs, and hosts on an Indian consumer
  // product use them constantly, so a lone high surrogate would reach the
  // preview card and render as a replacement character. Drop it: better one
  // character short than one that is not a character.
  //
  // Code points, not grapheme clusters. A ZWJ sequence cut here degrades to a
  // simpler emoji (👨‍👩‍👧 to 👨) rather than to mojibake, which is an acceptable
  // way to lose and does not need Intl.Segmenter on a hot path.
  const clipped = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '')
  // Drop the trailing partial word. A single word longer than the whole limit
  // has no boundary to cut on: the pattern then matches nothing (or everything,
  // if the string starts with space), and the hard cut stands.
  const whole = clipped.replace(/\s+\S*$/, '') || clipped
  return `${whole.trimEnd()}…`
}

/**
 * The OpenGraph block is not decoration. This link's first impression is the
 * preview card WhatsApp renders from these tags; a link that unfurls as a bare
 * URL reads as spam in a group chat, which kills the only distribution channel
 * the product has.
 */
export async function generateMetadata(props: PageProps<'/e/[slug]'>): Promise<Metadata> {
  const { slug } = await props.params
  const event = await getPublishedEventBySlug(slug)
  if (!event) return { title: 'Event not found' }

  const when = formatIst(new Date(event.starts_at))
  // Trimmed content rather than `??` on the raw column. An absent description is
  // NULL and a submitted one is trimmed by Zod, but a direct database write can
  // leave '' or '   ', and either renders a preview card with a blank second
  // line. The date and city are a better card than whitespace.
  const summary = event.description?.trim()
  const description = summary
    ? truncateAtWord(summary, OG_DESCRIPTION_LIMIT)
    : `${when} · ${event.city}`
  // `new URL` rather than concatenation, matching how the edit page builds the
  // share link it hands the host. NEXT_PUBLIC_SITE_URL passes z.url() with a
  // trailing slash and .env.example does not forbid one, so concatenation
  // silently emits "http://host//e/slug" — which resolves, but means the
  // canonical URL WhatsApp caches is not the URL the host is forwarding. These
  // two strings drifting apart is the one thing this page cannot afford.
  const url = new URL(`/e/${event.slug}`, clientEnv.NEXT_PUBLIC_SITE_URL).toString()

  return {
    title: event.title,
    description,
    openGraph: {
      title: event.title,
      description,
      url,
      type: 'website',
      images: event.cover_image_url ? [{ url: event.cover_image_url }] : undefined,
    },
    twitter: {
      card: event.cover_image_url ? 'summary_large_image' : 'summary',
      title: event.title,
      description,
    },
  }
}

/**
 * The palette, kept local to this route.
 *
 * Warm neutrals rather than Tailwind's zinc, which is cool-grey and reads as
 * dashboard chrome; this page should read as an invitation. Verdigris is the
 * single accent and appears twice — the section ticks and the taken seats.
 *
 * These are literals rather than @theme tokens in globals.css on purpose: that
 * file is shared with every other page and this is a one-route visual identity.
 */
const INK = '#14110F' // body text, headings
const SLATE = '#5C574F' // secondary text — ~6.8:1 on paper, legible in daylight
const MIST = '#E7E3DC' // hairlines
const VERDIGRIS = '#0F5E52' // the one accent — ~7.3:1 on paper

/** Above this many seats the marks stop reading as seats and become confetti. */
const SEAT_MARK_LIMIT = 40

/**
 * A section opener: a short rule, then the label.
 *
 * Mono because every fact on this page is set in mono — the visitor is scanning
 * for when, where and how much, and giving those a different voice from the
 * host's prose is what makes them scannable. Geist Mono is already loaded by the
 * root layout, so this costs no extra bytes on a phone with one bar of signal.
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase"
      style={{ color: VERDIGRIS }}
    >
      <span aria-hidden className="inline-block h-px w-5" style={{ backgroundColor: VERDIGRIS }} />
      {children}
    </p>
  )
}

/**
 * One mark per seat, filled for the seats already taken.
 *
 * The signature of the page, and it is information rather than ornament: these
 * events seat twelve or twenty-four people, so the marks *are* the seats and a
 * stranger reads "nearly full" without reading a number at all. aria-hidden
 * because the line underneath says the same thing in words.
 */
function SeatMarks({ quantity, taken }: { quantity: number; taken: number }) {
  if (quantity > SEAT_MARK_LIMIT) return null
  return (
    <div aria-hidden className="flex flex-wrap gap-1">
      {Array.from({ length: quantity }, (_, index) => (
        <span
          key={index}
          className="h-3.5 w-1.5 rounded-full"
          style={{
            backgroundColor: index < taken ? VERDIGRIS : 'transparent',
            boxShadow: index < taken ? undefined : `inset 0 0 0 1px ${MIST}`,
          }}
        />
      ))}
    </div>
  )
}

export default async function PublicEventPage(props: PageProps<'/e/[slug]'>) {
  const { slug } = await props.params
  const event = await getPublishedEventBySlug(slug)
  if (!event) notFound()

  const ticket = event.ticket_types[0]
  const remaining = ticket ? ticket.quantity - ticket.reserved_count : 0
  const soldOut = remaining <= 0
  // Clamped only for the marks. `remaining` above is deliberately unclamped so
  // an overbooked row still reads as sold out rather than as "-2 left".
  const taken = ticket ? Math.min(Math.max(ticket.reserved_count, 0), ticket.quantity) : 0

  const startsAt = new Date(event.starts_at)
  const seatsLabel = soldOut ? 'Sold out' : `${remaining} of ${ticket?.quantity ?? 0} seats left`

  // Phase 2a books free, no-approval events only. Anything else keeps the inert
  // control Phase 1 shipped: a host who set a price or ticked approval has built
  // something this phase cannot honour, and saying so is better than confirming
  // strangers at their door or letting people in free.
  //
  // `finished` mirrors the EH013 guard in book_free_tickets. The feed already
  // hides past events, but this page is reached by a link in a WhatsApp group
  // that outlives the event, so it is the surface where a finished event is
  // actually met.
  const finished = hasStarted(event.starts_at)
  const bookable =
    !!ticket && !soldOut && !finished && ticket.price_paise === 0 && !event.requires_approval
  const maxSeats = ticket ? Math.max(1, Math.min(remaining, ticket.max_per_order ?? 10)) : 1

  return (
    /**
     * `w-full` alongside `mx-auto max-w-*` is the standing rule for every <main>
     * here, after auto margins on a flex item pinned each page to its own
     * max-width on a phone.
     *
     * The colours are pinned rather than inherited. globals.css flips
     * --background and --foreground under `prefers-color-scheme: dark`, so on an
     * Android with dark mode on this page would otherwise paint zinc-800 prose
     * onto a near-black body — the description would vanish. Nothing else in the
     * app has a dark treatment yet, and the one page a stranger judges the event
     * on is not the place to debut a half-built one.
     *
     * min-h-screen so a sparse event — no cover, no description — still paints a
     * full surface rather than ending mid-viewport with white <body> below it.
     */
    <main
      className="mx-auto min-h-screen w-full max-w-2xl pb-36"
      style={{ backgroundColor: '#FBFAF7', color: INK }}
    >
      {event.cover_image_url && (
        /**
         * 1200x630 is the same crop the OpenGraph card used, so the page opens
         * on the picture the visitor just tapped in WhatsApp.
         *
         * `sizes` matters more than it looks: without it Next hands a 2x phone
         * the 3840px variant of a cover, which on the connection this page is
         * usually opened over is the difference between loading and not.
         */
        <Image
          src={event.cover_image_url}
          alt=""
          width={1200}
          height={630}
          priority
          sizes="(min-width: 672px) 672px, 100vw"
          className="aspect-[1200/630] w-full object-cover sm:rounded-b-2xl"
        />
      )}

      <div className="px-5 pt-7">
        <header className="space-y-3">
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase" style={{ color: VERDIGRIS }}>
            {formatIstDateOnly(startsAt)}
          </p>
          {/* break-words on every host-supplied string on this page. A
              140-character title with no space in it is valid under both the Zod
              schema and the database CHECK, and without this the text paints
              outside its own box and scrolls the whole page sideways — a bounding
              box check does not catch it. */}
          <h1 className="text-[28px] leading-[1.15] font-semibold tracking-tight text-balance break-words sm:text-[34px]">
            {event.title}
          </h1>
          {/* The city used to repeat here. It belongs under Where, not in the
              header: an address without a city is an incomplete address, and the
              header's job is what and when. The preview card already leads with
              the city when there is no description to show. */}
        </header>

        <section className="mt-8 space-y-2 border-t pt-6" style={{ borderColor: MIST }}>
          <SectionLabel>When</SectionLabel>
          <p className="font-mono text-[15px]">{formatIst(startsAt)}</p>
          {/* Shown because it answers "can I make it?", which is the question
              between reading the page and booking. requires_approval and
              allows_cash are on the row too and stay unrendered: the first is
              read by `bookable` above rather than printed, and the second only
              matters once there is a price to pay, which this phase has not
              reached. */}
          {event.ends_at && (
            <p className="font-mono text-[13px]" style={{ color: SLATE }}>
              Ends {formatIst(new Date(event.ends_at))}
            </p>
          )}
        </section>

        <section className="mt-6 space-y-2 border-t pt-6" style={{ borderColor: MIST }}>
          <SectionLabel>Where</SectionLabel>
          <p className="text-[15px] font-medium break-words">{event.venue_name ?? event.city}</p>
          {/* Luma-style: the exact address is withheld until the host approves. */}
          {event.hide_venue_until_approved ? (
            <p className="text-[14px]" style={{ color: SLATE }}>
              The host shares the exact address once they approve you.
            </p>
          ) : (
            event.venue_address && (
              <p className="text-[14px] break-words" style={{ color: SLATE }}>
                {event.venue_address}
              </p>
            )
          )}
          {/* Only when there is a venue name to sit above it: without one the
              line above already reads `event.city`, and the block would print
              the city twice.

              Unreachable today — publishEventBlockers requires a venue name, so
              a published event always has one and the `?? event.city` fallback
              above never fires. The guard costs a boolean and means relaxing
              that rule cannot quietly reintroduce the duplicate. */}
          {event.venue_name && (
            <p className="font-mono text-[13px] break-words" style={{ color: SLATE }}>
              {event.city}
            </p>
          )}
        </section>

        {event.description && (
          <section className="mt-6 border-t pt-6" style={{ borderColor: MIST }}>
            <SectionLabel>About</SectionLabel>
            <div className="mt-3 text-[16px] leading-[1.7] whitespace-pre-wrap break-words">
              {event.description}
            </div>
          </section>
        )}

        {event.hosts && (
          <section className="mt-6 border-t pt-6" style={{ borderColor: MIST }}>
            <SectionLabel>Host</SectionLabel>
            <div className="mt-3 flex items-center gap-3">
              {event.hosts.avatar_url && (
                <Image
                  src={event.hosts.avatar_url}
                  alt=""
                  width={44}
                  height={44}
                  className="h-11 w-11 shrink-0 rounded-full object-cover"
                />
              )}
              {/* min-w-0: a flex item will not shrink below its content by
                  default, so a long unbroken display name widens the row past
                  the viewport however hard break-words tries. */}
              <div className="min-w-0">
                <p className="text-[15px] font-medium break-words">{event.hosts.display_name}</p>
                {event.hosts.bio && (
                  <p className="text-[14px] break-words" style={{ color: SLATE }}>
                    {event.hosts.bio}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {ticket && (
          <section className="mt-6 space-y-3 border-t pt-6" style={{ borderColor: MIST }}>
            <SectionLabel>Seats</SectionLabel>
            <SeatMarks quantity={ticket.quantity} taken={taken} />
            <p className="font-mono text-[13px]" style={{ color: soldOut ? SLATE : INK }}>
              {seatsLabel}
            </p>
          </section>
        )}
      </div>

      {/* The safe-area padding keeps the price clear of the Android gesture bar. */}
      <div
        className="fixed inset-x-0 bottom-0 border-t px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur"
        style={{ borderColor: MIST, backgroundColor: 'rgba(255,255,255,0.94)' }}
      >
        {bookable && ticket ? (
          <BookPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={maxSeats}
            priceLabel="Free"
            seatsLabel={seatsLabel}
          />
        ) : (
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[19px] leading-tight font-semibold">
                {ticket ? (ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)) : '—'}
              </p>
              <p className="font-mono text-[12px]" style={{ color: SLATE }}>
                {seatsLabel}
              </p>
            </div>
            <button
              type="button"
              disabled
              className="shrink-0 rounded-lg border px-5 py-3 text-[15px] font-medium"
              style={{ borderColor: MIST, backgroundColor: '#F2EFE9', color: SLATE }}
            >
              {finished ? 'This event has finished' : soldOut ? 'Sold out' : 'Booking opens soon'}
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
