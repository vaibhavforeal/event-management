import { afterEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

/** Every user this file mints, so afterEach can put them back. */
let minted: string[] = []
/** Every event this file seeds, torn down bookings-first. */
let seeded: SeededEvent[] = []

afterEach(async () => {
  // Scoped to this file's own events on purpose. This database doubles as the
  // dev database and holds rows a person is keeping; a blanket delete from
  // bookings would take them with it.
  for (const seed of seeded) {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
  }
  // Users last: bookings.attendee_id is ON DELETE RESTRICT, so a user with a
  // surviving booking cannot go.
  for (const id of minted) await db.auth.admin.deleteUser(id).catch(() => {})
  seeded = []
  minted = []
})

async function waitlistEvent(options: {
  quantity: number
  pricePaise?: number
  maxPerOrder?: number
  allowsCash?: boolean
}) {
  const seed = await seedEvent(db, {
    quantity: options.quantity,
    pricePaise: options.pricePaise ?? 50_000,
    maxPerOrder: options.maxPerOrder ?? 10,
    allowsCash: options.allowsCash ?? false,
    hasWaitlist: true,
  })
  seeded.push(seed)
  return seed
}

/**
 * Takes `seats` with a confirmed booking, so the room is really full, and
 * returns the booking id the callers below cancel.
 *
 * The ordinary online sale rather than book_cash_tickets: almost every event
 * here is seeded without allows_cash — the offer engine has nothing to do with
 * cash, and one event needs it off — and the cash path rightly refuses those.
 * begin_paid_booking only holds, so confirm_booking follows: a hold that lapsed
 * mid-test would hand the seat to the very line under test.
 */
async function fill(seed: SeededEvent, seats: number): Promise<string> {
  const buyer = await createTestUser(db)
  minted.push(buyer)
  const { data, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: buyer,
    p_quantity: seats,
    p_attendee_name: 'Filler',
  })
  if (error) throw new Error(`fill failed: ${error.message}`)
  const { error: confirmError } = await db.rpc('confirm_booking', { p_booking_id: data!.id })
  if (confirmError) throw new Error(`fill confirm failed: ${confirmError.message}`)
  return data!.id
}

/** Joins the line as a named attendee and returns the entry's booking id. */
async function joinAs(
  seed: SeededEvent,
  attendee: string,
  seats: number,
  name: string,
  mode: 'online' | 'cash' = 'online',
): Promise<string> {
  const { data, error } = await db.rpc('join_waitlist', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: attendee,
    p_quantity: seats,
    p_attendee_name: name,
    p_payment_mode: mode,
  })
  if (error) throw new Error(`join failed: ${error.message}`)
  return data!.id
}

/**
 * Joins the line as a fresh attendee and returns the entry's booking id.
 *
 * A fresh user every time is not tidiness: waitlisted counts against
 * bookings_one_active_per_attendee, so two entries from one person on one event
 * are impossible by construction. Every extra place in a line is another person.
 */
async function join(
  seed: SeededEvent,
  seats: number,
  name: string,
  mode: 'online' | 'cash' = 'online',
): Promise<string> {
  const attendee = await createTestUser(db)
  minted.push(attendee)
  return joinAs(seed, attendee, seats, name, mode)
}

async function statusOf(bookingId: string): Promise<string> {
  const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
  return data!.status
}

async function reservedCount(ticketTypeId: string): Promise<number> {
  const { data } = await db.from('ticket_types').select('reserved_count').eq('id', ticketTypeId).single()
  return data!.reserved_count
}

