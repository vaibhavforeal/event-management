import type { VerifyResult } from '@/lib/tickets/signing'
import { packIndex, type DoorPack } from './pack'

/**
 * The offline half of the door's brain, pure so it is exhaustively testable.
 * Given what the crypto said, what the cached roster knows, and what this
 * device has already queued, decide what the card shows and whether to queue.
 *
 * The ordering below is the spec's verdict table. One case deserves its why:
 * valid-HMAC-but-not-on-roster CANNOT be distinguished offline between
 * "booked after the roster was cached" and "cancelled since it" — cancellation
 * deletes unscanned tickets server-side, so absence is ambiguous. The verdict
 * is amber, the scan queues, and the server settles it at sync (a cancelled
 * ticket comes back EH020 in the sync report).
 */

/** What the verdict needs to know about one queued scan. */
export interface QueuedScanFacts {
  codeHash: string
  scannedAt: string
}

export type OfflineVerdict =
  | { kind: 'invalid'; reason: 'malformed' | 'unsupported_version' | 'bad_signature' }
  /** The pack itself says this ticket was already in before signal died. */
  | { kind: 'already'; name: string | null; checkedInAt: string }
  /** This device already scanned it offline; pending sync. */
  | { kind: 'already_queued'; name: string | null; scannedAt: string }
  /** Green: on the roster, fresh, queued to sync. Counts include queued scans. */
  | { kind: 'queued'; name: string | null; ticketsIn: number; ticketsTotal: number }
  /** Amber: valid signature, unknown to the roster. Queued; host's discretion. */
  | { kind: 'queued_unlisted'; rosterAsOf: string | null }

export interface OfflineDecision {
  verdict: OfflineVerdict
  /** Non-null means: append a queue entry with this verdictAtScan. */
  enqueue: 'fresh' | 'not_on_roster' | null
}

export function decideOffline(
  verified: VerifyResult,
  codeHash: string | null,
  pack: DoorPack | null,
  queued: QueuedScanFacts[],
): OfflineDecision {
  if (!verified.valid) {
    return { verdict: { kind: 'invalid', reason: verified.reason }, enqueue: null }
  }
  if (codeHash === null) {
    // A valid payload always has a code; its hash is the caller's to compute.
    throw new Error('decideOffline: a valid payload must arrive with its codeHash')
  }

  const index = pack ? packIndex(pack) : null
  const row = index?.get(codeHash)

  if (row?.checkedInAt) {
    return {
      verdict: { kind: 'already', name: row.attendeeName, checkedInAt: row.checkedInAt },
      enqueue: null,
    }
  }

  const inQueue = queued.find((q) => q.codeHash === codeHash)
  if (inQueue) {
    return {
      verdict: { kind: 'already_queued', name: row?.attendeeName ?? null, scannedAt: inQueue.scannedAt },
      enqueue: null,
    }
  }

  if (!row) {
    return {
      verdict: { kind: 'queued_unlisted', rosterAsOf: pack?.generatedAt ?? null },
      enqueue: 'not_on_roster',
    }
  }

  // Count what the door has actually admitted: the pack's settled count, plus
  // queued scans that belong to the same booking, plus the scan in hand.
  const queuedOnBooking = queued.filter((q) => index!.get(q.codeHash)?.bookingId === row.bookingId).length
  return {
    verdict: {
      kind: 'queued',
      name: row.attendeeName,
      ticketsIn: row.ticketsIn + queuedOnBooking + 1,
      ticketsTotal: row.ticketsTotal,
    },
    enqueue: 'fresh',
  }
}
