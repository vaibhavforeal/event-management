import Image from 'next/image'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getPublishedEventBySlug } from '@/lib/events/queries'
import { waitlistLength } from '@/lib/bookings/queries'
import { lineLengthLine, waitlistPriceLine } from '@/lib/bookings/waitlist-copy'
import { formatIst, formatIstDateOnly, hasStarted } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { refundPolicySentence } from '@/lib/payments/refund-policy'
import { clientEnv } from '@/lib/env'
import { BookPanel } from './book-panel'
import { RequestPanel } from './request-panel'
import { JoinWaitlistPanel } from './join-waitlist-panel'

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

// The palette this page pioneered — paper, ink, muted, line, accent — now
// lives in globals.css as @theme tokens and covers the whole app. It was kept
// route-local while it was a one-route visual identity; once every other page
// adopted it, local literals stopped being an identity and became drift (this
// route's own book-panel had already wandered three values away).

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
    <p className="text-accent flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
      <span aria-hidden className="bg-accent inline-block h-px w-5" />
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
        // An empty mark is an outline, not a fill. ring-inset rather than a
        // border so the mark's box stays the same size either way; at 6x14px a
        // border would visibly shrink the rounded shape.
        <span
          key={index}
          className={`h-3.5 w-1.5 rounded-full ${
            index < taken ? 'bg-accent' : 'ring-line ring-1 ring-inset'
          }`}
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

  // Phase 3 books free and paid, no-approval events; Phase 5a's request panel
  // takes approval-gated ones. What remains inert is the control Phase 1
  // shipped, whose label is "Booking opens soon" — which is deliberately
  // vaguer than the reason: an event with no ticket type at all is not the
  // visitor's problem to solve, and "not yet" is the honest summary. Only the
  // states the visitor can act on get their own sentence, below.
  //
  // `started` mirrors the EH013 guard in book_free_tickets, inclusive of the
  // start instant. It is deliberately not a "finished" state: ends_at is
  // nullable and most events will not set one, so there is nothing to compute
  // that from, and the rule being mirrored is starts_at <= now() regardless.
  // The feed already hides past events, but this page is reached by a WhatsApp
  // link that outlives the event, so it is the surface where a started event is
  // actually met.
  //
  // EH012 — the same attendee booking twice — is deliberately NOT guarded here.
  // The page cannot know without querying this visitor's bookings, which is a
  // round trip on every render of the app's most-shared public page, to
  // pre-empt a case the database already refuses with a sentence the panel
  // prints. Offering the control and losing that race is the cheaper mistake.
  const started = hasStarted(event.starts_at)
  // Requests stay open at capacity: over-requesting IS the curation model —
  // the host approves as seats free up. Only a started event closes the door.
  const requestable = !!ticket && !started && event.requires_approval
  // For requests the picker caps at max_per_order, not seats remaining:
  // a full room can still be asked.
  const requestMax = ticket ? Math.max(1, Math.min(ticket.quantity, ticket.max_per_order ?? 10)) : 1

  // Only asked for on events that keep a line — one RPC, skipped entirely on
  // every other event, which is most of them. Signed-out safe by design; see
  // waitlistLength.
  const lineLength = ticket && event.has_waitlist ? await waitlistLength(ticket.id) : 0

  // The line holds the door. While anyone is waiting, this page stays in
  // join-waitlist mode even when a seat is free — because a seat that is free
  // right now is a seat somebody in the line is owed, and letting a walk-up
  // take it is the one thing that would make the queue not worth joining.
  //
  // SQL enforces the same priority underneath — reserve_tickets promotes
  // before it sells — but not identically, and the seam is worth naming:
  // promote_from_waitlist is strict FIFO and exits when the head wants more
  // seats than are free, so a one-seat walk-up arriving behind a three-seat
  // head with one seat loose IS sold by reserve_tickets. The SQL calls that
  // idle seat the accepted cost of a queue nobody can cut; this page simply
  // does not offer the button, which is the stricter half of the disagreement
  // and the safe one. What it buys is that no visitor is ever handed a control
  // the database is about to refuse.
  const joinable = !!ticket && !started && event.has_waitlist && (soldOut || lineLength > 0)
  // Capped at max_per_order rather than seats remaining, like the request
  // panel: there are no seats remaining, which is why this panel exists.
  const joinMax = ticket ? Math.max(1, Math.min(ticket.quantity, ticket.max_per_order ?? 10)) : 1

  // One gate, two doors: everything a booking needs regardless of money, then
  // the price decides which action the panel submits to. The two are mutually
  // exclusive by construction — price_paise is CHECKed non-negative — so the
  // bar renders exactly one of free panel, paid panel, or the inert fallback.
  const common = !!ticket && !soldOut && !started && !event.requires_approval && !joinable
  const bookableFree = common && ticket.price_paise === 0
  const bookablePaid = common && ticket.price_paise > 0
  const maxSeats = ticket ? Math.max(1, Math.min(remaining, ticket.max_per_order ?? 10)) : 1

  return (
    /**
     * `w-full` alongside `mx-auto max-w-*` is the standing rule for every <main>
     * here, after auto margins on a flex item pinned each page to its own
     * max-width on a phone.
     *
     * The colours are inherited now, and that is safe where it once was not:
     * this page used to pin paper and ink inline because globals.css flipped
     * --background/--foreground under `prefers-color-scheme: dark` and would
     * have painted the prose onto a near-black body. globals.css is light-only
     * today and the body IS this palette, so pinning here would just be the
     * same values twice.
     *
     * min-h-screen is vestigial now that main paints no surface of its own —
     * the body behind it is the same paper — but it stays so that giving this
     * page a distinct background again cannot quietly end mid-viewport.
     */
    <main className="mx-auto min-h-screen w-full max-w-2xl pb-36">
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
          <p className="text-accent font-mono text-[11px] tracking-[0.18em] uppercase">
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

        <section className="border-line mt-8 space-y-2 border-t pt-6">
          <SectionLabel>When</SectionLabel>
          <p className="font-mono text-[15px]">{formatIst(startsAt)}</p>
          {/* Shown because it answers "can I make it?", which is the question
              between reading the page and booking. requires_approval and
              allows_cash are on the row too and stay unrendered: both are read
              by the bottom bar's gates rather than printed. */}
          {event.ends_at && (
            <p className="text-muted font-mono text-[13px]">
              Ends {formatIst(new Date(event.ends_at))}
            </p>
          )}
          {/* The money rule, stated where the visitor is already reading the
              clock it hangs off. Priced events only: "free cancellation" under
              a free event reads as a price, not a policy. */}
          {!!ticket && ticket.price_paise > 0 && (
            <p className="text-muted text-sm">{refundPolicySentence(event.refund_cutoff_hours)}</p>
          )}
        </section>

        <section className="border-line mt-6 space-y-2 border-t pt-6">
          <SectionLabel>Where</SectionLabel>
          <p className="text-[15px] font-medium break-words">{event.venue_name ?? event.city}</p>
          {/* Luma-style: the exact address is withheld until the host approves. */}
          {event.hide_venue_until_approved ? (
            <p className="text-muted text-[14px]">
              The host shares the exact address once they approve you.
            </p>
          ) : (
            event.venue_address && (
              <p className="text-muted text-[14px] break-words">
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
            <p className="text-muted font-mono text-[13px] break-words">
              {event.city}
            </p>
          )}
        </section>

        {event.description && (
          <section className="border-line mt-6 border-t pt-6">
            <SectionLabel>About</SectionLabel>
            <div className="mt-3 text-[16px] leading-[1.7] whitespace-pre-wrap break-words">
              {event.description}
            </div>
          </section>
        )}

        {event.hosts && (
          <section className="border-line mt-6 border-t pt-6">
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
                  <p className="text-muted text-[14px] break-words">
                    {event.hosts.bio}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {ticket && (
          <section className="border-line mt-6 space-y-3 border-t pt-6">
            <SectionLabel>Seats</SectionLabel>
            <SeatMarks quantity={ticket.quantity} taken={taken} />
            <p className={`font-mono text-[13px] ${soldOut ? 'text-muted' : 'text-ink'}`}>
              {seatsLabel}
            </p>
          </section>
        )}
      </div>

      {/* The safe-area padding keeps the price clear of the Android gesture bar.
          bg-paper/95 rather than opaque paper so the backdrop-blur has something
          to do — content scrolling under the bar reads as under it. */}
      <div className="border-line bg-paper/95 fixed inset-x-0 bottom-0 border-t px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
        {requestable && ticket ? (
          <RequestPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={requestMax}
            priceLabel={ticket.price_paise === 0 ? 'Free' : `${formatPaise(ticket.price_paise)} after approval`}
            offerCash={event.allows_cash && ticket.price_paise > 0}
          />
        ) : joinable && ticket ? (
          <JoinWaitlistPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={joinMax}
            priceLine={waitlistPriceLine(
              ticket.price_paise === 0 ? null : formatPaise(ticket.price_paise),
            )}
            lineLine={lineLengthLine(lineLength)}
            offerCash={event.allows_cash && ticket.price_paise > 0}
          />
        ) : bookableFree && ticket ? (
          <BookPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={maxSeats}
            priceLabel="Free"
            seatsLabel={seatsLabel}
          />
        ) : bookablePaid && ticket ? (
          <BookPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={maxSeats}
            priceLabel={formatPaise(ticket.price_paise)}
            seatsLabel={seatsLabel}
            paid
            cash={event.allows_cash}
          />
        ) : (
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[19px] leading-tight font-semibold">
                {ticket ? (ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)) : '—'}
              </p>
              <p className="text-muted font-mono text-[12px]">
                {seatsLabel}
              </p>
            </div>
            <button
              type="button"
              disabled
              className="border-line bg-raised text-muted shrink-0 rounded-lg border px-5 py-3 text-[15px] font-medium"
            >
              {/* "already started", not "finished": a link forwarded to a
                  WhatsApp group is opened twenty minutes into a three-hour
                  supper club as a matter of course, and telling that visitor it
                  is over is a lie. This wording is true at minute one and at
                  hour three alike, and is the same thing EH013 says. */}
              {started ? 'This event has already started' : soldOut ? 'Sold out' : 'Booking opens soon'}
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
