import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()
let free: SeededEvent

beforeAll(async () => {
  free = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
})

afterAll(async () => {
  await cleanupEvent(db, free)
})

describe('book_free_tickets', () => {
  it('confirms the booking, records the name and issues one ticket per seat', async () => {
    const { data, error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: free.attendeeId,
      p_quantity: 3,
      p_attendee_name: '  Priya  ',
      p_attendee_note: null,
    })

    expect(error).toBeNull()
    // Trimmed on the way in: the host reads this at a door.
    expect(data).toMatchObject({ status: 'confirmed', quantity: 3, total_paise: 0, attendee_name: 'Priya' })
    expect((data as { hold_expires_at: string | null }).hold_expires_at).toBeNull()

    const bookingId = (data as { id: string }).id
    const { data: tickets } = await db.from('tickets').select('code').eq('booking_id', bookingId)
    expect(tickets).toHaveLength(3)
    // 16 random bytes as hex.
    expect(tickets![0].code).toMatch(/^[0-9a-f]{32}$/)

    const { data: tt } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', free.ticketTypeId)
      .single()
    expect(tt!.reserved_count).toBe(3)
  })

  it('refuses a paid event as EH010, taking no inventory', async () => {
    const paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.code).toBe('EH010')

    const { data: tt } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', paid.ticketTypeId)
      .single()
    expect(tt!.reserved_count).toBe(0)

    const { data: bookings } = await db.from('bookings').select('id').eq('event_id', paid.eventId)
    expect(bookings ?? []).toHaveLength(0)

    await cleanupEvent(db, paid)
  })

  it('refuses an approval-gated event as EH011', async () => {
    const gated = await seedEvent(db, {
      quantity: 10,
      pricePaise: 0,
      status: 'published',
      requiresApproval: true,
    })

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: gated.ticketTypeId,
      p_attendee_id: gated.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.code).toBe('EH011')

    await cleanupEvent(db, gated)
  })

  it('refuses a second active booking by the same attendee as EH012', async () => {
    // max_per_order bounds one order, not one person. Without this rule, ten
    // single-seat bookings take a ten-seat room.
    const solo = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })

    const first = await db.rpc('book_free_tickets', {
      p_ticket_type_id: solo.ticketTypeId,
      p_attendee_id: solo.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    expect(first.error).toBeNull()

    const second = await db.rpc('book_free_tickets', {
      p_ticket_type_id: solo.ticketTypeId,
      p_attendee_id: solo.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    expect(second.error?.code).toBe('EH012')

    // Exactly one seat moved, so the refusal rolled its reservation back.
    const { data: tt } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', solo.ticketTypeId)
      .single()
    expect(tt!.reserved_count).toBe(1)

    await cleanupEvent(db, solo)
  })

  it('lets an attendee rebook after cancelling', async () => {
    // The index predicate covers only active statuses, so cancelling frees the
    // slot. Without this the rule would be "one booking ever", which is not it.
    const again = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })

    const first = await db.rpc('book_free_tickets', {
      p_ticket_type_id: again.ticketTypeId,
      p_attendee_id: again.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    await db.rpc('cancel_booking', {
      p_booking_id: (first.data as { id: string }).id,
      p_reason: 'changed my mind',
    })

    const second = await db.rpc('book_free_tickets', {
      p_ticket_type_id: again.ticketTypeId,
      p_attendee_id: again.attendeeId,
      p_quantity: 4,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    expect(second.error).toBeNull()

    await cleanupEvent(db, again)
  })

  it('refuses an event that has already started as EH013', async () => {
    // reserve_tickets checks published status and the sales window; a finished
    // event passes both. Anyone scrolling back through WhatsApp could book it.
    const past = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    await db
      .from('events')
      .update({ starts_at: new Date(Date.now() - 3600_000).toISOString() })
      .eq('id', past.eventId)

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: past.ticketTypeId,
      p_attendee_id: past.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.code).toBe('EH013')

    await cleanupEvent(db, past)
  })

  it('passes through reserve_tickets\' own refusals', async () => {
    // Not remapped: "only N seats remain" is already a sentence for a human.
    // A fresh attendee, because `free.attendeeId` already booked above and
    // would now be refused by EH012 before availability was ever consulted.
    const { createTestUser } = await import('@/tests/helpers/db')
    const hopeful = await createTestUser(db)

    // 9, not 99: reserve_tickets checks max_per_order (10 by default in
    // seedEvent) *before* availability, so a huge number is refused as "cannot
    // book more than 10 per order" and never reaches the branch under test.
    // Three seats went in the first test, so 9 > the 7 that remain.
    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: hopeful,
      p_quantity: 9,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.message).toContain('seats remain')
    await db.auth.admin.deleteUser(hopeful).catch(() => {})
  })

  it('is unreachable by a signed-in user over the public API', async () => {
    // Inventory functions are service-role only. This one joins them.
    const { userClient } = await import('@/tests/helpers/db')
    const { error } = await userClient(free.attendeeId).rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: free.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.message).toBe('permission denied for function book_free_tickets')
  })
})

describe('profiles_select_for_host', () => {
  // The policy added in Step 3b. `free.attendeeId` booked in the first test of
  // this file, so the host relationship exists by the time these run.
  it('lets the host read the phone number of someone booked on their event', async () => {
    const { userClient } = await import('@/tests/helpers/db')

    const { data } = await userClient(free.hostProfileId)
      .from('profiles')
      .select('id, phone')
      .eq('id', free.attendeeId)
      .maybeSingle()

    // Not `not.toBeNull()`: RLS filters rather than errors, so a policy that
    // did nothing would also return no row and a laxer assertion would pass
    // for the wrong reason.
    expect(data?.id).toBe(free.attendeeId)
    // Digits, no leading `+`: GoTrue strips it before handle_new_user() copies
    // auth.users.phone into profiles.phone. lib/auth/phone-otp.test.ts asserts
    // the same normalisation against a real OTP login.
    expect(data?.phone).toMatch(/^\d+$/)
  })

  it('shows a host nothing about someone who booked a different host\'s event', async () => {
    const { userClient, createTestUser } = await import('@/tests/helpers/db')
    const otherHost = await seedEvent(db, { quantity: 5, pricePaise: 0, status: 'published' })
    const outsider = await createTestUser(db)

    const { data } = await userClient(otherHost.hostProfileId)
      .from('profiles')
      .select('id')
      .eq('id', outsider)

    expect(data ?? []).toHaveLength(0)

    await db.auth.admin.deleteUser(outsider).catch(() => {})
    await cleanupEvent(db, otherHost)
  })

  it('still refuses one attendee reading another', async () => {
    // The policy is additive. It must widen the table to hosts and to nobody
    // else — an attendee is not a host, and being on the same event grants
    // nothing.
    const { userClient, createTestUser } = await import('@/tests/helpers/db')
    const nosy = await createTestUser(db)

    const { data } = await userClient(nosy)
      .from('profiles')
      .select('id')
      .eq('id', free.attendeeId)

    expect(data ?? []).toHaveLength(0)

    await db.auth.admin.deleteUser(nosy).catch(() => {})
  })
})
