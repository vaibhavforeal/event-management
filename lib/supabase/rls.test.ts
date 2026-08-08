import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  anonClient,
  cleanupEvent,
  createTestUser,
  seedEvent,
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
})