describe('promote_from_waitlist', () => {
  it('offers a freed seat to the head, shaped exactly like a granted approval', async () => {
    const seed = await waitlistEvent({ quantity: 2 })
    const filler = await fill(seed, 2)
    const asha = await join(seed, 1, 'Asha')

    // The cancel itself promotes; nothing else is called.
    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    const { data } = await db.from('bookings').select('*').eq('id', asha).single()
    // Every field here is load-bearing rather than incidental: this exact shape
    // is what lets beginApprovedCheckout, the webhook and release_expired_holds
    // handle an offer without knowing a waitlist exists.
    expect(data!.status).toBe('awaiting_payment')
    expect(data!.approved_at).toBeTruthy()
    expect(data!.subtotal_paise).toBe(50_000)
    expect(data!.total_paise).toBe(50_000)
    expect(data!.convenience_fee_paise).toBe(0)
    expect(data!.commission_paise).toBe(0)
    const holdMs = new Date(data!.hold_expires_at!).getTime() - Date.now()
    expect(holdMs).toBeGreaterThan(23 * 3600_000)
    expect(holdMs).toBeLessThan(25 * 3600_000)
    // The seat left the pool with them.
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
    expect(await db.rpc('waitlist_length', { p_ticket_type_id: seed.ticketTypeId })).toMatchObject({ data: 0 })
  })

  it('strict FIFO: a head that does not fit blocks the line, and nobody passes them', async () => {
    const seed = await waitlistEvent({ quantity: 3, maxPerOrder: 3 })
    const filler = await fill(seed, 3)
    const bigHead = await join(seed, 3, 'Head of three')
    const single = await join(seed, 1, 'One seat')

    // Free exactly one seat: the head needs three, so nothing may happen —
    // and in particular the one-seat entry behind them must not jump.
    await db.from('bookings').update({ quantity: 2 }).eq('id', filler)
    await db.from('ticket_types').update({ reserved_count: 2 }).eq('id', seed.ticketTypeId)
    const { data: promoted } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })

    expect(promoted).toBe(0)
    expect(await statusOf(bigHead)).toBe('waitlisted')
    expect(await statusOf(single)).toBe('waitlisted')
    expect(await reservedCount(seed.ticketTypeId)).toBe(2)
  })

  it('chains down the line while seats keep fitting', async () => {
    const seed = await waitlistEvent({ quantity: 3 })
    const filler = await fill(seed, 3)
    const first = await join(seed, 1, 'First')
    const second = await join(seed, 1, 'Second')
    const third = await join(seed, 1, 'Third')

    // Two seats come back at once: the first two in line are offered, in order.
    await db.from('bookings').update({ quantity: 1 }).eq('id', filler)
    await db.from('ticket_types').update({ reserved_count: 1 }).eq('id', seed.ticketTypeId)
    const { data: promoted } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })

    expect(promoted).toBe(2)
    expect(await statusOf(first)).toBe('awaiting_payment')
    expect(await statusOf(second)).toBe('awaiting_payment')
    expect(await statusOf(third)).toBe('waitlisted')
    expect(await reservedCount(seed.ticketTypeId)).toBe(3)
    // The survivor is now the whole line, at position 1. waitlist_position and
    // the promotion loop each write the (created_at, id) ordering out
    // separately, so this is the assertion that holds the two to each other.
    const { data: position } = await db.rpc('waitlist_position', { p_booking_id: third })
    expect(position).toBe(1)
  })

  it('a lapsed offer expires, returns its seat, and the same call offers it onward', async () => {
    const seed = await waitlistEvent({ quantity: 1 })
    const filler = await fill(seed, 1)
    const first = await join(seed, 1, 'First')
    const second = await join(seed, 1, 'Second')

    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })
    expect(await statusOf(first)).toBe('awaiting_payment')

    // Their 24 hours run out without a payment or a claim. Scoped to this
    // ticket type rather than swept argument-less: the same loop and the same
    // promote pass run either way, and the unscoped call would reach every
    // lapsed hold in a database this file does not own.
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', first)
    await db.rpc('release_expired_holds', { p_ticket_type_id: seed.ticketTypeId })

    expect(await statusOf(first)).toBe('expired')
    expect(await statusOf(second)).toBe('awaiting_payment')
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
  })

  it('withdrawing a blocking head unblocks the line behind it', async () => {
    const seed = await waitlistEvent({ quantity: 3, maxPerOrder: 3 })
    const filler = await fill(seed, 3)
    const bigHead = await join(seed, 3, 'Head of three')
    const single = await join(seed, 1, 'One seat')

    // One seat free, blocked by the three-seat head.
    await db.from('bookings').update({ quantity: 2 }).eq('id', filler)
    await db.from('ticket_types').update({ reserved_count: 2 }).eq('id', seed.ticketTypeId)
    expect(await statusOf(single)).toBe('waitlisted')

    // The head withdraws. No seat is freed by that cancel — the entry held
    // none — but the line moves, which is why cancel_booking promotes
    // unconditionally rather than only when inventory came back.
    await db.rpc('cancel_booking', { p_booking_id: bigHead, p_reason: 'cancelled by attendee' })

    expect(await statusOf(single)).toBe('awaiting_payment')
    expect(await reservedCount(seed.ticketTypeId)).toBe(3)
  })

  it('reprices from the price at offer time, not the price when they joined', async () => {
    const seed = await waitlistEvent({ quantity: 1, pricePaise: 50_000 })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha')

    // The host raises the price while Asha is in the line. join_waitlist stored
    // 0/0/0 precisely so there is no stale number here to honour.
    await db.from('ticket_types').update({ price_paise: 80_000 }).eq('id', seed.ticketTypeId)
    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    const { data } = await db.from('bookings').select('subtotal_paise, total_paise').eq('id', asha).single()
    expect(data!.subtotal_paise).toBe(80_000)
    expect(data!.total_paise).toBe(80_000)
  })

  it('a walk-up cannot cut the line: the waitlister gets the freed seat', async () => {
    const seed = await waitlistEvent({ quantity: 1 })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha')
    const walkUp = await createTestUser(db)
    minted.push(walkUp)

    // The cancel and the walk-up's reservation race. Whichever order they
    // land in, the cancel's own promote runs under the ticket-type lock and
    // reserve_tickets promotes before it sells, so the seat is Asha's.
    const [, reserved] = await Promise.all([
      db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' }),
      db.rpc('reserve_tickets', {
        p_ticket_type_id: seed.ticketTypeId,
        p_attendee_id: walkUp,
        p_quantity: 1,
      }),
    ])

    expect(await statusOf(asha)).toBe('awaiting_payment')
    expect(reserved.error?.message).toContain('seats remain')
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
  })

  it('refuses a walk-up a seat the line is owed, even with no cancel racing it', async () => {
    // The test above races, so in the interleaving where the cancel commits
    // first it is the CANCEL's promote call that saves the seat, and it would
    // pass even on a reserve_tickets that had lost its own promote line. This
    // one has no race in it and no cancel in it at all, so it is the assertion
    // that actually pins `perform promote_from_waitlist` inside reserve_tickets:
    // delete that line and the walk-up below simply succeeds.
    //
    // Inventory can appear without anything freeing it — a host raising
    // capacity on an event that already has a line — and release_expired_holds
    // promotes only what it itself reclaimed, so nothing else in the system
    // reaches these seats.
    const seed = await waitlistEvent({ quantity: 1 })
    await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha')
    const walkUp = await createTestUser(db)
    minted.push(walkUp)

    // The host adds a seat. Nothing runs on its own: the line is owed it and
    // has not been given it yet.
    await db.from('ticket_types').update({ quantity: 2 }).eq('id', seed.ticketTypeId)
    expect(await statusOf(asha)).toBe('waitlisted')

    const { error } = await db.rpc('reserve_tickets', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: walkUp,
      p_quantity: 1,
    })

    // A seat is plainly free and the walk-up is still turned away: inside the
    // call, promote_from_waitlist spent it on Asha before the availability
    // check ran. The protective half of that line holds.
    expect(error?.message).toContain('only 0 seats remain')
    expect(await db.from('bookings').select('id').eq('attendee_id', walkUp)).toMatchObject({ data: [] })

    // KNOWN DEFECT, and this assertion pins it rather than blessing it: the
    // promotion does NOT survive. PostgREST runs the RPC in one transaction, so
    // the `raise` that refuses the walk-up rolls back the offer that caused the
    // refusal. Asha is back in the line and the seat is back in the pool, which
    // is why the two numbers below are the pre-call ones.
    //
    // reserve_tickets can therefore only ever be protective, never productive:
    // on the path where it raises, every promotion it just made is undone. See
    // .superpowers/sdd/2026-08-11-phase-5b-waitlist/task-2-report.md. When the
    // productive trigger is added, this test must fail here and be updated.
    expect(await statusOf(asha)).toBe('waitlisted')
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)

    // The control that says this is plumbing and not the engine: the seat is
    // genuinely owed to Asha, and the engine hands it over the moment it is
    // asked by a caller whose transaction goes on to commit.
    const { data: promoted } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })
    expect(promoted).toBe(1)
    expect(await statusOf(asha)).toBe('awaiting_payment')
    expect(await reservedCount(seed.ticketTypeId)).toBe(2)
  })

  it('offers nothing once the event has started', async () => {
    const seed = await waitlistEvent({ quantity: 1 })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha')

    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', seed.eventId)
    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    // Inert, not cancelled: the entry stays withdrawable and nothing sweeps it.
    expect(await statusOf(asha)).toBe('waitlisted')
    expect(await reservedCount(seed.ticketTypeId)).toBe(0)
  })

  it('is a no-op on an event that keeps no waitlist', async () => {
    const seed = await seedEvent(db, { quantity: 2, pricePaise: 50_000 })
    seeded.push(seed)
    const { data, error } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })
    expect(error).toBeNull()
    expect(data).toBe(0)
  })

  it('is a no-op for a ticket type that does not exist', async () => {
    // The three seams call this unconditionally, so "safe anywhere" has to hold
    // for arguments nothing in the product would ever produce.
    const { data, error } = await db.rpc('promote_from_waitlist', {
      p_ticket_type_id: '00000000-0000-4000-8000-00000000dead',
    })
    expect(error).toBeNull()
    expect(data).toBe(0)
  })

  it('offers cash and free entries the same hold, without confirming them', async () => {
    // The ghost-in-the-line case: a cash entry must still act inside its
    // window, or the seat is gone for 24 hours per inattentive person and
    // then forever.
    const seed = await waitlistEvent({ quantity: 1, allowsCash: true })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha', 'cash')

    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    const { data } = await db
      .from('bookings')
      .select('status, payment_mode, total_paise, hold_expires_at')
      .eq('id', asha)
      .single()
    expect(data!.status).toBe('awaiting_payment')
    expect(data!.payment_mode).toBe('cash')
    expect(data!.total_paise).toBe(50_000)
    expect(data!.hold_expires_at).toBeTruthy()
    // No tickets: nothing is confirmed until the seat is claimed.
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', asha)
    expect(count).toBe(0)
  })
})

