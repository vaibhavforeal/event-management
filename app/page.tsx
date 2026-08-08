import Link from 'next/link'
import { EventCard } from '@/app/_components/event-card'
import { listCityFeed } from '@/lib/events/queries'

export const metadata = {
  title: 'What is on',
  description: 'Supper clubs, board-game nights, workshops and pop-ups near you.',
}

export default async function FeedPage(props: PageProps<'/'>) {
  const { city } = await props.searchParams
  const selectedCity = typeof city === 'string' ? city : undefined
  const events = await listCityFeed(selectedCity)

  // Cities present in the current result set, so the filter never offers a
  // choice that leads to an empty page.
  const cities = [...new Set(events.map((event) => event.city))].sort()

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">What is on</h1>
        <Link href="/host" className="text-sm underline">
          Host an event
        </Link>
      </div>

      {selectedCity && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="rounded-full bg-black px-3 py-1 text-white">{selectedCity}</span>
          <Link href="/" className="underline">
            Clear
          </Link>
        </div>
      )}

      {!selectedCity && cities.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {cities.map((name) => (
            <Link
              key={name}
              href={`/?city=${encodeURIComponent(name)}`}
              className="rounded-full border border-zinc-300 px-3 py-1 text-sm"
            >
              {name}
            </Link>
          ))}
        </div>
      )}

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          Nothing on right now. <Link href="/host/events/new" className="underline">Host something.</Link>
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </main>
  )
}
