import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

/**
 * Fills the room so the event is genuinely sold out — the state a waitlist is for.
 *
 * The ordinary online sale rather than book_cash_tickets, because half the
 * events below are seeded with allows_cash false on purpose — EH062 needs one —
 * and the cash path rightly refuses those. begin_paid_booking only holds, so
 * confirm_booking follows: a hold that lapses mid-suite would hand the seat to
 * the very line under test.
 */
async function sellOut(seed: SeededEvent, seats: number): Promise<string> {
  const buyer = await createTestUser(db)
  const { data, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: buyer,
    p_quantity: seats,
    p_attendee_name: 'Filler',
  })
  if (error) throw new Error(`sellOut failed: ${error.message}`)
  const { error: confirmError } = await db.rpc('confirm_booking', { p_booking_id: data!.id })
  if (confirmError) throw new Error(`sellOut confirm failed: ${confirmError.message}`)
  return buyer
}

async function reservedCount(ticketTypeId: string): Promise<number> {
  const { data } = await db.from('ticket_types').select('reserved_count').eq('id', ticketTypeId).single()
  return data!.reserved_count
}

describe('join_waitlist', () => {
  let seed: SeededEvent
  let filler = ''

  beforeAll(async () => {
    // maxPerOrder 3 so EH063 has something to refuse; allowsCash so the mode
    // choice is exercisable on the same event.
    seed = await seedEvent(db, {
      quantity: 2,
      pricePaise: 50_000,
      allowsCash: true,
      hasWaitlist: true,
      maxPerOrder: 3,
    })
    filler = await sellOut(seed, 2)
  })

  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('stores the entry without touching inventory and prices nothing', async () => {
    const before = await reservedCount(seed.ticketTypeId)
    const { data, error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Asha  ',
      p_payment_mode: 'online',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'waitlisted',
      quantity: 2,
      subtotal_paise: 0,
      total_paise: 0,
      commission_paise: 0,
      payment_mode: 'online',
      attendee_name: 'Asha',
    })
    expect(data!.hold_expires_at).toBeNull()
    expect(data!.approved_at).toBeNull()
    expect(await reservedCount(seed.ticketTypeId)).toBe(before)

    // Position is 1: they are the whole line.
    const { data: position } = await db.rpc('waitlist_position', { p_booking_id: data!.id })
    expect(position).toBe(1)
    const { data: length } = await db.rpc('waitlist_length', { p_ticket_type_id: seed.ticketTypeId })
    expect(length).toBe(1)
  })

  it('refuses a second entry from the same attendee with EH065', async () => {
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH065')
  })

  it('refuses more seats than max_per_order with EH063', async () => {
    const other = await createTestUser(db)
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: other,
      p_quantity: 4,
      p_attendee_name: 'Bala',
    })
    expect(error?.code).toBe('EH063')
    await db.auth.admin.deleteUser(other).catch(() => {})
  })

  it('takes a cash entry where the event allows it', async () => {
    const other = await createTestUser(db)
    const { data, error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: other,
      p_quantity: 1,
      p_attendee_name: 'Bala',
      p_payment_mode: 'cash',
    })
    expect(error).toBeNull()
    expect(data!.payment_mode).toBe('cash')
    // Second in line, behind Asha — the ordering the engine promotes by.
    const { data: position } = await db.rpc('waitlist_position', { p_booking_id: data!.id })
    expect(position).toBe(2)
    await db.from('bookings').delete().eq('id', data!.id)
    await db.auth.admin.deleteUser(other).catch(() => {})
  })
})

