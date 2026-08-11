import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

async function reservedCount(ticketTypeId: string): Promise<number> {
  const { data } = await db.from('ticket_types').select('reserved_count').eq('id', ticketTypeId).single()
  return data!.reserved_count
}

describe('request_booking', () => {
  let paid: SeededEvent
  beforeAll(async () => {
    paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true, maxPerOrder: 3 })
  })
  afterAll(async () => {
    await cleanupEvent(db, paid)
  })

  it('stores the request without touching inventory', async () => {
    const before = await reservedCount(paid.ticketTypeId)
    const { data, error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Asha  ',
      p_attendee_note: 'first-timer, friend of Ravi',
      p_payment_mode: 'online',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'pending_approval',
      quantity: 2,
      subtotal_paise: 0,
      total_paise: 0,
      payment_mode: 'online',
      attendee_name: 'Asha',
      attendee_note: 'first-timer, friend of Ravi',
    })
    expect(data!.hold_expires_at).toBeNull()
    expect(await reservedCount(paid.ticketTypeId)).toBe(before)
    // a second request from the same attendee refuses
    const dup = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(dup.error?.code).toBe('EH054')
    await db.rpc('cancel_booking', { p_booking_id: data!.id, p_reason: 'test cleanup' })
  })

  it('refuses more seats than max_per_order with EH053', async () => {
    const { error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 4,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH053')
  })

  it('refuses cash where the event does not allow it with EH052', async () => {
    const { error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
      p_payment_mode: 'cash',
    })
    expect(error?.code).toBe('EH052')
  })

  it('refuses a non-approval event with EH050 and a started one with EH051', async () => {
    const direct = await seedEvent(db, { pricePaise: 50_000 })
    const { error: eh050 } = await db.rpc('request_booking', {
      p_ticket_type_id: direct.ticketTypeId,
      p_attendee_id: direct.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(eh050?.code).toBe('EH050')
    await cleanupEvent(db, direct)

    const started = await seedEvent(db, { pricePaise: 50_000, requiresApproval: true })
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', started.eventId)
    const { error: eh051 } = await db.rpc('request_booking', {
      p_ticket_type_id: started.ticketTypeId,
      p_attendee_id: started.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(eh051?.code).toBe('EH051')
    await cleanupEvent(db, started)
  })

  it('allows a fresh request after a decline', async () => {
    const { data: first } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    await db.rpc('cancel_booking', { p_booking_id: first!.id, p_reason: 'declined by host' })
    const { data: second, error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error).toBeNull()
    expect(second!.status).toBe('pending_approval')
    await db.rpc('cancel_booking', { p_booking_id: second!.id, p_reason: 'test cleanup' })
  })
})

describe('approve_booking', () => {
  it('online paid: reprices, takes inventory, sets the 24h hold', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 2,
      p_attendee_name: 'Asha',
    })
    const { data, error } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'awaiting_payment',
      subtotal_paise: 100_000,
      total_paise: 100_000,
      convenience_fee_paise: 0,
      commission_paise: 0,
    })
    expect(data!.approved_at).toBeTruthy()
    const holdMs = new Date(data!.hold_expires_at!).getTime() - Date.now()
    expect(holdMs).toBeGreaterThan(23 * 3600_000)
    expect(holdMs).toBeLessThan(25 * 3600_000)
    expect(await reservedCount(seed.ticketTypeId)).toBe(2)
    // approving again is EH056, not a double-take of inventory
    const again = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(again.error?.code).toBe('EH056')
    await cleanupEvent(db, seed)
  })

  it('free: confirms straight from pending_approval and issues tickets', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 0, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 2,
      p_attendee_name: 'Asha',
    })
    const { data, error } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'confirmed', total_paise: 0 })
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', data!.id)
    expect(count).toBe(2)
    await cleanupEvent(db, seed)
  })

  it('cash: confirms directly with fee and commission zeroed', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true, allowsCash: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
      p_payment_mode: 'cash',
    })
    // fee args passed on purpose: cash must zero them even when offered
    const { data, error } = await db.rpc('approve_booking', {
      p_booking_id: request!.id,
      p_convenience_fee_paise: 5_000,
      p_commission_paise: 5_000,
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'confirmed',
      payment_mode: 'cash',
      subtotal_paise: 50_000,
      total_paise: 50_000,
      convenience_fee_paise: 0,
      commission_paise: 0,
    })
    expect(data!.hold_expires_at).toBeNull()
    await cleanupEvent(db, seed)
  })

  it('refuses once the event has started with EH055', async () => {
    const seed = await seedEvent(db, { pricePaise: 50_000, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', seed.eventId)
    const { error } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(error?.code).toBe('EH055')
    await cleanupEvent(db, seed)
  })

  it('over-approval refuses with the seats-remaining sentence', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    const second = await createTestUser(db)
    const { data: a } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: seed.attendeeId,
      p_quantity: 1, p_attendee_name: 'Asha',
    })
    const { data: b } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: second,
      p_quantity: 1, p_attendee_name: 'Bala',
    })
    const first = await db.rpc('approve_booking', { p_booking_id: a!.id })
    expect(first.error).toBeNull()
    const overflow = await db.rpc('approve_booking', { p_booking_id: b!.id })
    expect(overflow.error?.message).toContain('seats remain')
    await db.from('bookings').delete().eq('id', b!.id)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(second).catch(() => {})
  })

  it('two concurrent approvals of the last seat: exactly one wins', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    const second = await createTestUser(db)
    const { data: a } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: seed.attendeeId,
      p_quantity: 1, p_attendee_name: 'Asha',
    })
    const { data: b } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: second,
      p_quantity: 1, p_attendee_name: 'Bala',
    })
    const [ra, rb] = await Promise.all([
      db.rpc('approve_booking', { p_booking_id: a!.id }),
      db.rpc('approve_booking', { p_booking_id: b!.id }),
    ])
    const wins = [ra, rb].filter((r) => r.error === null)
    expect(wins).toHaveLength(1)
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(second).catch(() => {})
  })

  it('a lapsed 24h hold flows through release_expired_holds and frees the seat', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: seed.attendeeId,
      p_quantity: 2, p_attendee_name: 'Asha',
    })
    const { data: approved } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', approved!.id)
    await db.rpc('release_expired_holds')
    const { data: after } = await db.from('bookings').select('status').eq('id', approved!.id).single()
    expect(after!.status).toBe('expired')
    expect(await reservedCount(seed.ticketTypeId)).toBe(0)
    await cleanupEvent(db, seed)
  })
})
