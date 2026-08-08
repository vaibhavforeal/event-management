import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { adminClient, createTestUser, userClient } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

// revalidatePath needs a request store; there isn't one here.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))

// Next's redirect() signals by throwing. Reproduce that so the test can assert
// a redirect happened without depending on Next's internal error shape.
class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`)
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
  notFound: () => {
    throw new Error('notFound')
  },
}))

const { createEvent, publishEvent, unpublishEvent, updateEvent } = await import(
  '@/app/host/events/actions'
)

const db = adminClient()

const ROLLBACK_TITLE = 'Rollback Probe Supper Club'

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string> = {
    title: 'Diwali Supper Club',
    city: 'Indore',
    venueName: 'The Terrace',
    startsAtLocal: '2026-11-14T19:30',
    seats: '20',
    priceRupees: '500',
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== '') fd.set(key, value)
  }
  return fd
}

/** Runs an action that is expected to redirect, returning the target path. */
async function captureRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to
    throw error
  }
  throw new Error('Expected a redirect, but the action returned normally')
}

type Actions = typeof import('@/app/host/events/actions')

/**
 * Substitutes the client the actions run on, for the two things the RLS-scoped
 * client cannot express: a table write that fails, and a write RLS would have
 * refused anyway.
 *
 * The seam is the same one `tests/helpers/session.ts` mocks, re-registered with
 * `doMock` and a module reset so this call gets its own copy of the actions
 * bound to it. The copy is discarded afterwards; the top-level `createEvent`
 * and friends keep running on the session client.
 */
async function actionsWith<T>(
  client: SupabaseClient,
  run: (actions: Actions) => Promise<T>,
): Promise<T> {
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }))
  vi.resetModules()
  try {
    return await run(await import('@/app/host/events/actions'))
  } finally {
    vi.doUnmock('@/lib/supabase/server')
    vi.resetModules()
  }
}

/**
 * A real client with `from()` redirected for chosen tables. Everything else —
 * `auth` above all — stays real, so the action still resolves a real session
 * and a real host id.
 */
function clientWithFrom(
  base: SupabaseClient,
  override: (table: string) => object | null,
): SupabaseClient {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'from') return (table: string) => override(table) ?? target.from(table)
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

let aliceId: string
let bobId: string
let eventId: string
let slug: string
let publishedAt: string

beforeAll(async () => {
  aliceId = await createTestUser(db)
  bobId = await createTestUser(db)

  // Bob is a host from the outset. Every cross-host test needs him to get past
  // getCurrentHostId(), and Alice must NOT have a hosts row yet — the second
  // createEvent test is what proves the action creates it.
  await db.from('hosts').insert({ profile_id: bobId, display_name: 'Bob' })
})

afterAll(async () => {
  if (eventId) await db.from('events').delete().eq('id', eventId)
  // Events cascade from hosts, so a stranded rollback probe goes with them.
  await db.from('hosts').delete().eq('profile_id', aliceId)
  await db.from('hosts').delete().eq('profile_id', bobId)
  await db.auth.admin.deleteUser(aliceId).catch(() => {})
  await db.auth.admin.deleteUser(bobId).catch(() => {})
})

describe('createEvent', () => {
  it('rejects a form missing the columns Postgres requires', async () => {
    signInAs(aliceId)
    const state = await createEvent({}, form({ title: '', city: '' }))

    expect(state.fieldErrors?.title).toBeTruthy()
    expect(state.fieldErrors?.city).toBeTruthy()
  })

  it('creates the host row implicitly on first event', async () => {
    signInAs(aliceId)
    const { data: before } = await db.from('hosts').select('id').eq('profile_id', aliceId)
    expect(before ?? []).toHaveLength(0)

    const target = await captureRedirect(() => createEvent({}, form()))
    expect(target).toMatch(/^\/host\/events\/[0-9a-f-]+\/edit$/)

    const { data: after } = await db.from('hosts').select('id').eq('profile_id', aliceId)
    expect(after).toHaveLength(1)

    eventId = target.split('/')[3]
  })

  it('stores the start time converted from IST to UTC', async () => {
    // 19:30 IST is 14:00 UTC. A 19:30Z here means the conversion was skipped.
    const { data } = await db
      .from('events')
      .select('starts_at, status, slug')
      .eq('id', eventId)
      .single()

    expect(data!.starts_at).toContain('14:00:00')
    expect(data!.status).toBe('draft')

    // Captured here rather than after publishing, so the immutability check
    // below compares against the slug as first written whatever else changes.
    slug = data!.slug
  })

  it('creates one ticket type priced in integer paise', async () => {
    const { data } = await db
      .from('ticket_types')
      .select('name, price_paise, quantity')
      .eq('event_id', eventId)

    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ name: 'General', price_paise: 50_000, quantity: 20 })
  })

  it('deletes the event again when its ticket type cannot be created', async () => {
    // No form input is acceptable to events and rejected by ticket_types, so the
    // failure is injected at the client seam instead. Without this the rollback
    // branch is unreachable from a test, and dropping it would leave an event
    // with no inventory: unpublishable forever, with no UI to add a ticket type.
    signInAs(aliceId)
    const failing = clientWithFrom(userClient(aliceId), (table) =>
      table === 'ticket_types'
        ? { insert: async () => ({ data: null, error: { message: 'simulated outage' } }) }
        : null,
    )

    const state = await actionsWith(failing, (actions) =>
      actions.createEvent({}, form({ title: ROLLBACK_TITLE })),
    )

    expect(state.error).toBeTruthy()

    const { data } = await db.from('events').select('id').eq('title', ROLLBACK_TITLE)
    expect(data ?? []).toHaveLength(0)
  })
})

describe('publishEvent', () => {
  it('reports every blocker at once rather than publishing', async () => {
    signInAs(aliceId)
    await db.from('events').update({ venue_name: null }).eq('id', eventId)

    const state = await publishEvent({}, formWithId(eventId))

    expect(state.blockers ?? []).not.toHaveLength(0)
    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('draft')

    await db.from('events').update({ venue_name: 'The Terrace' }).eq('id', eventId)
  })

  it('publishes the owner\'s complete event and stamps published_at', async () => {
    signInAs(aliceId)
    const state = await publishEvent({}, formWithId(eventId))

    expect(state.ok).toBe(true)
    const { data } = await db
      .from('events')
      .select('status, published_at, slug')
      .eq('id', eventId)
      .single()

    expect(data!.status).toBe('published')
    expect(data!.published_at).not.toBeNull()
    expect(data!.slug).toBe(slug)
    publishedAt = data!.published_at
  })

  // Deliberately after the event is published, not before. A draft is invisible
  // to Bob under events_select_published, so a cross-host attempt on a draft
  // fails whether or not the action filters on host_id — the row simply is not
  // there. Published, the row IS readable by Bob (asserted below), so the only
  // thing that can refuse him is the ownership filter.
  it('refuses to publish an event belonging to another host', async () => {
    const { data: visible } = await userClient(bobId)
      .from('events')
      .select('id')
      .eq('id', eventId)
      .maybeSingle()
    expect(visible).not.toBeNull() // the row is not hidden from Bob; ownership is

    signInAs(bobId)
    const state = await publishEvent({}, formWithId(eventId))

    expect(state.error).toBeTruthy()
    expect(state.ok).toBeUndefined()

    const { data } = await db
      .from('events')
      .select('status, published_at')
      .eq('id', eventId)
      .single()
    expect(data!.published_at).toBe(publishedAt) // Bob did not restamp it
  })
})

describe('updateEvent', () => {
  it('never changes the slug when the title changes', async () => {
    // The link is already sitting in a WhatsApp group by now.
    signInAs(aliceId)
    const fd = form({ title: 'Diwali Supper Club (fixed typo)' })
    fd.set('eventId', eventId)

    const state = await updateEvent({}, fd)
    expect(state.ok).toBe(true)

    const { data } = await db.from('events').select('slug, title').eq('id', eventId).single()
    expect(data!.slug).toBe(slug)
    expect(data!.title).toBe('Diwali Supper Club (fixed typo)')
  })

  it('refuses an edit from a different host', async () => {
    signInAs(bobId)
    const fd = form({ title: 'Defaced' })
    fd.set('eventId', eventId)

    const state = await updateEvent({}, fd)
    expect(state.error).toBeTruthy()

    const { data } = await db.from('events').select('title').eq('id', eventId).single()
    expect(data!.title).toBe('Diwali Supper Club (fixed typo)')
  })

  it('refuses that same edit with RLS taken out of the picture', async () => {
    // The test above cannot tell the action's host_id filter from the
    // events_update_own policy: both refuse Bob, and the policy would refuse him
    // even if the filter were deleted. So run it once more on a client that
    // authenticates as Bob but reaches the tables as the service role, leaving
    // the filter as the only thing between Bob and Alice's event.
    //
    // Nothing in the app builds such a client — lib/supabase/server always
    // returns an RLS-scoped one. This exists so the defence in depth is a
    // tested claim rather than a comment.
    const rlsFree = clientWithFrom(userClient(bobId), (table) => db.from(table))

    const fd = form({ title: 'Defaced without RLS' })
    fd.set('eventId', eventId)

    const state = await actionsWith(rlsFree, (actions) => actions.updateEvent({}, fd))
    expect(state.error).toBeTruthy()
    expect(state.ok).toBeUndefined()

    const { data } = await db.from('events').select('title').eq('id', eventId).single()
    expect(data!.title).toBe('Diwali Supper Club (fixed typo)')
  })

  it('surfaces the oversell guard when seats are cut below what is reserved', async () => {
    await db.from('ticket_types').update({ reserved_count: 5 }).eq('event_id', eventId)
    signInAs(aliceId)

    const fd = form({ seats: '2' })
    fd.set('eventId', eventId)
    const state = await updateEvent({}, fd)

    // ticket_types_no_oversell is the backstop; the action must not swallow it.
    expect(state.error).toBeTruthy()
    expect(state.ok).toBeUndefined()

    const { data } = await db
      .from('ticket_types')
      .select('quantity')
      .eq('event_id', eventId)
      .single()
    expect(data!.quantity).toBe(20) // rejected, not partially applied

    await db.from('ticket_types').update({ reserved_count: 0 }).eq('event_id', eventId)
  })
})

describe('unpublishEvent', () => {
  it('returns a published event to draft', async () => {
    signInAs(aliceId)
    const state = await unpublishEvent({}, formWithId(eventId))

    expect(state.ok).toBe(true)
    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('draft')
  })
})

function formWithId(id: string): FormData {
  const fd = new FormData()
  fd.set('eventId', id)
  return fd
}
