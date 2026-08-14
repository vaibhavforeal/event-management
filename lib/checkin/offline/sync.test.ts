import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { applyOutcomes, drainQueue } from './sync'
import { openDoorStore, type QueueEntry } from './store'
import type { OfflineScanEntry, SyncEntryOutcome, SyncResult } from './contract'

function entry(id: string): QueueEntry {
  return {
    id,
    eventId: 'e1',
    code: 'a'.repeat(32),
    codeHash: `h-${id}`,
    scannedAt: '2026-08-14T13:05:00.000Z',
    verdictAtScan: 'fresh',
  }
}

function checkedIn(id: string): SyncEntryOutcome {
  return {
    id,
    status: 'checked_in',
    attendeeName: 'Asha',
    checkedInAt: '2026-08-14T13:05:00.000Z',
    reference: 'ABCD1234',
    ticketsTotal: 2,
    ticketsIn: 1,
  }
}

describe('applyOutcomes', () => {
  it('resolves every answered entry — refusals included — and reports each', () => {
    const queue = [entry('a'), entry('b'), entry('c')]
    const outcomes: SyncEntryOutcome[] = [
      checkedIn('a'),
      { id: 'b', status: 'refused', message: 'No such ticket for this event.' },
    ]
    const { resolvedIds, lines } = applyOutcomes(queue, outcomes)
    expect(resolvedIds.sort()).toEqual(['a', 'b'])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({ entryId: 'a', scannedAt: '2026-08-14T13:05:00.000Z', result: checkedIn('a') })
    expect(lines[1].result.status).toBe('refused')
  })

  it('ignores outcomes for entries it does not hold (a stale response)', () => {
    const { resolvedIds, lines } = applyOutcomes([entry('a')], [checkedIn('zzz')])
    expect(resolvedIds).toEqual([])
    expect(lines).toEqual([])
  })
})

describe('drainQueue', () => {
  async function storeWith(...entries: QueueEntry[]) {
    const store = (await openDoorStore(new IDBFactory()))!
    for (const e of entries) await store.enqueue(e)
    return store
  }

  it('drains in rounds of batchSize until empty', async () => {
    const store = await storeWith(entry('a'), entry('b'), entry('c'))
    const batches: OfflineScanEntry[][] = []
    const post = async (sent: OfflineScanEntry[]): Promise<SyncResult> => {
      batches.push(sent)
      return { ok: true, outcomes: sent.map((s) => checkedIn(s.id)) }
    }

    const { lines, remaining } = await drainQueue({ store, eventId: 'e1', post, batchSize: 2 })
    expect(batches.map((b) => b.length)).toEqual([2, 1])
    expect(lines).toHaveLength(3)
    expect(remaining).toBe(0)
    expect(await store.queueFor('e1')).toEqual([])
  })

  it('a transport failure keeps everything queued and stops the drain', async () => {
    const store = await storeWith(entry('a'), entry('b'))
    const post = async (): Promise<SyncResult> => ({ ok: false, error: 'Sync failed partway.' })

    const { lines, remaining } = await drainQueue({ store, eventId: 'e1', post })
    expect(lines).toEqual([])
    expect(remaining).toBe(2)
    expect(await store.queueFor('e1')).toHaveLength(2)
  })

  it('a refusal leaves the queue — it is resolved, not retried forever', async () => {
    const store = await storeWith(entry('a'))
    const post = async (sent: OfflineScanEntry[]): Promise<SyncResult> => ({
      ok: true,
      outcomes: sent.map((s) => ({ id: s.id, status: 'refused' as const, message: 'cancelled' })),
    })

    const { lines, remaining } = await drainQueue({ store, eventId: 'e1', post })
    expect(lines[0].result.status).toBe('refused')
    expect(remaining).toBe(0)
    expect(await store.queueFor('e1')).toEqual([])
  })

  it('an empty queue posts nothing', async () => {
    const store = await storeWith()
    let called = 0
    const post = async (): Promise<SyncResult> => {
      called += 1
      return { ok: true, outcomes: [] }
    }
    const { lines, remaining } = await drainQueue({ store, eventId: 'e1', post })
    expect(called).toBe(0)
    expect(lines).toEqual([])
    expect(remaining).toBe(0)
  })
})