describe('join_waitlist refusals that need their own event', () => {
  it('refuses an event with no waitlist, and an approval event, with EH060', async () => {
    const plain = await seedEvent(db, { quantity: 1, pricePaise: 50_000 })
    const plainFiller = await sellOut(plain, 1)
    expect(
      (await db.rpc('join_waitlist', {
        p_ticket_type_id: plain.ticketTypeId,
        p_attendee_id: plain.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })).error?.code,
    ).toBe('EH060')
    await db.from('bookings').delete().eq('event_id', plain.eventId)
    await cleanupEvent(db, plain)
    await db.auth.admin.deleteUser(plainFiller).catch(() => {})

    // An approval event cannot even be seeded with a waitlist: events_one_queue
    // refuses the row. So the toggle is off, and the code is the same one.
    const approval = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    expect(
      (await db.rpc('join_waitlist', {
        p_ticket_type_id: approval.ticketTypeId,
        p_attendee_id: approval.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })).error?.code,
    ).toBe('EH060')
    await cleanupEvent(db, approval)
  })

  it('refuses a started event with EH061', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    const filler = await sellOut(seed, 1)
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', seed.eventId)
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH061')
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('refuses cash where the event does not allow it with EH062', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true, allowsCash: false })
    const filler = await sellOut(seed, 1)
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
      p_payment_mode: 'cash',
    })
    expect(error?.code).toBe('EH062')
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('refuses with EH064 while seats are open and nobody is waiting', async () => {
    const seed = await seedEvent(db, { quantity: 5, pricePaise: 50_000, hasWaitlist: true })
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH064')
    await cleanupEvent(db, seed)
  })

  it('accepts an entry too big for the open seats even with an empty line', async () => {
    // One seat free, three wanted: "book instead" is not advice they could
    // follow, so the line is the right answer and EH064 must not fire.
    const seed = await seedEvent(db, { quantity: 3, pricePaise: 50_000, hasWaitlist: true, maxPerOrder: 3 })
    const filler = await sellOut(seed, 2)
    const { data, error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 3,
      p_attendee_name: 'Asha',
    })
    expect(error).toBeNull()
    expect(data!.status).toBe('waitlisted')
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('refuses an unpublished event with the existing sentence, not a code', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true, status: 'draft' })
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.message).toContain('not open for booking')
    await cleanupEvent(db, seed)
  })

  it('does not offer seats on an event the host has unpublished', async () => {
    // Promotion is automatic -- a cancel, or the argument-less reconciliation
    // sweep nobody tapped -- so an unpublished event with a line would otherwise
    // mint payable 24-hour offers on an event that has been taken down.
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    const filler = await sellOut(seed, 1)
    const { data: entry } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })

    await db.from('events').update({ status: 'draft' }).eq('id', seed.eventId)

    // Free the seat the ordinary way. cancel_booking ends by calling the engine.
    const { data: sold } = await db
      .from('bookings')
      .select('id')
      .eq('event_id', seed.eventId)
      .eq('attendee_id', filler)
      .single()
    const { error } = await db.rpc('cancel_booking', { p_booking_id: sold!.id })
    expect(error).toBeNull()

    const { data: after } = await db.from('bookings').select('status, approved_at, hold_expires_at').eq('id', entry!.id).single()
    expect(after!.status).toBe('waitlisted')
    expect(after!.approved_at).toBeNull()
    expect(after!.hold_expires_at).toBeNull()
    expect(await reservedCount(seed.ticketTypeId)).toBe(0)

    // The control, without which this test would pass on an engine that never
    // promotes anything: publish again and the same seat is offered at once.
    await db.from('events').update({ status: 'published' }).eq('id', seed.eventId)
    const { data: promoted } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })
    expect(promoted).toBe(1)
    const { data: offered } = await db.from('bookings').select('status').eq('id', entry!.id).single()
    expect(offered!.status).toBe('awaiting_payment')

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('refuses to sit a waitlist beside an approval queue', async () => {
    // events_one_queue, met head-on: the constraint is what lets every copy
    // branch trust "approved_at on a waitlist event means an offer".
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    const { error } = await db.from('events').update({ has_waitlist: true }).eq('id', seed.eventId)
    expect(error?.message).toContain('events_one_queue')
    await cleanupEvent(db, seed)
  })
})
