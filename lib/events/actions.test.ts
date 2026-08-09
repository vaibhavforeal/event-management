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
const STRANDED_TITLE = 'Stranded Probe Supper Club'

/** A `from()` stand-in whose only operation, `insert`, fails. */
function insertFails(message: string) {
  return { insert: async () => ({ data: null, error: { message } }) }
}

/** A `from()` stand-in whose only operation, `update(...).eq(...)`, fails. */
function updateFails(message: string) {
  return { update: () => ({ eq: async () => ({ data: null, error: { message } }) }) }
}

/** Wraps a real query builder so that only `delete(...).eq(...)` fails. */
function deleteFails(builder: object, message: string): object {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'delete') return () => ({ eq: async () => ({ data: null, error: { message } }) })
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string> = {
    title: 'Diwali Supper Club',
    city: 'Indore',
    venueName: 'The Terrace',
    startsAtLocal: '2026-11-14T19:30',
    seats: '20',
    priceRupees: '500',
    hostDisplayName: 'Priya',
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

    const { data: after } = await db.from('hosts').select('id, display_name').eq('profile_id', aliceId)
    expect(after).toHaveLength(1)
    // Under the name she typed, which is the whole point of asking for one.
    expect(after![0].display_name).toBe('Priya')

    eventId = target.split('/')[3]
  })

  it('never falls back to the host\'s phone number for a display name', async () => {
    // The defect this exists to keep dead: display_name fell back to
    // profiles.phone, nothing writes profiles.full_name, so every host's
    // WhatsApp number was rendered under "Host" in the served HTML of the page
    // designed to be forwarded into a group chat — permanently, because no
    // screen could change it.
    const carol = await createTestUser(db)
    const { data: profile } = await db.from('profiles').select('phone').eq('id', carol).single()
    const digits = profile!.phone.replace(/\D/g, '')
    signInAs(carol)

    // No hostDisplayName at all, i.e. a POST that skipped the form.
    const target = await captureRedirect(() => createEvent({}, form({ hostDisplayName: '' })))
    const createdId = target.split('/')[3]

    const { data: host } = await db
      .from('hosts')
      .select('display_name')
      .eq('profile_id', carol)
      .single()

    // Both forms, because GoTrue stores the number without the leading plus.
    expect(host!.display_name).not.toContain(digits)
    expect(host!.display_name).not.toContain(profile!.phone)
    expect(host!.display_name).toBe('Host')

    await db.from('events').delete().eq('id', createdId)
    await db.from('hosts').delete().eq('profile_id', carol)
    await db.auth.admin.deleteUser(carol).catch(() => {})
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
    const failing = clientWithFrom(userClient(aliceId), (table) =>
      table === 'ticket_types' ? insertFails('simulated ticket_types outage') : null,
    )

    const state = await actionsWith(failing, (actions) =>
      actions.createEvent({}, form({ title: ROLLBACK_TITLE })),
    )

    // The exact string, because `toBeTruthy()` would also hold if the events
    // insert were what failed — in which case there would be nothing to roll
    // back and the assertion below would pass without the rollback existing.
    expect(state.error).toBe('simulated ticket_types outage')

    const { data } = await db.from('events').select('id').eq('title', ROLLBACK_TITLE)
    expect(data ?? []).toHaveLength(0)
  })

  it('names the stranded event when the rollback itself fails', async () => {
    // Two statements, no transaction: the rollback can fail on its own. Silence
    // there would leave exactly the unpublishable draft the rollback exists to
    // prevent, with the host told only that tickets failed.
    const base = userClient(aliceId)
    const failing = clientWithFrom(base, (table) => {
      if (table === 'ticket_types') return insertFails('simulated ticket_types outage')
      if (table === 'events') return deleteFails(base.from('events'), 'simulated delete outage')
      return null
    })

    const state = await actionsWith(failing, (actions) =>
      actions.createEvent({}, form({ title: STRANDED_TITLE })),
    )

    const { data } = await db.from('events').select('id').eq('title', STRANDED_TITLE)
    expect(data).toHaveLength(1) // it really is stranded

    expect(state.error).toContain('simulated ticket_types outage')
    expect(state.error).toContain('simulated delete outage')
    expect(state.error).toContain(data![0].id) // recoverable by hand

    await db.from('events').delete().eq('id', data![0].id)
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

  it('refuses to publish a cancelled event', async () => {
    // Publishing a called-off supper club would put it back in the feed and
    // someone would turn up to it.
    signInAs(aliceId)
    await db.from('events').update({ status: 'cancelled' }).eq('id', eventId)

    const state = await publishEvent({}, formWithId(eventId))

    expect(state.error).toMatch(/cancelled/)
    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('cancelled')

    await db.from('events').update({ status: 'draft' }).eq('id', eventId)
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
  // there. Published, the row IS readable by Bob (asserted below).
  it('refuses to publish an event belonging to another host', async () => {
    const { data: visible } = await userClient(bobId)
      .from('events')
      .select('id')
      .eq('id', eventId)
      .maybeSingle()
    expect(visible).not.toBeNull() // the row is not hidden from Bob; ownership is

    signInAs(bobId)
    const state = await publishEvent({}, formWithId(eventId))

    // The ownership message specifically, not merely "some error". Bob is also
    // refused by the status guard two lines further down — this event is already
    // published — so a bare toBeTruthy() would still pass with the host filter
    // deleted, and the guard would go untested.
    expect(state.error).toMatch(/not yours/)

    const { data } = await db.from('events').select('published_at').eq('id', eventId).single()
    expect(data!.published_at).toBe(publishedAt) // Bob did not restamp it
  })

  it('refuses to publish an event that is already published', async () => {
    signInAs(aliceId)
    const state = await publishEvent({}, formWithId(eventId))

    expect(state.error).toMatch(/already published/)
    expect(state.ok).toBeUndefined()

    const { data } = await db.from('events').select('published_at').eq('id', eventId).single()
    expect(data!.published_at).toBe(publishedAt) // no restamp, so no reordering
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

    // The form carries a display name on every submission, and it writes to the
    // host row rather than the event row — so a refused edit must not still
    // rename the person who sent it. Bob is called Bob.
    const { data: bob } = await db
      .from('hosts')
      .select('display_name')
      .eq('profile_id', bobId)
      .single()
    expect(bob!.display_name).toBe('Bob')
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

    // Values that differ from the stored ones on every writable table, because
    // the seats write now happens first: an unowned edit that got that far would
    // reprice Alice's tickets before the events update refused it.
    const fd = form({ title: 'Defaced without RLS', seats: '3', priceRupees: '1' })
    fd.set('eventId', eventId)

    const state = await actionsWith(rlsFree, (actions) => actions.updateEvent({}, fd))
    expect(state.error).toBeTruthy()
    expect(state.ok).toBeUndefined()

    const { data } = await db.from('events').select('title').eq('id', eventId).single()
    expect(data!.title).toBe('Diwali Supper Club (fixed typo)')

    const { data: tickets } = await db
      .from('ticket_types')
      .select('price_paise, quantity')
      .eq('event_id', eventId)
      .single()
    expect(tickets).toMatchObject({ price_paise: 50_000, quantity: 20 })
  })

  it('refuses to cut seats below what is already reserved, writing nothing', async () => {
    await db.from('ticket_types').update({ reserved_count: 5 }).eq('event_id', eventId)
    signInAs(aliceId)

    const fd = form({ title: 'Half-saved', city: 'Bhopal', seats: '2' })
    fd.set('eventId', eventId)
    const state = await updateEvent({}, fd)

    // A refusal the host can read, not `ticket_types_no_oversell`.
    expect(state.blockers ?? []).toHaveLength(1)
    expect(state.blockers![0]).toContain('5')
    expect(state.ok).toBeUndefined()

    // The point of the pre-check: the event must not be half-saved. Before the
    // events update was moved after the seats update, title and city here were
    // already written by the time the host was told the save had failed.
    const { data } = await db.from('events').select('title, city').eq('id', eventId).single()
    expect(data).toMatchObject({ title: 'Diwali Supper Club (fixed typo)', city: 'Indore' })

    const { data: tickets } = await db
      .from('ticket_types')
      .select('quantity')
      .eq('event_id', eventId)
      .single()
    expect(tickets!.quantity).toBe(20)

    await db.from('ticket_types').update({ reserved_count: 0 }).eq('event_id', eventId)
  })

  it('surfaces a rejected seats write and leaves the event alone', async () => {
    // The pre-check above cannot catch a booking that lands between the read and
    // the write, so ticket_types_no_oversell is still the backstop and the action
    // must not swallow it. Injected, because that race cannot be staged here.
    const base = userClient(aliceId)
    const failing = clientWithFrom(base, (table) =>
      table === 'ticket_types' ? updateFails('simulated no_oversell rejection') : null,
    )

    const fd = form({ title: 'Half-saved', city: 'Bhopal' })
    fd.set('eventId', eventId)

    const state = await actionsWith(failing, (actions) => actions.updateEvent({}, fd))
    expect(state.error).toBe('Could not update seats: simulated no_oversell rejection')

    const { data } = await db.from('events').select('title, city').eq('id', eventId).single()
    expect(data).toMatchObject({ title: 'Diwali Supper Club (fixed typo)', city: 'Indore' })
  })

  it('renames the host when they change the name guests see', async () => {
    // The only screen that can write hosts.display_name, so if this does not
    // work the name is set once at creation and stuck there forever — which is
    // the state that made the phone-number fallback permanent.
    signInAs(aliceId)
    const fd = form({
      title: 'Diwali Supper Club (fixed typo)',
      hostDisplayName: 'Priya from Indore',
    })
    fd.set('eventId', eventId)

    const state = await updateEvent({}, fd)
    expect(state.ok).toBe(true)

    const { data } = await db
      .from('hosts')
      .select('display_name')
      .eq('profile_id', aliceId)
      .single()
    expect(data!.display_name).toBe('Priya from Indore')
  })

  it('writes the seats and price to one ticket type, not every one the event has', async () => {
    // Every other test in this file runs against an event with exactly one
    // ticket type, where `.eq('event_id', ...)` and `.eq('id', ...)` cannot be
    // told apart. The second row below is the entire point: the form carries one
    // seats field and one price field, so writing them by event_id sets the same
    // pair on every tier the event owns — silently, the moment Phase 2 adds one.
    const { data: vip, error } = await db
      .from('ticket_types')
      .insert({
        event_id: eventId,
        name: 'VIP',
        price_paise: 250_000,
        quantity: 5,
        sort_order: 1, // sorts after General, so General stays the row `[0]` picks
      })
      .select('id')
      .single()
    if (error) throw new Error(`seeding a second ticket type failed: ${error.message}`)

    signInAs(aliceId)
    const fd = form({
      title: 'Diwali Supper Club (fixed typo)',
      hostDisplayName: 'Priya from Indore',
      seats: '25',
      priceRupees: '600',
    })
    fd.set('eventId', eventId)

    expect((await updateEvent({}, fd)).ok).toBe(true)

    const { data: general } = await db
      .from('ticket_types')
      .select('price_paise, quantity')
      .eq('event_id', eventId)
      .eq('name', 'General')
      .single()
    expect(general).toMatchObject({ price_paise: 60_000, quantity: 25 })

    const { data: untouched } = await db
      .from('ticket_types')
      .select('price_paise, quantity')
      .eq('id', vip!.id)
      .single()
    expect(untouched).toMatchObject({ price_paise: 250_000, quantity: 5 })

    await db.from('ticket_types').delete().eq('id', vip!.id)
  })

  it('creates the ticket type when the event has none left', async () => {
    // Reachable: createEvent's rollback is two statements and can be interrupted
    // between them. Updating by event_id matched zero rows, which PostgREST
    // reports as success — so the host was told "Saved." while the seats and
    // price they had just typed went nowhere at all.
    await db.from('ticket_types').delete().eq('event_id', eventId)

    signInAs(aliceId)
    const fd = form({
      title: 'Diwali Supper Club (fixed typo)',
      hostDisplayName: 'Priya from Indore',
      seats: '30',
      priceRupees: '700',
    })
    fd.set('eventId', eventId)

    expect((await updateEvent({}, fd)).ok).toBe(true)

    const { data } = await db
      .from('ticket_types')
      .select('name, price_paise, quantity')
      .eq('event_id', eventId)

    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ name: 'General', price_paise: 70_000, quantity: 30 })
  })
})

