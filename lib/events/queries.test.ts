import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
// Importing this installs the @/lib/supabase/server mock as a side effect, which
// is why the module under test is pulled in below with `await import` — a body
// statement always runs after the imports, however they get reordered.
import { signInAs } from '@/tests/helpers/session'

const {
  getCurrentHostId,
  getOwnedEvent,
  getPublishedEventBySlug,
  listCityFeed,
  listFeedCities,
  listHostEvents,
} = await import('@/lib/events/queries')

const db = adminClient()

let published: SeededEvent
let draft: SeededEvent
let past: SeededEvent
let soon: SeededEvent
let cancelled: SeededEvent
let completed: SeededEvent
// seedEvent always writes 'Indore'. These two are the same city as the others,
// typed by hosts who did not agree about the shift key.
let shouted: SeededEvent
let whispered: SeededEvent
let publishedSlug: string
let cancelledSlug: string
let completedSlug: string

async function slugOf(eventId: string): Promise<string> {
  const { data } = await db.from('events').select('slug').eq('id', eventId).single()
  return data!.slug
}

/** seedEvent only offers draft and published, and always dates an event a week out. */
async function reshape(
  seed: SeededEvent,
  patch: { status?: string; starts_at?: string; city?: string },
): Promise<void> {
  const { error } = await db.from('events').update(patch).eq('id', seed.eventId)
  if (error) throw new Error(`reshape failed: ${error.message}`)
}

