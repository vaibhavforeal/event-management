import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import { joinWaitlist, promoteAfterCapacityChange } from '@/lib/bookings/service'

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

describe('promoteAfterCapacityChange', () => {
  let seed: SeededEvent
  let filler = ''
  let stranger = ''

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    // Sell the only seat, so the room is genuinely full and Asha may join.
    filler = await createTestUser(db)
    const booked = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: filler,
      p_quantity: 1,
      p_attendee_name: 'Filler',
    })
    if (booked.error) throw new Error(`setup fill failed: ${booked.error.message}`)
    await db.rpc('confirm_booking', { p_booking_id: booked.data!.id })
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    stranger = await createTestUser(db)
  })

  afterAll(async () => {
    // Teardown lives here rather than at the end of each test on purpose: a
    // failing assertion must not be able to leak a seed into a shared dev
    // database. The guard is for a beforeAll that threw part-way, which would
    // otherwise turn teardown itself into a TypeError.
    if (!seed) return
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
  })

  async function statusOfAsha(): Promise<string> {
    const { data } = await db.from('bookings').select('status').eq('attendee_id', seed.attendeeId).single()
    return data!.status
  }

  it('does nothing for anyone but the host', async () => {
    // The seats exist by now only if this refuses — so raise capacity first
    // and prove a stranger's call leaves the line where it is.
    await db.from('ticket_types').update({ quantity: 2 }).eq('id', seed.ticketTypeId)
    await promoteAfterCapacityChange(asCaller(stranger), seed.eventId)
    expect(await statusOfAsha()).toBe('waitlisted')
    await promoteAfterCapacityChange(asCaller(seed.attendeeId), seed.eventId)
    expect(await statusOfAsha()).toBe('waitlisted')
  })

  it('serves the line when the host adds a seat', async () => {
    await promoteAfterCapacityChange(asCaller(seed.hostProfileId), seed.eventId)
    expect(await statusOfAsha()).toBe('awaiting_payment')
    const { data } = await db.from('ticket_types').select('reserved_count').eq('id', seed.ticketTypeId).single()
    expect(data!.reserved_count).toBe(2)
  })

  it('never throws on an event that cannot be found', async () => {
    // A save must not fail because the promote did. Same reasoning as
    // refundIfOwed: the seat is the important part, and the sweep catches up.
    await expect(
      promoteAfterCapacityChange(asCaller(seed.hostProfileId), '00000000-0000-4000-8000-00000000dead'),
    ).resolves.toBeUndefined()
  })
})
