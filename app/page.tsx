import Link from 'next/link'
import { EventCard } from '@/app/_components/event-card'
import { foldCityName, listCityFeed, listFeedCities } from '@/lib/events/queries'

export const metadata = {
  title: 'What is on',
  description: 'Supper clubs, board-game nights, workshops and pop-ups near you.',
}

export default async function FeedPage(props: PageProps<'/'>) {
  const { city } = await props.searchParams
  const selectedCity = typeof city === 'string' ? city : undefined

  // The chip row is NOT derived from `events`. The feed is capped at 50 rows
  // nationally, so deriving the cities from it would mean that past fifty
  // upcoming events a city simply stopped being offered — a silent hole in
  // navigation, on a product whose entire discovery story is this one page.
  // listFeedCities() answers "which cities have something on" independently of
  // that cap, and folds case so one city is one chip.
  const [events, cities] = await Promise.all([listCityFeed(selectedCity), listFeedCities()])

  const selectedKey = selectedCity ? foldCityName(selectedCity) : undefined
  // A hand-typed ?city= that matches nothing published still has to be visible:
  // otherwise the empty state reads as "nothing on anywhere", with no clue what
  // is filtered and nothing obvious to undo.
  const selectionIsKnown = cities.some((known) => foldCityName(known.name) === selectedKey)

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
          {cities.map((known) => {
            const selected = foldCityName(known.name) === selectedKey
            return (
              <Link
                key={known.name}
                // The selected chip toggles itself off, which is what a filled
                // chip is expected to do. "Clear" says the same thing in words
                // for anyone who does not expect it.
                href={selected ? '/' : `/?city=${encodeURIComponent(known.name)}`}
                aria-current={selected ? 'true' : undefined}
                className={`rounded-full px-3 py-1 break-words ${
                  selected ? 'bg-black text-white' : 'border border-zinc-300'
                }`}
              >
                {known.name}
              </Link>
            )
          })}

          {selectedCity && !selectionIsKnown && (
            <span className="rounded-full bg-black px-3 py-1 break-words text-white">
              {selectedCity}
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
            // Only the first card gets priority: it is the one above the fold,
            // so it is the largest contentful paint worth not queueing.
            <EventCard key={event.id} event={event} priority={index === 0} />
          ))}
        </div>
      )}
    </main>
  )
}
