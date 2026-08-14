import type { OfflineScanEntry, SyncEntryOutcome, SyncResult } from './contract'
import type { DoorStore, QueueEntry } from './store'

/**
 * Draining the queue, split pure/impure: applyOutcomes decides what resolved
 * (tested exhaustively), drainQueue turns that over the store and the wire.
 *
 * The one rule that matters: an entry leaves the queue ONLY on a received
 * per-entry outcome. A response lost mid-flight keeps everything queued; the
 * retry replays entries the server may have already applied, and the RPC's
 * test-and-set turns those into 'already_checked_in' — idempotent by
 * construction. Refusals DO leave the queue: they are answers (cancelled
 * ticket, wrong event), and retrying them forever would wedge the drain.
 *
 * A drain that stops on a failed post also carries WHY: stopReason is that
 * post's error verbatim (an expired session says "sign in to sync"; a flake
 * says its flake), null when the queue ran dry or was empty to begin with.
 * The scanner shows it next to the queue badge, so a held queue is never mute.
 */

export interface SyncReportLine {
  entryId: string
  /** When this device scanned it — the report pairs it with the server's answer. */
  scannedAt: string
  result: SyncEntryOutcome
}

export function applyOutcomes(
  queue: QueueEntry[],
  outcomes: SyncEntryOutcome[],
): { resolvedIds: string[]; lines: SyncReportLine[] } {
  const byId = new Map(queue.map((e) => [e.id, e]))
  const resolvedIds: string[] = []
  const lines: SyncReportLine[] = []
  for (const outcome of outcomes) {
    const entry = byId.get(outcome.id)
    if (!entry) continue // stale or foreign outcome: nothing of ours resolved
    resolvedIds.push(entry.id)
    lines.push({ entryId: entry.id, scannedAt: entry.scannedAt, result: outcome })
  }
  return { resolvedIds, lines }
}

/** Matches MAX_SYNC_BATCH in the scan actions; rounds keep any queue drainable. */
const DEFAULT_BATCH_SIZE = 200

export async function drainQueue(args: {
  store: DoorStore
  eventId: string
  post: (entries: OfflineScanEntry[]) => Promise<SyncResult>
  batchSize?: number
}): Promise<{ lines: SyncReportLine[]; remaining: number; stopReason: string | null }> {
  const { store, eventId, post, batchSize = DEFAULT_BATCH_SIZE } = args
  const lines: SyncReportLine[] = []

  for (;;) {
    const queue = await store.queueFor(eventId)
    if (queue.length === 0) return { lines, remaining: 0, stopReason: null }

    const batch = queue.slice(0, batchSize)
    const result = await post(batch.map(({ id, code, scannedAt }) => ({ id, code, scannedAt })))
    if (!result.ok) {
      // Transport/auth failure: stop, keep everything, let the next trigger
      // retry — and hand the post's own words up as the reason the queue held.
      return { lines, remaining: queue.length, stopReason: result.error }
    }

    const applied = applyOutcomes(batch, result.outcomes)
    await store.removeEntries(eventId, applied.resolvedIds)
    lines.push(...applied.lines)

    // A response that resolved nothing would loop forever on the same batch.
    // The post itself succeeded, so there is no reason to report — just stop.
    if (applied.resolvedIds.length === 0) {
      return { lines, remaining: queue.length, stopReason: null }
    }
  }
}