describe('standing in the line is an active booking', () => {
  // bookings_one_active_per_attendee grew 'waitlisted', and the friendly
  // pre-check inside each of the three direct-booking doors was widened to
  // match it. Nothing proved the widening, so these three do.
  //
  // The SQLSTATE is the whole assertion, not the refusal. Every event below is
  // sold out, so an un-widened pre-check would still refuse — but from inside
  // reserve_tickets, as check_violation "only 0 seats remain", which is a true
  // sentence about the wrong thing and maps to different copy. The EH code is
  // the only evidence that the door itself turned them away, before it took a
  // single lock. That "before any lock" is the point: the pre-check exists to
  // stop the ABBA deadlock between a withdrawal and a direct booking by the
  // same person, and a refusal that comes after reserve_tickets has taken the
  // ticket_types lock is exactly the one that deadlocks.

  it('refuses a direct paid booking from someone already in the line with EH033', async () => {
    const seed = await waitlistEvent({ quantity: 1 })
    await fill(seed, 1)
    const asha = await createTestUser(db)
    minted.push(asha)
    await joinAs(seed, asha, 1, 'Asha')

    const { error } = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: asha,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH033')
  })

  it('refuses a cash booking from someone already in the line with EH054', async () => {
    // allows_cash on, so the only thing left to refuse them for is the line.
    const seed = await waitlistEvent({ quantity: 1, allowsCash: true })
    await fill(seed, 1)
    const asha = await createTestUser(db)
    minted.push(asha)
    await joinAs(seed, asha, 1, 'Asha', 'cash')

    const { error } = await db.rpc('book_cash_tickets', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: asha,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH054')
  })

  it('refuses a free booking from someone already in the line with EH012', async () => {
    // A free event fills through its own door — begin_paid_booking refuses a
    // zero price with EH030 — so this one seeds its filler by hand.
    const seed = await waitlistEvent({ quantity: 1, pricePaise: 0 })
    const filler = await createTestUser(db)
    minted.push(filler)
    const { error: fillError } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: filler,
      p_quantity: 1,
      p_attendee_name: 'Filler',
    })
    expect(fillError).toBeNull()

    const asha = await createTestUser(db)
    minted.push(asha)
    await joinAs(seed, asha, 1, 'Asha')

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: asha,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH012')
  })
})
