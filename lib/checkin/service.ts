import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { mayCheckIn } from '@/lib/checkin/authorize'
import { mapCheckinRpcError } from '@/lib/checkin/rpc-errors'
import { RESCAN_SENTENCE } from '@/lib/checkin/sentences'
import { sha256Hex } from '@/lib/checkin/offline/hash'
import type { DoorPack, PackTicket } from '@/lib/checkin/offline/pack'
import type { DoorPackResult, OfflineScanEntry, SyncEntryOutcome, SyncResult } from '@/lib/checkin/offline/contract'
import type { Caller } from '@/lib/bookings/caller'

/**
 * Every check-in write in the product. One of exactly three files permitted to
 * import lib/supabase/admin.ts — with lib/bookings/service.ts and
 * lib/payments/service.ts; the ESLint fence names all three.
 *
 * Same contract as lib/bookings/service.ts: RLS does not see these writes, so
 * the authorisation below is the whole of the rule, and identity is a Caller
 * that only lib/bookings/caller.ts can mint. The Caller brand is reused rather
 * than re-declared because a second brand would mean a second thing to audit.
 */

export type CheckInResult =
  | {
      ok: true
      outcome: 'checked_in' | 'already_checked_in'
      attendeeName: string | null
      checkedInAt: string
      reference: string
      ticketsTotal: number
      /**
       * Display only, and may under-count by one: when two next-ticket taps
       * race, each admits its own ticket (SKIP LOCKED) but counts under READ
       * COMMITTED, so the loser's count can miss the winner's still-uncommitted
       * write. The next render reads the settled rows. Do not gate anything on
       * this number.
       */
      ticketsIn: number
    }
  | { ok: false; error: string }

/**
 * The generated RPC types say `outcome: string`; the SQL can only ever say
 * these two words. Narrowed here instead of cast, so a broken contract —
 * a bad migration, a renamed literal — refuses at the door rather than
 * painting a made-up verdict. Exported for its unit test only.
 */
export function asCheckInOutcome(value: string): 'checked_in' | 'already_checked_in' | null {
  return value === 'checked_in' || value === 'already_checked_in' ? value : null
}

/**
 * One sentence for "not your event", "no such event" and "the lookup failed",
 * for the same reason cancelBooking has NOT_YOURS: every path that fails to
 * establish the caller's right refuses identically, so there is nothing an
 * outsider can tell apart.
 */
const NOT_YOUR_DOOR = 'That is not your event to check tickets in for.'

/** Loads the event's host and applies mayCheckIn. Null means refuse. */
async function authorizedEventHost(caller: Caller, eventId: string): Promise<boolean> {
  const db = createAdminClient()
  const { data: event, error } = await db
    .from('events')
    .select('hosts(profile_id)')
    .eq('id', eventId)
    .maybeSingle()

  if (error) {
    console.error('[checkin] could not read event for authorisation', error)
    return false
  }
  if (!event) return false
  return mayCheckIn(caller, { host_profile_id: event.hosts.profile_id })
}

export async function checkInTicket(
  caller: Caller,
  eventId: string,
  code: string,
): Promise<CheckInResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const { data, error } = await db
    .rpc('check_in_ticket', {
      p_event_id: eventId,
      p_code: code,
      // The verified caller, never a form field: who admitted this guest.
      p_checked_in_by: caller.id,
    })
    .single()

  if (error) return { ok: false, error: mapCheckinRpcError(error) }
  const outcome = asCheckInOutcome(data.outcome)
  if (outcome === null) {
    console.error('[checkin] check_in_ticket returned an unknown outcome', data.outcome)
    return { ok: false, error: RESCAN_SENTENCE }
  }
  return {
    ok: true,
    outcome,
    attendeeName: data.attendee_name,
    checkedInAt: data.checked_in_at,
    reference: data.reference,
    ticketsTotal: data.tickets_total,
    ticketsIn: data.tickets_in,
  }
}

export async function checkInNextTicket(
  caller: Caller,
  eventId: string,
  bookingId: string,
): Promise<CheckInResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const { data, error } = await db
    .rpc('check_in_next_ticket', {
      p_event_id: eventId,
      p_booking_id: bookingId,
      p_checked_in_by: caller.id,
    })
    .single()

  if (error) return { ok: false, error: mapCheckinRpcError(error) }
  const outcome = asCheckInOutcome(data.outcome)
  if (outcome === null) {
    console.error('[checkin] check_in_next_ticket returned an unknown outcome', data.outcome)
    return { ok: false, error: RESCAN_SENTENCE }
  }
  return {
    ok: true,
    outcome,
    attendeeName: data.attendee_name,
    checkedInAt: data.checked_in_at,
    reference: data.reference,
    ticketsTotal: data.tickets_total,
    ticketsIn: data.tickets_in,
  }
}

