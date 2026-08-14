import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'

/**
 * The RPC-level contract of Phase 7's check_in_ticket extension, against the
 * real database. Service-level behavior (authorization, batching) is
 * lib/checkin/service tests; this file pins the SQL itself: the clamp, the
 * offline flag, and the conflict branch staying first-write-wins.
 */

const admin = adminClient()

let seed: SeededEvent
let eventId: string
let hostId: string
let codes: string[]

/** Milliseconds of slack for "the database wrote now()". Generous for CI. */
const NOW_SLACK_MS = 10_000

function epoch(iso: string): number {
  return new Date(iso).getTime()
}

async function rpc(code: string, extra: { p_scanned_at?: string; p_offline?: boolean } = {}) {
  return admin
    .rpc('check_in_ticket', {
      p_event_id: eventId,
      p_code: code,
      p_checked_in_by: hostId,
      ...extra,
    })
    .single()
}

async function ticketRow(code: string) {
  const { data, error } = await admin
    .from('tickets')
    .select('checked_in_at, checked_in_offline')
    .eq('code', code)
    .single()
  if (error) throw new Error(`ticket read failed: ${error.message}`)
  return data as { checked_in_at: string | null; checked_in_offline: boolean }
}

beforeAll(async () => {
  seed = await seedEvent(admin, { quantity: 10, pricePaise: 0, status: 'published' })
  eventId = seed.eventId
  hostId = seed.hostProfileId

  const { data, error } = await admin.rpc('book_free_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: 5,
    p_attendee_name: 'Asha',
    p_attendee_note: null,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)

  const { data: tickets, error: ticketsError } = await admin
    .from('tickets')
    .select('code')
    .eq('booking_id', (data as { id: string }).id)
  if (ticketsError) throw new Error(`setup ticket read failed: ${ticketsError.message}`)
  codes = tickets!.map((t) => t.code as string)
})

afterAll(async () => {
  await cleanupEvent(admin, seed)
})

describe('check_in_ticket with defaults (the existing callers)', () => {
  it('writes now() and leaves checked_in_offline false', async () => {
    const before = Date.now()
    const { data, error } = await rpc(codes[0])
    expect(error).toBeNull()
    expect(data!.outcome).toBe('checked_in')
    const row = await ticketRow(codes[0])
    expect(Math.abs(epoch(row.checked_in_at!) - before)).toBeLessThan(NOW_SLACK_MS)
    expect(row.checked_in_offline).toBe(false)
  })
})

describe('check_in_ticket with p_scanned_at and p_offline (the sync path)', () => {
  it('honours a sane device timestamp and sets the offline flag', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const { data, error } = await rpc(codes[1], { p_scanned_at: twoHoursAgo, p_offline: true })
    expect(error).toBeNull()
    expect(data!.outcome).toBe('checked_in')
    const row = await ticketRow(codes[1])
    expect(Math.abs(epoch(row.checked_in_at!) - epoch(twoHoursAgo))).toBeLessThan(NOW_SLACK_MS)
    expect(row.checked_in_offline).toBe(true)
  })

  it('clamps a future timestamp to now()', async () => {
    const inOneHour = new Date(Date.now() + 3600 * 1000).toISOString()
    const before = Date.now()
    await rpc(codes[2], { p_scanned_at: inOneHour, p_offline: true })
    const row = await ticketRow(codes[2])
    expect(Math.abs(epoch(row.checked_in_at!) - before)).toBeLessThan(NOW_SLACK_MS)
  })

  it('clamps an ancient timestamp to 24 hours ago', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
    const expected = Date.now() - 24 * 3600 * 1000
    await rpc(codes[3], { p_scanned_at: threeDaysAgo, p_offline: true })
    const row = await ticketRow(codes[3])
    expect(Math.abs(epoch(row.checked_in_at!) - expected)).toBeLessThan(NOW_SLACK_MS)
  })

  it('a losing replay stays already_checked_in with the ORIGINAL write intact', async () => {
    // codes[0] was checked in online (offline=false, ~now) in the first test.
    const original = await ticketRow(codes[0])
    const yesterdayish = new Date(Date.now() - 3600 * 1000).toISOString()
    const { data, error } = await rpc(codes[0], { p_scanned_at: yesterdayish, p_offline: true })
    expect(error).toBeNull()
    expect(data!.outcome).toBe('already_checked_in')
    expect(data!.checked_in_at).toBe(original.checked_in_at)
    const after = await ticketRow(codes[0])
    expect(after).toEqual(original) // timestamp AND offline flag both unmoved
  })
})
