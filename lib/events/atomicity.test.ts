import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, userClient, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()
let seed: SeededEvent

/** Every parameter the update function takes, with sane values. */
function updateArgs(overrides: Record<string, unknown> = {}) {
  return {
    p_event_id: seed.eventId,
    p_title: 'Atomicity Probe Supper Club',
    p_description: null,
    p_city: 'Indore',
    p_venue_name: 'The Terrace',
    p_venue_address: null,
    p_cover_image_url: null,
    p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    p_ends_at: null,
    p_requires_approval: false,
    p_allows_cash: false,
    p_hide_venue_until_approved: false,
    p_price_paise: 50_000,
    p_quantity: 20,
    ...overrides,
  }
}

beforeAll(async () => {
  seed = await seedEvent(db, { quantity: 20, pricePaise: 50_000, status: 'draft' })
})

afterAll(async () => {
  await cleanupEvent(db, seed)
})

describe('update_event_with_ticket_type', () => {
  it('rolls the seats back when the event write is refused', async () => {
    const user = userClient(seed.hostProfileId)
    const starts = new Date(Date.now() + 7 * 24 * 3600 * 1000)

    // Seats change AND an ends_at that trips events_end_after_start. The seats
    // write happens first inside the function, so without a transaction it
    // would already have committed by the time the event write is refused.
    const { error } = await user.rpc(
      'update_event_with_ticket_type',
      updateArgs({
        p_quantity: 99,
        p_starts_at: starts.toISOString(),
        p_ends_at: new Date(starts.getTime() - 3600_000).toISOString(),
      }),
    )

    // Pinned on the constraint, not merely on "something failed": a function
    // that raised EH002 unconditionally would satisfy a bare non-null check AND
    // leave the seats at 20, so the postcondition below proves nothing on its
    // own. This says the write got as far as the events UPDATE and was refused
    // there — which is the only refusal that has anything to roll back.
    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('events_end_after_start')

    const { data } = await db
      .from('ticket_types')
      .select('quantity')
      .eq('id', seed.ticketTypeId)
      .single()
    expect(data!.quantity).toBe(20) // never moved
  })

  it('reports the reserved count as EH001 rather than a constraint name', async () => {
    await db.from('ticket_types').update({ reserved_count: 5 }).eq('id', seed.ticketTypeId)
    const user = userClient(seed.hostProfileId)

    const { error } = await user.rpc('update_event_with_ticket_type', updateArgs({ p_quantity: 2 }))

    // This assertion pins the wire contract the mapper in Task 3 is built on:
    // the custom SQLSTATE reaches supabase-js as `code`, and DETAIL as `details`.
    expect(error?.code).toBe('EH001')
    expect(error?.details).toBe('5')

    await db.from('ticket_types').update({ reserved_count: 0 }).eq('id', seed.ticketTypeId)
  })

  it('refuses an event belonging to another host as EH002', async () => {
    const stranger = await seedEvent(db, { status: 'draft' })
    const user = userClient(stranger.hostProfileId)

    const { error } = await user.rpc('update_event_with_ticket_type', updateArgs())

    expect(error?.code).toBe('EH002')

    await cleanupEvent(db, stranger)
  })

  it('refuses a caller with no host row even when RLS is not in the picture', async () => {
    // The service role bypasses RLS entirely and carries no auth.uid(), so
    // current_host_id() is null. This is what proves the function's own host_id
    // scoping refuses a caller the policies would not have stopped — the same
    // defence in depth the `.eq('host_id', hostId)` in the TypeScript carried.
    const { error } = await db.rpc('update_event_with_ticket_type', updateArgs())

    expect(error?.code).toBe('EH002')
  })

  it('creates a ticket type when the event has none', async () => {
    const bare = await seedEvent(db, { status: 'draft' })
    await db.from('ticket_types').delete().eq('id', bare.ticketTypeId)
    const user = userClient(bare.hostProfileId)

    const { error } = await user.rpc('update_event_with_ticket_type', {
      ...updateArgs({ p_event_id: bare.eventId }),
      p_price_paise: 25_000,
      p_quantity: 7,
    })
    expect(error).toBeNull()

    const { data } = await db
      .from('ticket_types')
      .select('name, price_paise, quantity')
      .eq('event_id', bare.eventId)
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ name: 'General', price_paise: 25_000, quantity: 7 })

    await cleanupEvent(db, bare)
  })
})

describe('create_event_with_ticket_type', () => {
  it('leaves no event behind when the ticket type is invalid', async () => {
    const user = userClient(seed.hostProfileId)
    const slug = `atomicity-create-${crypto.randomUUID().slice(0, 8)}`

    // quantity 0 trips ticket_types' `check (quantity > 0)` on the second
    // insert. Note this same postcondition holds under the old compensating
    // delete, so it is a regression guard, not mutation evidence — see the spec.
    const { error } = await user.rpc('create_event_with_ticket_type', {
      p_host_id: seed.hostId,
      p_slug: slug,
      p_title: 'Create Atomicity Probe',
      p_description: null,
      p_city: 'Indore',
      p_venue_name: null,
      p_venue_address: null,
      p_cover_image_url: null,
      p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      p_ends_at: null,
      p_requires_approval: false,
      p_allows_cash: false,
      p_hide_venue_until_approved: false,
      p_price_paise: 50_000,
      p_quantity: 0,
    })

    // Same reasoning as the update rollback above: pinned on the ticket_types
    // constraint, so this cannot pass by failing earlier than intended and
    // never reaching the events insert at all.
    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('ticket_types_quantity_check')

    const { data } = await db.from('events').select('id').eq('slug', slug)
    expect(data ?? []).toHaveLength(0)
  })

  it('returns the event row so the caller can redirect to it', async () => {
    const user = userClient(seed.hostProfileId)
    const slug = `atomicity-ok-${crypto.randomUUID().slice(0, 8)}`

    const { data, error } = await user.rpc('create_event_with_ticket_type', {
      p_host_id: seed.hostId,
      p_slug: slug,
      p_title: 'Create Success Probe',
      p_description: null,
      p_city: 'Indore',
      p_venue_name: null,
      p_venue_address: null,
      p_cover_image_url: null,
      p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      p_ends_at: null,
      p_requires_approval: false,
      p_allows_cash: false,
      p_hide_venue_until_approved: false,
      p_price_paise: 50_000,
      p_quantity: 12,
    })

    expect(error).toBeNull()
    // `returns events` (not `setof events`), so PostgREST hands back one object.
    expect(data).toMatchObject({ slug, status: 'draft' })
    expect((data as { id: string }).id).toBeTruthy()

    await db.from('events').delete().eq('slug', slug)
  })
})