/** Fail-closed, like every read that feeds a decision (the 6b lesson). */
const PACK_UNAVAILABLE = 'Could not load the door list. Refresh to try again.'

/**
 * The door pack: this event's roster for the scanner to cache before doors.
 * Codes are HASHED here, on the server — the raw bearer codes never reach
 * IndexedDB. Only confirmed bookings ship: that is every ticket the real
 * paths create today, and the status filter is the same safety net EH021 is.
 */
export async function buildDoorPack(caller: Caller, eventId: string): Promise<DoorPackResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const { data, error } = await db
    .from('tickets')
    .select('code, checked_in_at, booking_id, bookings!inner(attendee_name, reference, status, event_id)')
    .eq('bookings.event_id', eventId)
    .eq('bookings.status', 'confirmed')

  if (error) {
    console.error('[checkin] door pack read failed', error)
    return { ok: false, error: PACK_UNAVAILABLE }
  }

  // Per-booking totals from the rows themselves: every confirmed ticket of
  // the event is in `data`, so counting here matches what the RPC would say.
  const totals = new Map<string, { total: number; checkedIn: number }>()
  for (const row of data) {
    const t = totals.get(row.booking_id) ?? { total: 0, checkedIn: 0 }
    t.total += 1
    if (row.checked_in_at !== null) t.checkedIn += 1
    totals.set(row.booking_id, t)
  }

  const tickets: PackTicket[] = await Promise.all(
    data.map(async (row) => ({
      codeHash: await sha256Hex(row.code),
      attendeeName: row.bookings.attendee_name,
      reference: row.bookings.reference,
      bookingId: row.booking_id,
      checkedInAt: row.checked_in_at,
      ticketsTotal: totals.get(row.booking_id)!.total,
      ticketsIn: totals.get(row.booking_id)!.checkedIn,
    })),
  )

  const pack: DoorPack = { eventId, generatedAt: new Date().toISOString(), tickets }
  return { ok: true, pack }
}

/**
 * Whole-batch failure: something other than a door refusal broke mid-sync.
 * The client keeps EVERYTHING queued and retries — including entries already
 * applied this round, which the RPC's test-and-set turns into harmless
 * 'already_checked_in' rows. Idempotence is why discarding partial outcomes
 * here is safe.
 */
const SYNC_FAILED = 'Sync failed partway. Queued scans are kept and will retry.'

/** The SQLSTATEs that are answers, not failures. Anything else aborts the batch. */
const DOOR_REFUSALS = new Set(['EH020', 'EH021', 'EH022'])

/**
 * Drains one device's offline queue for one event. Authorizes ONCE, then
 * applies entries sequentially through the same RPC as online check-in, with
 * p_offline = true and the device's clamped scan time. Refusals resolve
 * per-entry; they are outcomes the host reads in the sync report, and they
 * must never poison the batch.
 */
export async function syncOfflineCheckIns(
  caller: Caller,
  eventId: string,
  entries: OfflineScanEntry[],
): Promise<SyncResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const outcomes: SyncEntryOutcome[] = []

  for (const entry of entries) {
    const { data, error } = await db
      .rpc('check_in_ticket', {
        p_event_id: eventId,
        p_code: entry.code,
        p_checked_in_by: caller.id,
        p_scanned_at: entry.scannedAt,
        p_offline: true,
      })
      .single()

    if (error) {
      if (DOOR_REFUSALS.has(error.code)) {
        outcomes.push({ id: entry.id, status: 'refused', message: mapCheckinRpcError(error) })
        continue
      }
      console.error('[checkin] offline sync write failed', error)
      return { ok: false, error: SYNC_FAILED }
    }

    const status = asCheckInOutcome(data.outcome)
    if (status === null) {
      // A broken contract is a failure, not an answer: abort the batch so the
      // queue holds and nothing is marked resolved on a verdict nobody gave.
      console.error('[checkin] offline sync returned an unknown outcome', data.outcome)
      return { ok: false, error: SYNC_FAILED }
    }

    outcomes.push({
      id: entry.id,
      status,
      attendeeName: data.attendee_name,
      checkedInAt: data.checked_in_at,
      reference: data.reference,
      ticketsTotal: data.tickets_total,
      ticketsIn: data.tickets_in,
    })
  }

  return { ok: true, outcomes }
}
