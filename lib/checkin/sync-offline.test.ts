import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedEvent,
  type SeededEvent,
} from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

const { syncOfflineCheckIns } = await import('@/lib/checkin/service')

const admin = adminClient()

let seed: SeededEvent
let codes: string[]

function caller(id: string): Caller {
  return { id } as Caller
}

function entry(code: string, scannedAt: string) {
  return { id: crypto.randomUUID(), code, scannedAt }
}

beforeAll(async () => {
  seed = await seedEvent(admin, { quantity: 10, pricePaise: 0, status: 'published' })
  const { data, error } = await admin.rpc('book_free_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: 3,
    p_attendee_name: 'Asha',
    p_attendee_note: null,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)
  const { data: tickets } = await admin
    .from('tickets')
    .select('code')
    .eq('booking_id', (data as { id: string }).id)
  codes = tickets!.map((t) => t.code as string)

  // codes[1] goes in ONLINE first, so the batch below contains a conflict.
  const { error: checkinError } = await admin
    .rpc('check_in_ticket', {
      p_event_id: seed.eventId,
      p_code: codes[1],
      p_checked_in_by: seed.hostProfileId,
    })
    .single()
  if (checkinError) throw new Error(`setup check-in failed: ${checkinError.message}`)
})

afterAll(async () => {
  await cleanupEvent(admin, seed)
})

describe('syncOfflineCheckIns', () => {
  it('resolves a mixed batch per-entry: fresh, conflict, unknown code', async () => {
    const scannedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const fresh = entry(codes[0], scannedAt)
    const conflict = entry(codes[1], scannedAt)
    const unknown = entry('e'.repeat(32), scannedAt)

    const result = await syncOfflineCheckIns(caller(seed.hostProfileId), seed.eventId, [
      fresh,
      conflict,
      unknown,
    ])
    if (!result.ok) throw new Error(result.error)
    expect(result.outcomes).toHaveLength(3)

    expect(result.outcomes[0]).toMatchObject({
      id: fresh.id,
      status: 'checked_in',
      attendeeName: 'Asha',
    })
    // Device timestamp honoured (within clamp) on the fresh entry…
    const { data: freshRow } = await admin
      .from('tickets')
      .select('checked_in_at, checked_in_offline')
      .eq('code', codes[0])
      .single()
    expect(Math.abs(new Date(freshRow!.checked_in_at).getTime() - Date.parse(scannedAt))).toBeLessThan(10_000)
    expect(freshRow!.checked_in_offline).toBe(true)

    // …the conflict keeps the ORIGINAL online write…
    expect(result.outcomes[1]).toMatchObject({ id: conflict.id, status: 'already_checked_in' })
    const { data: conflictRow } = await admin
      .from('tickets')
      .select('checked_in_offline')
      .eq('code', codes[1])
      .single()
    expect(conflictRow!.checked_in_offline).toBe(false)

    // …and the unknown code is a RESOLVED refusal, not a batch failure.
    expect(result.outcomes[2]).toEqual({
      id: unknown.id,
      status: 'refused',
      message:
        'No such ticket for this event. It may be for a different event, or its booking was cancelled.',
    })
  })

  it('refuses a caller who does not host the event before touching any row', async () => {
    const outsider = await createTestUser(admin)
    const result = await syncOfflineCheckIns(caller(outsider), seed.eventId, [
      entry(codes[2], new Date().toISOString()),
    ])
    expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
    const { data } = await admin.from('tickets').select('checked_in_at').eq('code', codes[2]).single()
    expect(data!.checked_in_at).toBeNull()
    await admin.auth.admin.deleteUser(outsider).catch(() => {})
  })
})
