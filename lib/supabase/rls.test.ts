import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  anonClient,
  cleanupEvent,
  createTestUser,
  seedEvent,
  seedPlatformAdmin,
  userClient,
  type SeededEvent,
} from '@/tests/helpers/db'

/**
 * Row-level security is the last line of defence between one host's data and
 * another's. These tests exist because RLS failures are silent: nothing errors,
 * you just quietly serve the wrong rows.
 *
 * Every assertion here is an attempt to see something we should not.
 */

const db: SupabaseClient = adminClient()

let published: SeededEvent
let draft: SeededEvent
let outsiderId: string

beforeAll(async () => {
  published = await seedEvent(db, { quantity: 10, status: 'published' })
  draft = await seedEvent(db, { quantity: 10, status: 'draft' })
  outsiderId = await createTestUser(db)

  // Non-zero on purpose. The column-grant test asserts the counter is unchanged
  // after a refused write, and it tries to write 0 — so seeding 0 would make
  // that assertion hold just as well if the write had succeeded.
  await db.from('ticket_types').update({ reserved_count: 3 }).eq('id', draft.ticketTypeId)
})

afterAll(async () => {
  await cleanupEvent(db, published)
  await cleanupEvent(db, draft)
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
})

describe('events', () => {
  it('lets anonymous visitors read published events', async () => {
    const { data, error } = await anonClient()
      .from('events')
      .select('id, title')
      .eq('id', published.eventId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('hides draft events from the public', async () => {
    const { data, error } = await anonClient()
      .from('events')
      .select('id')
      .eq('id', draft.eventId)

    // RLS filters rather than errors — the row simply is not there.
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('hides one host\'s draft from another host', async () => {
    const { data } = await userClient(published.hostProfileId)
      .from('events')
      .select('id')
      .eq('id', draft.eventId)

    expect(data).toHaveLength(0)
  })

  it('lets a host see their own draft', async () => {
    const { data } = await userClient(draft.hostProfileId)
      .from('events')
      .select('id')
      .eq('id', draft.eventId)

    expect(data).toHaveLength(1)
  })

  it('stops a signed-in user creating an event under a host they do not own', async () => {
    const { error } = await userClient(outsiderId)
      .from('events')
      .insert({
        host_id: published.hostId,
        slug: `hijack-${Date.now()}`,
        title: 'Not mine to publish',
        city: 'Indore',
        starts_at: new Date(Date.now() + 86_400_000).toISOString(),
      })

    expect(error).not.toBeNull()
  })

  it('stops a host editing another host\'s event', async () => {
    const { data } = await userClient(draft.hostProfileId)
      .from('events')
      .update({ title: 'Defaced' })
      .eq('id', published.eventId)
      .select()

    // The update matches no visible row, so nothing changes.
    expect(data ?? []).toHaveLength(0)

    const { data: after } = await db
      .from('events')
      .select('title')
      .eq('id', published.eventId)
      .single()
    expect(after!.title).toBe('Test Supper Club')
  })
})

describe('ticket_types columns', () => {
  it('lets a host reprice and resize their own ticket type', async () => {
    // The grant is narrow, not absent. If this breaks, the host edit form has
    // lost the ability to save seats and price at all.
    const { error } = await userClient(draft.hostProfileId)
      .from('ticket_types')
      .update({ price_paise: 60_000, quantity: 25 })
      .eq('id', draft.ticketTypeId)

    expect(error).toBeNull()

    await db
      .from('ticket_types')
      .update({ price_paise: 50_000, quantity: 10 })
      .eq('id', draft.ticketTypeId)
  })

  it('refuses to let a host write reserved_count on their own ticket type', async () => {
    // RLS filters rows, not columns. ticket_types_write_own says this row is
    // the host's to write, and on a table-level grant that included every
    // column — which is what 20260808000003 gave and 20260809000002 narrowed.
    //
    // Zeroing this counter is a self-service oversell: every seats-remaining
    // number is derived from it, and ticket_types_no_oversell compares it to
    // quantity, so the CHECK has nothing to say once the counter is a lie.
    const { error } = await userClient(draft.hostProfileId)
      .from('ticket_types')
      .update({ reserved_count: 0 })
      .eq('id', draft.ticketTypeId)

    expect(error?.code, 'a host must not be able to rewrite their own inventory').toBe('42501')

    const { data } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', draft.ticketTypeId)
      .single()
    expect(data!.reserved_count).toBe(3) // the value seeded below, untouched
  })
})

describe('hosts', () => {
  it('exposes the public host profile', async () => {
    const { data, error } = await anonClient()
      .from('hosts')
      .select('id, display_name, bio')
      .eq('id', published.hostId)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('does not expose payout details to anyone', async () => {
    // The column grant should make this a hard error, not a null value —
    // a host's bank reference must never be selectable over the public API.
    const { error } = await anonClient()
      .from('hosts')
      .select('id, upi_id, bank_account_ref')
      .eq('id', published.hostId)

    expect(error).not.toBeNull()
  })

  it('does not expose payout details to other signed-in users either', async () => {
    const { error } = await userClient(outsiderId)
      .from('hosts')
      .select('upi_id')
      .eq('id', published.hostId)

    expect(error).not.toBeNull()
  })
})

describe('bookings and tickets', () => {
  let bookingId: string

  beforeAll(async () => {
    const { data } = await db.rpc('reserve_tickets', {
      p_ticket_type_id: published.ticketTypeId,
      p_attendee_id: published.attendeeId,
      p_quantity: 1,
    })
    bookingId = data.id
    await db.rpc('confirm_booking', { p_booking_id: bookingId })
  })

  it('lets the attendee see their own booking', async () => {
    const { data } = await userClient(published.attendeeId)
      .from('bookings')
      .select('id, reference')
      .eq('id', bookingId)

    expect(data).toHaveLength(1)
  })

  it('hides a booking from an unrelated user', async () => {
    const { data } = await userClient(outsiderId)
      .from('bookings')
      .select('id')
      .eq('id', bookingId)

    expect(data).toHaveLength(0)
  })

  it('lets the host see bookings for their own event', async () => {
    const { data } = await userClient(published.hostProfileId)
      .from('bookings')
      .select('id')
      .eq('id', bookingId)

    expect(data).toHaveLength(1)
  })

  it('hides those bookings from a different host', async () => {
    const { data } = await userClient(draft.hostProfileId)
      .from('bookings')
      .select('id')
      .eq('id', bookingId)

    expect(data).toHaveLength(0)
  })

  it('refuses direct booking inserts, so inventory cannot be bypassed', async () => {
    const { error } = await userClient(published.attendeeId)
      .from('bookings')
      .insert({
        event_id: published.eventId,
        ticket_type_id: published.ticketTypeId,
        attendee_id: published.attendeeId,
        quantity: 1,
        status: 'confirmed',
        reference: 'FREEBIE1',
        subtotal_paise: 0,
        total_paise: 0,
      })

    expect(error).not.toBeNull()
  })

  it('refuses to let an attendee mark their own ticket as checked in', async () => {
    const { data: tickets } = await db
      .from('tickets')
      .select('id')
      .eq('booking_id', bookingId)

    const { data } = await userClient(published.attendeeId)
      .from('tickets')
      .update({ checked_in_at: new Date().toISOString() })
      .eq('id', tickets![0].id)
      .select()

    expect(data ?? []).toHaveLength(0)

    const { data: after } = await db
      .from('tickets')
      .select('checked_in_at')
      .eq('id', tickets![0].id)
      .single()
    expect(after!.checked_in_at).toBeNull()
  })
})

describe('server-only tables', () => {
  it.each(['fee_rules', 'message_log', 'provider_webhook_events'])(
    'keeps %s invisible to clients',
    async (table) => {
      const anon = await anonClient().from(table).select('*')
      expect(anon.data ?? []).toHaveLength(0)

      const signedIn = await userClient(outsiderId).from(table).select('*')
      expect(signedIn.data ?? []).toHaveLength(0)
    },
  )
})

describe('privileged functions', () => {
  it.each([
    ['reserve_tickets', { p_ticket_type_id: null, p_attendee_id: null, p_quantity: 1 }],
    ['confirm_booking', { p_booking_id: null }],
    ['cancel_booking', { p_booking_id: null }],
    ['approve_booking', { p_booking_id: null }],
    ['release_expired_holds', {}],
  ])('refuses %s over the public API', async (fn, args) => {
    // These mutate inventory and money. They must be unreachable via PostgREST
    // even for a signed-in user — only the service role may call them.
    const { error } = await userClient(published.attendeeId).rpc(fn, args)
    expect(error, `${fn} should not be callable by authenticated users`).not.toBeNull()
  })

  // The transactional event writers take the opposite posture: SECURITY INVOKER,
  // granted to `authenticated` on purpose, because a host is entitled to the
  // write and RLS still narrows it. What must not survive is anon reaching them.
  // EXECUTE on a new function is granted to PUBLIC by default, so that grant is
  // revoked in 20260809000001_event_write_transactions.sql — and this is what
  // says so out loud, rather than leaving it to a one-off manual check.
  //
  // Every argument has to be supplied: PostgREST resolves the overload by
  // argument name, and a short list would be refused as an unknown function
  // before the privilege was ever consulted, which would pass for the wrong
  // reason.
  const eventWriteArgs = {
    p_title: 'Anon Should Not Get This Far',
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
    p_quantity: 5,
  }

  it.each([
    ['create_event_with_ticket_type', () => ({ p_host_id: null, p_slug: 'anon-probe', ...eventWriteArgs })],
    ['update_event_with_ticket_type', () => ({ p_event_id: published.eventId, ...eventWriteArgs })],
  ])('refuses %s to anonymous visitors', async (fn, args) => {
    const { error } = await anonClient().rpc(fn, args())

    // Pinned on the message, not just the SQLSTATE: 42501 is also what an RLS
    // refusal returns, so the code alone would still pass if EXECUTE had been
    // left on and the row policy were the only thing doing the work.
    expect(error?.message, `${fn} should be unreachable by anon`).toBe(
      `permission denied for function ${fn}`,
    )
  })
})

describe('platform admins', () => {
  let adminProfileId: string
  let otherHost: SeededEvent

  beforeAll(async () => {
    adminProfileId = await seedPlatformAdmin(db)
    otherHost = await seedEvent(db, { quantity: 5, status: 'published' })
    await db.from('payouts').insert({
      host_id: otherHost.hostId,
      event_id: otherHost.eventId,
      gross_paise: 50_000,
      commission_paise: 0,
      net_paise: 50_000,
    })
  })

  afterAll(async () => {
    await cleanupEvent(db, otherHost)
    await db.auth.admin.deleteUser(adminProfileId).catch(() => {})
  })

  it('hides platform_admins from a signed-in non-admin', async () => {
    // The same posture as fee_rules and provider_webhook_events: RLS on, no
    // policy, no grant. Knowing WHO can settle is itself worth withholding.
    const { data, error } = await userClient(outsiderId).from('platform_admins').select('profile_id')
    expect(data ?? []).toHaveLength(0)
    if (error) expect(error.code).toBeTruthy()
  })

  it('hides platform_admins from an admin too — nothing grants it', async () => {
    const { data } = await userClient(adminProfileId).from('platform_admins').select('profile_id')
    expect(data ?? []).toHaveLength(0)
  })

  it('does not let one host read another host\'s payouts', async () => {
    const { data } = await userClient(published.hostProfileId)
      .from('payouts')
      .select('id')
      .eq('event_id', otherHost.eventId)
    expect(data ?? []).toHaveLength(0)
  })

  it('lets a platform admin read payouts across hosts', async () => {
    const { data, error } = await userClient(adminProfileId)
      .from('payouts')
      .select('id, net_paise')
      .eq('event_id', otherHost.eventId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].net_paise).toBe(50_000)
  })

  it('lets a platform admin read an event they do not host', async () => {
    // draft, so events_select_published cannot be what allows it.
    const { data, error } = await userClient(adminProfileId)
      .from('events')
      .select('id')
      .eq('id', draft.eventId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('does not let a non-admin read a draft event they do not host', async () => {
    const { data } = await userClient(outsiderId).from('events').select('id').eq('id', draft.eventId)
    expect(data ?? []).toHaveLength(0)
  })

  it('still withholds host payout secrets from an admin on the ordinary client', async () => {
    // The column grant, not a policy, is what hides upi_id — and no policy can
    // widen a grant. This is precisely why admin_host_payout_target exists.
    const { error } = await userClient(adminProfileId).from('hosts').select('upi_id')
    expect(error).not.toBeNull()
  })
})