describe('unpublishEvent', () => {
  it('refuses another host, with RLS taken out of the picture', async () => {
    // Same reasoning as the updateEvent pair: events_update_own refuses Bob on
    // its own, so an RLS-scoped test cannot tell the action's host_id filter
    // from the policy. Reaching the tables as the service role leaves the filter
    // as the only thing between Bob and pulling Alice's live event offline.
    const rlsFree = clientWithFrom(userClient(bobId), (table) => db.from(table))

    const state = await actionsWith(rlsFree, (actions) =>
      actions.unpublishEvent({}, formWithId(eventId)),
    )
    expect(state.error).toBeTruthy()
    expect(state.ok).toBeUndefined()

    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('published')
  })

  it('returns a published event to draft', async () => {
    signInAs(aliceId)
    const state = await unpublishEvent({}, formWithId(eventId))

    expect(state.ok).toBe(true)
    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('draft')
  })
})

describe('the eventId guard', () => {
  it('refuses a submission with no event id instead of leaking a Postgres error', async () => {
    // '' is not a uuid, so without the guard PostgREST answers
    // `invalid input syntax for type uuid: ""` and the host sees that.
    signInAs(aliceId)
    const empty = new FormData()

    expect((await updateEvent({}, empty)).error).toBe('Missing event id')
    expect((await publishEvent({}, empty)).error).toBe('Missing event id')
    expect((await unpublishEvent({}, empty)).error).toBe('Missing event id')
  })
})

function formWithId(id: string): FormData {
  const fd = new FormData()
  fd.set('eventId', id)
  return fd
}
