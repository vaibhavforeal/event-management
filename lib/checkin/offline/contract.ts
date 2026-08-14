import type { DoorPack } from './pack'

/**
 * The wire contract between the scanner (client) and the check-in service
 * (server) for Phase 7. Lives in a client-safe module so the scanner, the
 * sync engine and the 'server-only' service can all import the SAME types —
 * type-only imports of service.ts from the client would work, but a shared
 * contract file keeps the boundary explicit.
 */

/** One offline scan, as queued on the device and posted to sync. */
export interface OfflineScanEntry {
  /** crypto.randomUUID() minted at scan time; the sync response echoes it. */
  id: string
  /** The raw 32-hex ticket code — captured at the door, held only until synced. */
  code: string
  /** Device clock at scan time, ISO 8601. The SQL clamps it; see the migration. */
  scannedAt: string
}

export type SyncEntryOutcome =
  | {
      id: string
      status: 'checked_in' | 'already_checked_in'
      attendeeName: string | null
      checkedInAt: string
      reference: string
      ticketsTotal: number
      ticketsIn: number
    }
  | {
      /** A RESOLVED refusal (EH020–EH022 in words): leaves the queue, lands in the report. */
      id: string
      status: 'refused'
      message: string
    }

export type SyncResult = { ok: true; outcomes: SyncEntryOutcome[] } | { ok: false; error: string }

export type DoorPackResult = { ok: true; pack: DoorPack } | { ok: false; error: string }
