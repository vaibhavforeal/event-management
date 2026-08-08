import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
// Importing this installs the @/lib/supabase/server mock as a side effect, which
// is why the module under test is pulled in below with `await import` rather
// than a static import — it has to resolve after the mock is registered.
import { signInAs } from '@/tests/helpers/session'

const {
  getCurrentHostId,
  getOwnedEvent,
  getPublishedEventBySlug,
  listCityFeed,
  listHostEvents,
} = await import('@/lib/events/queries')

const db = adminClient()

let published: SeededEvent
let draft: SeededEvent
let past: SeededEvent
let publishedSlug: string

beforeAll(async () => {
  published = await seedEvent(db, { status: 'published' })
  draft = await seedEvent(db, { status: 'draft' })
  past = await seedEvent(db, { status: 'published' })

  // seedEvent always dates an event a week out, so the feed's "upcoming" filter
  // has nothing to exclude unless we put something behind us.
  await db
    .from('events')
    .update({ starts_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() })
    .eq('id', past.eventId)

  const { data } = await db.from('events').select('slug').eq('id', published.eventId).single()
  publishedSlug = data!.slug
})

afterAll(async () => {
  await cleanupEvent(db, published)
  await cleanupEvent(db, draft)
  await cleanupEvent(db, past)
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
    const { data } = await db.from('events').select('slug').eq('id', draft.eventId).single()
    signInAs(draft.hostProfileId)

    // The public page must never render a draft, session or not.
    expect(await getPublishedEventBySlug(data!.slug)).toBeNull()
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

  it('filters by city', async () => {
    signInAs(null)
    expect((await listCityFeed('Indore')).map((e) => e.id)).toContain(published.eventId)
    expect(await listCityFeed('Nowhere-on-Sea')).toEqual([])
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
