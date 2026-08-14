import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  type SeededEvent,
} from '@/tests/helpers/db'
import { sha256Hex } from '@/lib/checkin/offline/hash'
import type { Caller } from '@/lib/bookings/caller'

// Helper first (loads .env.local), then the service — same shape as
// lib/checkin/service.test.ts.
const { buildDoorPack } = await import('@/lib/checkin/service')

const admin = adminClient()

let seed: SeededEvent
let codes: string[]
let pendingAttendee: string

function caller(id: string): Caller {
  return { id } as Caller
}

beforeAll(async () => {
  seed = await seedEvent(admin, { quantity: 10, pricePaise: 0, status: 'published' })

  // One confirmed 3-seat booking via the real path — tickets get real codes.
  const { data, error } = await admin.rpc('book_free_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: 3,
    p_attendee_name: 'Asha',
    p_attendee_note: null,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)
  const bookingId = (data as { id: string }).id

  const { data: tickets } = await admin.from('tickets').select('code').eq('booking_id', bookingId)
  codes = tickets!.map((t) => t.code as string)

  // Check ONE in online, so the pack has to carry a checked-in row.
  const { error: checkinError } = await admin
    .rpc('check_in_ticket', {
      p_event_id: seed.eventId,
      p_code: codes[0],
      p_checked_in_by: seed.hostProfileId,
    })
    .single()
  if (checkinError) throw new Error(`setup check-in failed: ${checkinError.message}`)

  // A NON-confirmed booking with a hand-inserted ticket: must NOT appear.
  // (Tickets only exist for confirmed bookings via the real paths; this is the
  // direct-insert exception that proves the pack's status filter.)
  // pending_approval, not awaiting_payment: bookings_hold_has_expiry requires
  // a hold_expires_at on awaiting_payment rows and the seed helper sets none.
  pendingAttendee = await createTestUser(admin)
  const pending = await seedCapturedBooking(admin, seed, {
    status: 'pending_approval',
    captured: false,
    attendeeId: pendingAttendee,
  })
  const { error: ticketError } = await admin.from('tickets').insert({
    booking_id: pending.bookingId,
    // Random, because tickets.code is UNIQUE table-wide and a crashed run's
    // leftover row must not collide with the next run's insert.
    code: crypto.randomUUID().replace(/-/g, ''),
  })
  if (ticketError) throw new Error(`setup pending ticket failed: ${ticketError.message}`)
})

afterAll(async () => {
  await cleanupEvent(admin, seed)
  await admin.auth.admin.deleteUser(pendingAttendee).catch(() => {})
})

describe('buildDoorPack', () => {
  it('hashes codes, carries names/counts, and reflects a check-in', async () => {
    const result = await buildDoorPack(caller(seed.hostProfileId), seed.eventId)
    if (!result.ok) throw new Error(result.error)

    const pack = result.pack
    expect(pack.eventId).toBe(seed.eventId)
    expect(Date.parse(pack.generatedAt)).toBeGreaterThan(0)

    // Exactly the 3 confirmed tickets — the pending_approval insert is absent.
    expect(pack.tickets).toHaveLength(3)

    // Raw codes never appear; the hash of a real code finds its row.
    const hash0 = await sha256Hex(codes[0])
    const row0 = pack.tickets.find((t) => t.codeHash === hash0)
    expect(row0).toMatchObject({
      attendeeName: 'Asha',
      ticketsTotal: 3,
      ticketsIn: 1,
    })
    expect(row0!.checkedInAt).not.toBeNull()
    for (const t of pack.tickets) {
      expect(t.codeHash).toMatch(/^[0-9a-f]{64}$/)
      expect(codes).not.toContain(t.codeHash)
    }

    // The unchecked siblings carry the same booking counts, no timestamp.
    const hash1 = await sha256Hex(codes[1])
    expect(pack.tickets.find((t) => t.codeHash === hash1)).toMatchObject({
      checkedInAt: null,
      ticketsTotal: 3,
      ticketsIn: 1,
    })
  })

  it('refuses a caller who does not host the event, with the flat sentence', async () => {
    const outsider = await createTestUser(admin)
    const result = await buildDoorPack(caller(outsider), seed.eventId)
    expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
    await admin.auth.admin.deleteUser(outsider).catch(() => {})
  })
})