beforeAll(async () => {
  published = await seedEvent(db, { status: 'published' })
  draft = await seedEvent(db, { status: 'draft' })
  past = await seedEvent(db, { status: 'published' })
  soon = await seedEvent(db, { status: 'published' })
  cancelled = await seedEvent(db, { status: 'published' })
  completed = await seedEvent(db, { status: 'published' })
  shouted = await seedEvent(db, { status: 'published' })
  whispered = await seedEvent(db, { status: 'published' })

  await reshape(shouted, { city: 'INDORE' })
  await reshape(whispered, { city: 'indore' })

  // Something behind us, so the feed's "upcoming" filter has work to do.
  await reshape(past, { starts_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })
  // A day out against published's week, so "soonest first" is falsifiable.
  await reshape(soon, { starts_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
  // Left in the future on purpose: if these were also past, the starts_at filter
  // would hide them and the status filter would go untested.
  await reshape(cancelled, { status: 'cancelled' })
  await reshape(completed, { status: 'completed' })

  publishedSlug = await slugOf(published.eventId)
  cancelledSlug = await slugOf(cancelled.eventId)
  completedSlug = await slugOf(completed.eventId)
})

afterAll(async () => {
  for (const seed of [published, draft, past, soon, cancelled, completed, shouted, whispered]) {
    await cleanupEvent(db, seed)
  }
})

describe('getPublishedEventBySlug', () => {
  it('returns a published event to a signed-out visitor, with its host', async () => {
    signInAs(null)
    const event = await getPublishedEventBySlug(publishedSlug)

    expect(event).not.toBeNull()
    expect(event!.title).toBe('Test Supper Club')
    expect(event!.ticket_types).toHaveLength(1)
    expect(event!.hosts).toMatchObject({ display_name: 'Test Host' })
  })

  it('returns null for an unknown slug', async () => {
    signInAs(null)
    expect(await getPublishedEventBySlug('no-such-event-aaaaaa')).toBeNull()
  })

  it('returns null for a draft, even to its own host', async () => {
    signInAs(draft.hostProfileId)

    // The public page must never render a draft, session or not.
    expect(await getPublishedEventBySlug(await slugOf(draft.eventId))).toBeNull()
  })

  it('returns null for a cancelled or a completed event, even to its own host', async () => {
    // Asked as the owning host, because events_select_published already hides
    // these from everyone else — so a signed-out check would prove nothing.
    //
    // What this pins down is "show published", not "hide drafts". Both events
    // are still upcoming, so if the filter were ever relaxed to neq('draft')
    // the page of a cancelled supper club would go back online, and someone
    // would turn up to it.
    signInAs(cancelled.hostProfileId)
    expect(await getPublishedEventBySlug(cancelledSlug)).toBeNull()

    signInAs(completed.hostProfileId)
    expect(await getPublishedEventBySlug(completedSlug)).toBeNull()
  })
})

describe('listCityFeed', () => {
  it('lists upcoming published events and excludes drafts and past ones', async () => {
    signInAs(null)
    const ids = (await listCityFeed()).map((e) => e.id)

    expect(ids).toContain(published.eventId)
    expect(ids).not.toContain(draft.eventId)
    expect(ids).not.toContain(past.eventId)

    // Signed out, RLS hides the draft by itself, so the assertion above holds
    // whether or not listCityFeed filters on status at all. Asking as the
    // draft's own host — the one caller RLS shows it to — is what pins it down.
    signInAs(draft.hostProfileId)
    expect((await listCityFeed()).map((e) => e.id)).not.toContain(draft.eventId)
  })

  it('excludes cancelled and completed events', async () => {
    // Both are still upcoming, and each is asked for by its own host, so RLS
    // shows it: the status filter is the only thing that can keep a cancelled
    // event out of the feed.
    signInAs(cancelled.hostProfileId)
    expect((await listCityFeed()).map((e) => e.id)).not.toContain(cancelled.eventId)

    signInAs(completed.hostProfileId)
    expect((await listCityFeed()).map((e) => e.id)).not.toContain(completed.eventId)
  })

  it('orders upcoming events soonest first', async () => {
    signInAs(null)
    const ids = (await listCityFeed()).map((e) => e.id)

    // indexOf returns -1 for a missing id, which would sort "first" and pass the
    // comparison for the wrong reason. Hence the containment checks.
    expect(ids).toContain(soon.eventId)
    expect(ids).toContain(published.eventId)
    expect(ids.indexOf(soon.eventId)).toBeLessThan(ids.indexOf(published.eventId))
  })

  it('filters by city', async () => {
    signInAs(null)
    expect((await listCityFeed('Indore')).map((e) => e.id)).toContain(published.eventId)
    expect(await listCityFeed('Nowhere-on-Sea')).toEqual([])
  })

  it('matches a city whatever case the host typed it in', async () => {
    // city is free text on a form. Matched exactly, one Indore becomes three
    // cities with three partial feeds, and each host wonders where everyone is.
    signInAs(null)
    const ids = (await listCityFeed('iNdOrE')).map((e) => e.id)

    expect(ids).toContain(published.eventId) // 'Indore'
    expect(ids).toContain(shouted.eventId) // 'INDORE'
    expect(ids).toContain(whispered.eventId) // 'indore'
  })

  it('reads a wildcard as a literal city name rather than a pattern', async () => {
    // The regression this guards: `?city=` goes straight into an ILIKE pattern,
    // so an unescaped `.ilike('city', city)` hands any visitor a URL — `?city=%`
    // — that returns every city on the platform while looking like a working
    // filter. escapeLikePattern is the only thing standing between the two.
    // '_ndore' is the sharpest case: unescaped, it matches Indore.
    signInAs(null)

    expect(await listCityFeed('%')).toEqual([])
    expect(await listCityFeed('*')).toEqual([])
    expect(await listCityFeed('%%%')).toEqual([])
    expect(await listCityFeed('_ndore')).toEqual([])
    expect(await listCityFeed('Ind__e')).toEqual([])
    expect(await listCityFeed('%Indore%')).toEqual([])
    expect(await listCityFeed('x'.repeat(500))).toEqual([])
  })

  it('finds a city whose name contains a wildcard character', async () => {
    // The other half of escaping: a literal % in a stored city has to stay
    // findable, not just be neutralised. Fails if the escape is ever "strip the
    // special characters" rather than "escape them".
    await reshape(soon, { city: 'Ind%re' })
    signInAs(null)

    const ids = (await listCityFeed('Ind%re')).map((e) => e.id)
    expect(ids).toContain(soon.eventId)
    // ...and it is a literal match, not a pattern that happens to hit Indore.
    expect(ids).not.toContain(published.eventId)

    await reshape(soon, { city: 'Indore' })
  })

  it('finds a city that is absent from the chip list', async () => {
    // listCityFeed must resolve the visitor's city against the database, never
    // against listFeedCities(). An earlier version looked the city up in that
    // list and returned [] when it was missing — and that list has a row cap, so
    // a real city past the cap rendered an empty feed. That was strictly worse
    // than the case-sensitive matching it replaced, which at least still found
    // the city by URL. Simulated here by filtering for a city that exists while
    // asserting nothing about whether it is offered as a chip.
    await reshape(soon, { city: 'Rarecity' })
    signInAs(null)

    expect((await listCityFeed('Rarecity')).map((e) => e.id)).toContain(soon.eventId)
    expect((await listCityFeed('rarecity')).map((e) => e.id)).toContain(soon.eventId)

    await reshape(soon, { city: 'Indore' })
  })
})

describe('listFeedCities', () => {
  it('collapses spellings of one city into a single entry', async () => {
    signInAs(null)
    const indore = (await listFeedCities()).filter((name) => name.toLowerCase() === 'indore')

    // Three stored spellings — 'Indore', 'INDORE', 'indore' — one chip.
    expect(indore).toHaveLength(1)
  })

  it('shows a deliberately capitalised spelling rather than a shouted one', async () => {
    signInAs(null)
    const indore = (await listFeedCities()).find((name) => name.toLowerCase() === 'indore')

    // Not whichever spelling sorted first — that hands the chip to INDORE on
    // the strength of a capital letter's place in the ASCII table.
    expect(indore).toBe('Indore')
  })

  it('is not narrowed by the feed\'s own row limit', async () => {
    // The point of the separate query. listCityFeed caps at 50 rows nationally,
    // so a chip row derived from its result would drop a city whose next event
    // falls outside that window — silently, with no error and no traffic.
    signInAs(null)
    const [cities, feed] = await Promise.all([listFeedCities(), listCityFeed()])

    expect(feed.length).toBeLessThanOrEqual(50)
    for (const city of new Set(feed.map((e) => e.city.trim().toLowerCase()))) {
      expect(cities.map((name) => name.toLowerCase())).toContain(city)
    }
  })

  it('ignores drafts, past events and cancelled ones', async () => {
    // Asked as each event's own host, because RLS already hides a draft from
    // everyone else — a signed-out check would prove nothing about the filter.
    await reshape(draft, { city: 'Draftsville' })
    await reshape(past, { city: 'Yesterbury' })
    await reshape(cancelled, { city: 'Calledoff' })

    for (const seed of [draft, past, cancelled]) {
      signInAs(seed.hostProfileId)
      const names = await listFeedCities()
      expect(names).not.toContain('Draftsville')
      expect(names).not.toContain('Yesterbury')
      expect(names).not.toContain('Calledoff')
    }
  })
})

describe('getCurrentHostId', () => {
  it('returns the host id for a signed-in host', async () => {
    signInAs(draft.hostProfileId)
    expect(await getCurrentHostId()).toBe(draft.hostId)
  })

  it('returns null when signed out', async () => {
    signInAs(null)
    expect(await getCurrentHostId()).toBeNull()
  })
})

describe('listHostEvents', () => {
  it('returns the calling host\'s own events, drafts included', async () => {
    signInAs(draft.hostProfileId)
    const ids = (await listHostEvents()).map((e) => e.id)

    expect(ids).toEqual([draft.eventId])
  })

  it('does not leak another host\'s published event', async () => {
    // The regression this guards: events_select_published makes EVERY published
    // event readable, so a listHostEvents() that trusts RLS alone would hand a
    // host the entire platform's catalogue as "your events".
    signInAs(draft.hostProfileId)
    const ids = (await listHostEvents()).map((e) => e.id)

    expect(ids).not.toContain(published.eventId)
  })

  it('returns an empty list for a signed-in user who is not a host', async () => {
    signInAs(published.attendeeId)
    expect(await listHostEvents()).toEqual([])
  })
})

describe('getOwnedEvent', () => {
  it('returns the host\'s own draft', async () => {
    signInAs(draft.hostProfileId)
    const event = await getOwnedEvent(draft.eventId)

    expect(event).not.toBeNull()
    expect(event!.id).toBe(draft.eventId)
  })

  it('refuses another host\'s event even though it is published', async () => {
    signInAs(draft.hostProfileId)
    expect(await getOwnedEvent(published.eventId)).toBeNull()
  })

  it('returns null when signed out', async () => {
    signInAs(null)
    expect(await getOwnedEvent(draft.eventId)).toBeNull()
  })
})
