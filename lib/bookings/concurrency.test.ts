import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedEvent,
  type SeededEvent,
} from '@/tests/helpers/db'
// Side effect: installs the @/lib/supabase/server mock. Imported statically so
// its vi.mock hoists above everything here, which is what lets the second test
// run the host's real Server Action against real RLS as a chosen user.
import { signInAs } from '@/tests/helpers/session'
import type { Caller } from '@/lib/bookings/caller'
import { bookFreeTickets } from '@/lib/bookings/service'

// The same three mocks lib/events/actions.test.ts installs, for the same
// reasons: revalidatePath needs a request store there isn't one of here,
// redirect() signals by throwing, and loginPath() reads headers().
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
  notFound: () => {
    throw new Error('notFound')
  },
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

// Last, after every static import: tests/helpers/session.ts installs its mock on
// import, and the actions module has to bind the mocked client rather than the
// real one. A top-level await import is the only ordering that guarantees it.
const { updateEvent } = await import('@/app/host/events/actions')

const db = adminClient()
let event: SeededEvent

/** Application code cannot fabricate a Caller; a test may. */
function callerOf(id: string): Caller {
  return { id } as Caller
}

/**
 * Removes buyers and everything that references them.
 *
 * Order matters. bookings.attendee_id is ON DELETE RESTRICT, so a surviving
 * booking blocks the auth.users -> profiles cascade; delete the user first and
 * the failure is swallowed by the catch below, leaking a user and a profile per
 * buyer on every run.
 */
async function deleteBuyers(ids: string[]): Promise<void> {
  await db.from('bookings').delete().in('attendee_id', ids)
  await Promise.all(ids.map((id) => db.auth.admin.deleteUser(id).catch(() => {})))
}

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published', maxPerOrder: 1 })
})

afterAll(async () => {
  await cleanupEvent(db, event)
})

describe('booking concurrency', () => {
  /**
   * The v1 spec's mandatory test. The row lock in reserve_tickets is what makes
   * it pass; without it, fifty readers all see ten seats free and fifty bookings
   * land on a ten-seat event.
   *
   * lib/inventory/reservation.test.ts already fires fifty buyers at reserve_tickets
   * directly. What this adds is the rest of the transaction and the entry point
   * the product actually uses:
   *
   *  - book_free_tickets composes reserve_tickets, the attendee_name write and
   *    confirm_booking. The existing test proves only the reserve half
   *    serialises; a composition that took the lock and then issued tickets
   *    outside it would still leave that test green while printing fifty tickets
   *    for ten seats. Hence the ticket-row count below, which is the assertion
   *    the reserve-level test cannot make — it never confirms anything.
   *  - It runs through bookFreeTickets, so the forty losers have to come back as
   *    { ok: false } with a sentence, not as thrown PostgrestErrors that a
   *    Server Action would turn into a 500 for an attendee who simply arrived
   *    eleventh.
   */
  it('sells exactly ten seats to fifty simultaneous buyers', async () => {
    // Fifty distinct attendees, so bookings_one_active_per_attendee is not what
    // limits this — the row lock in reserve_tickets is. Fifty bookings by one
    // person on one event is refused by that index, and would prove nothing
    // about inventory. "Fifty simultaneous buyers" always meant fifty people.
    const buyers = await Promise.all(Array.from({ length: 50 }, () => createTestUser(db)))

    try {
      const results = await Promise.all(
        buyers.map((id, i) => bookFreeTickets(callerOf(id), event.ticketTypeId, 1, `Buyer ${i}`)),
      )

      const won = results.filter((r) => r.ok)
      expect(won).toHaveLength(10)

      // Every loser lost for want of a seat. A deadlock, a serialisation failure
      // or a crash would also produce { ok: false }, and would mean the lock
      // ordering had regressed rather than that the room was full.
      for (const lost of results.filter((r) => !r.ok)) {
        expect(lost.ok).toBe(false)
        if (lost.ok) continue
        expect(lost.error).toMatch(/seats remain/)
      }

      // Ten distinct references. Ten bookings that shared one would be ten
      // people holding the same seat at the door.
      expect(new Set(won.map((r) => (r.ok ? r.reference : ''))).size).toBe(10)

      const { data: tt } = await db
        .from('ticket_types')
        .select('quantity, reserved_count')
        .eq('id', event.ticketTypeId)
        .single()
      expect(tt!.reserved_count).toBe(10)
      expect(tt!.reserved_count).toBeLessThanOrEqual(tt!.quantity)

      const { data: bookings } = await db
        .from('bookings')
        .select('id')
        .eq('event_id', event.eventId)
        .eq('status', 'confirmed')
      expect(bookings).toHaveLength(10)

      // One ticket row per seat sold, no more. Free bookings confirm inside the
      // same transaction that reserves, so this is where a lock held over too
      // little of that transaction would show up.
      const { count } = await db
        .from('tickets')
        .select('id', { count: 'exact', head: true })
        .in(
          'booking_id',
          (bookings ?? []).map((b) => b.id),
        )
      expect(count).toBe(10)
    } finally {
      await deleteBuyers(buyers)
    }
  }, 60_000)
})

describe('capacity below what is booked', () => {
  it('refuses a host cutting seats under the number already taken', async () => {
    // EH001 has existed since 2026-08-09 and could never fire: reserved_count
    // was always 0 because nothing could book. This is the first time the path
    // is reachable, and it goes through the host's real edit action rather than
    // through the RPC, so the refusal is asserted as the host reads it.
    const seeded = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    const buyer = await createTestUser(db)

    try {
      const booked = await bookFreeTickets(callerOf(buyer), seeded.ticketTypeId, 4, 'Priya')
      expect(booked.ok).toBe(true)

      signInAs(seeded.hostProfileId)

      const fd = new FormData()
      fd.set('eventId', seeded.eventId)
      fd.set('title', 'Test Supper Club')
      fd.set('city', 'Indore')
      fd.set('venueName', 'The Terrace')
      fd.set('startsAtLocal', '2026-11-14T19:30')
      fd.set('seats', '2') // below the 4 already taken
      fd.set('priceRupees', '0')
      fd.set('hostDisplayName', 'Test Host')

      const state = await updateEvent({}, fd)

      expect(state.blockers ?? []).toHaveLength(1)
      // The count comes from the error's DETAIL, so this is the real
      // reserved_count reaching the host, not a number the action guessed.
      // '4' can only be the reserved count here — the seats field says 2.
      expect(state.blockers![0]).toContain('4')

      const { data } = await db
        .from('ticket_types')
        .select('quantity')
        .eq('id', seeded.ticketTypeId)
        .single()
      expect(data!.quantity).toBe(10) // untouched
    } finally {
      signInAs(null)
      await deleteBuyers([buyer])
      await cleanupEvent(db, seeded)
    }
  }, 30_000)
})
