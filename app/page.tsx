import Link from 'next/link'
import { EventCard } from '@/app/_components/event-card'
import { MAX_CITY_LENGTH, foldCityName, listCityFeed, listFeedCities } from '@/lib/events/queries'

export const metadata = {
  title: 'What is on',
  description: 'Supper clubs, board-game nights, workshops and pop-ups near you.',
}

/**
 * How many city chips to paint.
 *
 * A stopgap, and named so it is easy to argue with. Before the chip row got its
 * own query it could only ever show the cities of the 50 events on the page;
 * now it can show every city the chip query returns, and measured at 1,207
 * upcoming events across as many cities that was 1,000 chips and a 469KB home
 * page. On the mid-range Android this product is opened on, that is worse than
 * an incomplete chooser.
 *
 * A chip row IS a chooser: past a couple of dozen entries it has stopped being
 * one and wants search instead. The filter no longer depends on this list, so
 * anything cut here is still reachable by URL and still returns its events, and
 * a selected city renders regardless of whether it made the cut.
 */
const MAX_CITY_CHIPS = 24

export default async function FeedPage(props: PageProps<'/'>) {
  const { city } = await props.searchParams
  const selectedCity = typeof city === 'string' ? city : undefined

  // The chip row is NOT derived from `events`. The feed is capped at 50 rows
  // nationally, so deriving the cities from it would mean that past fifty
  // upcoming events a city simply stopped being offered — a silent hole in
  // navigation, on a product whose entire discovery story is this one page.
  // listFeedCities() answers "which cities have something on" independently of
  // that cap, and folds case so one city is one chip.
  const [events, allCities] = await Promise.all([listCityFeed(selectedCity), listFeedCities()])
  const cities = allCities.slice(0, MAX_CITY_CHIPS)

  const selectedKey = selectedCity ? foldCityName(selectedCity) : undefined
  // A hand-typed ?city= that matches nothing published still has to be visible:
  // otherwise the empty state reads as "nothing on anywhere", with no clue what
  // is filtered and nothing obvious to undo. Also covers a real city that fell
  // outside the chip query's row cap, or past MAX_CITY_CHIPS — it still filters,
  // it just has no chip of its own.
  const selectionIsKnown = cities.some((name) => foldCityName(name) === selectedKey)

  return (
    // `w-full` alongside `mx-auto max-w-*` is the standing rule for every <main>
    // here. It is redundant while <body> is a block container, and it stays so
    // that an ancestor becoming a flex or grid container again cannot quietly
    // reintroduce the auto-margin trap that once pinned every page to its own
    // max-width on a phone.
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">What is on</h1>
        <Link href="/host" className="shrink-0 text-sm underline">
          Host an event
        </Link>
      </div>

      {/* Rendered whether or not a filter is active, so changing city costs one
          navigation rather than a round trip out through the national feed. One
          city needs no chooser — but it does need one while something is
          filtered, or there is no way back. */}
      {(cities.length > 1 || selectedCity) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          {/* min-w-0 on every chip, not just break-words. These are flex items,
              and a flex item's automatic minimum size is its min-content width —
              which `overflow-wrap` does not reduce, because it is allowed to
              break a word for layout but not to claim the word is narrower than
              it is. An 80-character unbroken city is valid (Zod caps at 80) and
              without this it pushed the row 265px past a 390px viewport and
              scrolled the whole page sideways. Same trap as Tasks 8 and 9. */}
          {cities.map((name) => {
            const selected = foldCityName(name) === selectedKey
            return (
              <Link
                key={name}
                // The selected chip toggles itself off, which is what a filled
                // chip is expected to do. "Clear" says the same thing in words
                // for anyone who does not expect it.
                href={selected ? '/' : `/?city=${encodeURIComponent(name)}`}
                aria-current={selected ? 'true' : undefined}
                className={`min-w-0 rounded-full px-3 py-1 break-words ${
                  selected ? 'bg-black text-white' : 'border border-zinc-300'
                }`}
              >
                {name}
              </Link>
            )
          })}

          {/* Shows the string the feed actually filtered on, truncated to the
              same MAX_CITY_LENGTH the query uses — not the raw URL value. A
              hand-made `?city=` of 9,000 characters otherwise painted all of
              them: no overflow, thanks to min-w-0 above, but a link forwarded
              into a group chat that renders the feed as one enormous black bar,
              and this product travels by forwarded link. */}
          {selectedCity && !selectionIsKnown && (
            <span className="min-w-0 rounded-full bg-black px-3 py-1 break-words text-white">
              {selectedCity.trim().slice(0, MAX_CITY_LENGTH)}
            </span>
          )}

          {selectedCity && (
            <Link href="/" className="underline">
              Clear
            </Link>
          )}
        </div>
      )}

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          Nothing on right now. <Link href="/host/events/new" className="underline">Host something.</Link>
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {events.map((event, index) => (
            // Only the first card is preloaded: it is the one above the fold,
            // so it is the largest contentful paint worth not queueing.
            <EventCard key={event.id} event={event} preload={index === 0} />
          ))}
        </div>
      )}
    </main>
  )
}
