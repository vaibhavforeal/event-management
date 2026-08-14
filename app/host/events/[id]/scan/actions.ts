'use server'

import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import {
  buildDoorPack,
  checkInTicket,
  syncOfflineCheckIns,
  type CheckInResult,
} from '@/lib/checkin/service'
import type { DoorPackResult, OfflineScanEntry, SyncResult } from '@/lib/checkin/offline/contract'
import { RESCAN_SENTENCE } from '@/lib/checkin/sentences'
import { loginPath } from '@/lib/auth/session'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_PATTERN = /^[0-9a-f]{32}$/

/**
 * The scanner's write. Called imperatively from the client after a local
 * signature check — which the server does NOT rely on: authorisation is the
 * service's host check, and authenticity is the code lookup. A forged-but-
 * well-shaped payload that somehow passed the local verify still admits
 * nobody, because its code matches no row.
 */
export async function checkInByCode(eventId: string, code: string): Promise<CheckInResult> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  if (!UUID_PATTERN.test(eventId) || !CODE_PATTERN.test(code)) {
    // Junk shapes stop here. One sentence, because the scanner's next move is
    // the same regardless: scan again.
    return { ok: false, error: RESCAN_SENTENCE }
  }

  // No revalidatePath, deliberately — unlike checkInAttendee, which mutates
  // the very rows its page is showing. The scanner paints its verdict from
  // this return value, and the guest list re-renders when the host next opens
  // it; there is no cached payload here that just went stale.
  return checkInTicket(caller, eventId, code)
}

/**
 * A door's worth of offline scans, not a data-import surface. A real queue at
 * a pilot-scale door is tens of entries; the client drains in rounds of 200
 * (lib/checkin/offline/sync.ts) if it somehow isn't.
 */
const MAX_SYNC_BATCH = 200

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** The scanner's arming read. Same junk-shape posture as checkInByCode. */
export async function loadDoorPack(eventId: string): Promise<DoorPackResult> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  if (!UUID_PATTERN.test(eventId)) {
    return { ok: false, error: RESCAN_SENTENCE }
  }
  return buildDoorPack(caller, eventId)
}

/**
 * The queue drain. Entries are re-built field by field rather than passed
 * through, so a handcrafted POST cannot smuggle extra properties toward the
 * service. The verdict on each entry is the service's; this action only
 * refuses shapes.
 */
export async function syncOfflineCheckins(
  eventId: string,
  entries: OfflineScanEntry[],
): Promise<SyncResult> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const wellShaped =
    UUID_PATTERN.test(eventId) &&
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= MAX_SYNC_BATCH &&
    entries.every(
      (e) => UUID_PATTERN.test(e.id) && CODE_PATTERN.test(e.code) && isIsoInstant(e.scannedAt),
    )
  if (!wellShaped) {
    return { ok: false, error: RESCAN_SENTENCE }
  }

  return syncOfflineCheckIns(
    caller,
    eventId,
    entries.map(({ id, code, scannedAt }) => ({ id, code, scannedAt })),
  )
}
