import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

describe('book_cash_tickets', () => {
  let cash: SeededEvent
  beforeAll(async () => {
    cash = await seedEvent(db, { quantity: 10, pricePaise: 50_000, allowsCash: true })
  })
  afterAll(async () => {
    await cleanupEvent(db, cash)
  })

  it('confirms in one transaction with commission zeroed and tickets issued', async () => {
    const { data, error } = await db.rpc('book_cash_tickets', {
      p_ticket_type_id: cash.ticketTypeId,
      p_attendee_id: cash.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Chitra  ',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'confirmed',
      payment_mode: 'cash',
      subtotal_paise: 100_000,
      total_paise: 100_000,
      convenience_fee_paise: 0,
      commission_paise: 0,
      attendee_name: 'Chitra',
    })
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', data!.id)
    expect(count).toBe(2)
    const { data: tt } = await db.from('ticket_types').select('reserved_count').eq('id', cash.ticketTypeId).single()
    expect(tt!.reserved_count).toBe(2)
    // cancelling returns the seats and creates no refunds row (no payment exists)
    await db.rpc('cancel_booking', { p_booking_id: data!.id, p_reason: 'test cleanup' })
    const { data: freed } = await db.from('ticket_types').select('reserved_count').eq('id', cash.ticketTypeId).single()
    expect(freed!.reserved_count).toBe(0)
  })

  it('refuses a free ticket with EH057, approval events with EH058, started with EH059', async () => {
    const free = await seedEvent(db, { pricePaise: 0, allowsCash: true })
    expect(
      (await db.rpc('book_cash_tickets', {
        p_ticket_type_id: free.ticketTypeId, p_attendee_id: free.attendeeId,
        p_quantity: 1, p_attendee_name: 'C',
      })).error?.code,
    ).toBe('EH057')
    await cleanupEvent(db, free)

    const approval = await seedEvent(db, { pricePaise: 50_000, allowsCash: true, requiresApproval: true })
    expect(
      (await db.rpc('book_cash_tickets', {
        p_ticket_type_id: approval.ticketTypeId, p_attendee_id: approval.attendeeId,
        p_quantity: 1, p_attendee_name: 'C',
      })).error?.code,
    ).toBe('EH058')
    await cleanupEvent(db, approval)

    const started = await seedEvent(db, { pricePaise: 50_000, allowsCash: true })
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', started.eventId)
    expect(
      (await db.rpc('book_cash_tickets', {
        p_ticket_type_id: started.ticketTypeId, p_attendee_id: started.attendeeId,
        p_quantity: 1, p_attendee_name: 'C',
      })).error?.code,
    ).toBe('EH059')
    await cleanupEvent(db, started)
  })

  it("passes reserve_tickets' cash refusal through where allows_cash is false", async () => {
    const noCash = await seedEvent(db, { pricePaise: 50_000, allowsCash: false })
    const { error } = await db.rpc('book_cash_tickets', {
      p_ticket_type_id: noCash.ticketTypeId, p_attendee_id: noCash.attendeeId,
      p_quantity: 1, p_attendee_name: 'C',
    })
    expect(error?.message).toContain('cash')
    await cleanupEvent(db, noCash)
  })
})
