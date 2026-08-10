import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedEvent,
  userClient,
  type SeededEvent,
} from '@/tests/helpers/db'

const db = adminClient()
let paid: SeededEvent
// The EH033 test's second attendee. Deleted after cleanupEvent has removed the
// bookings that reference it — attendee_id is ON DELETE RESTRICT.
let buyer: string | undefined

beforeAll(async () => {
  paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
})
afterAll(async () => {
  await cleanupEvent(db, paid)
  if (buyer) await db.auth.admin.deleteUser(buyer).catch(() => {})
})

describe('begin_paid_booking', () => {
  it('holds seats without confirming', async () => {
    const { data, error } = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Asha  ',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'awaiting_payment',
      quantity: 2,
      subtotal_paise: 100_000,
      total_paise: 100_000,
      payment_mode: 'online',
      attendee_name: 'Asha',
    })
    expect(data!.hold_expires_at).toBeTruthy()
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', data!.id)
    expect(count).toBe(0)
    // release the hold so later tests see clean inventory
    await db.rpc('cancel_booking', { p_booking_id: data!.id, p_reason: 'test cleanup' })
  })

  it('refuses a free ticket type with EH030', async () => {
    const free = await seedEvent(db, { quantity: 5, pricePaise: 0, status: 'published' })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: free.ticketTypeId,
        p_attendee_id: free.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('EH030')
    } finally {
      await cleanupEvent(db, free)
    }
  })

  it('refuses an approval-gated event with EH031', async () => {
    const gated = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'published', requiresApproval: true })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: gated.ticketTypeId,
        p_attendee_id: gated.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('EH031')
    } finally {
      await cleanupEvent(db, gated)
    }
  })

  it('refuses a started event with EH032', async () => {
    const past = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'published' })
    try {
      await db.from('events').update({ starts_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', past.eventId)
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: past.ticketTypeId,
        p_attendee_id: past.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('EH032')
    } finally {
      await cleanupEvent(db, past)
    }
  })

  it('refuses a second active booking with EH033', async () => {
    buyer = await createTestUser(db)
    const first = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: buyer,
      p_quantity: 1,
      p_attendee_name: 'Ravi',
    })
    expect(first.error).toBeNull()
    const again = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: buyer,
      p_quantity: 1,
      p_attendee_name: 'Ravi',
    })
    expect(again.error?.code).toBe('EH033')
    await db.rpc('cancel_booking', { p_booking_id: first.data!.id, p_reason: 'test cleanup' })
  })

  it('refuses a draft event through reserve_tickets (23514)', async () => {
    const draft = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'draft' })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: draft.ticketTypeId,
        p_attendee_id: draft.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('23514')
      expect(error?.message).toMatch(/not open for booking/)
    } finally {
      await cleanupEvent(db, draft)
    }
  })

  it('refuses a quantity above max_per_order through reserve_tickets', async () => {
    const capped = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published', maxPerOrder: 4 })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: capped.ticketTypeId,
        p_attendee_id: capped.attendeeId,
        p_quantity: 5,
        p_attendee_name: 'Asha',
      })
      expect(error).not.toBeNull()
      const { count } = await db.from('bookings').select('*', { count: 'exact', head: true }).eq('event_id', capped.eventId)
      expect(count).toBe(0)
    } finally {
      await cleanupEvent(db, capped)
    }
  })

  it('books online even when the event allows cash', async () => {
    const cashy = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'published', allowsCash: true })
    try {
      const { data, error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: cashy.ticketTypeId,
        p_attendee_id: cashy.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error).toBeNull()
      expect(data!.payment_mode).toBe('online')
    } finally {
      await cleanupEvent(db, cashy)
    }
  })

  it('stays unreachable over PostgREST for authenticated users', async () => {
    const asUser = userClient(paid.attendeeId)
    const { error } = await asUser.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.message).toMatch(/permission denied/)
  })
})

describe('refund_cutoff_hours on the event writers', () => {
  it('creates with an explicit cutoff and defaults to 24 without one', async () => {
    const seed = await seedEvent(db, { quantity: 5, pricePaise: 0, status: 'published' })
    try {
      const { data: withCutoff, error } = await db.rpc('create_event_with_ticket_type', {
        p_host_id: seed.hostId,
        p_slug: `plan-test-cutoff-${Date.now()}`,
        p_title: 'Cutoff test event',
        p_description: null,
        p_city: 'Bengaluru',
        p_venue_name: null,
        p_venue_address: null,
        p_cover_image_url: null,
        p_starts_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
        p_ends_at: null,
        p_requires_approval: false,
        p_allows_cash: false,
        p_hide_venue_until_approved: false,
        p_price_paise: 50_000,
        p_quantity: 5,
        p_refund_cutoff_hours: 48,
      })
      expect(error).toBeNull()
      expect(withCutoff!.refund_cutoff_hours).toBe(48)

      // update_event_with_ticket_type is SECURITY INVOKER and scopes on
      // current_host_id(), which is null for a service-role caller — so the
      // update runs as the event's host, not as the admin client.
      const { data: updated } = await userClient(seed.hostProfileId).rpc('update_event_with_ticket_type', {
        p_event_id: withCutoff!.id,
        p_title: 'Cutoff test event',
        p_description: null,
        p_city: 'Bengaluru',
        p_venue_name: null,
        p_venue_address: null,
        p_cover_image_url: null,
        p_starts_at: withCutoff!.starts_at,
        p_ends_at: null,
        p_requires_approval: false,
        p_allows_cash: false,
        p_hide_venue_until_approved: false,
        p_price_paise: 50_000,
        p_quantity: 5,
        p_refund_cutoff_hours: 0,
      })
      expect(updated!.refund_cutoff_hours).toBe(0)
      await expect(seedEventRowCutoff(seed)).resolves.toBe(24) // helper below
      await db.from('events').delete().eq('id', withCutoff!.id)
    } finally {
      await cleanupEvent(db, seed)
    }
  })
})

// Every pre-existing row (and every row seeded without the arg) carries the default.
async function seedEventRowCutoff(seed: SeededEvent): Promise<number> {
  const { data } = await db.from('events').select('refund_cutoff_hours').eq('id', seed.eventId).single()
  return data!.refund_cutoff_hours
}
