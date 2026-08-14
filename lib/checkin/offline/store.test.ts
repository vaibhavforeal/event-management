import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openDoorStore, type QueueEntry } from './store'
import type { DoorPack } from './pack'

/** A fresh in-memory IndexedDB per call — tests never share state. */
function freshStore() {
  return openDoorStore(new IDBFactory())
}

function pack(eventId: string, generatedAt: string): DoorPack {
  return { eventId, generatedAt, tickets: [] }
}

function entry(overrides: Partial<QueueEntry>): QueueEntry {
  return {
    id: crypto.randomUUID(),
    eventId: 'e1',
    code: 'a'.repeat(32),
    codeHash: 'h1',
    scannedAt: '2026-08-14T13:05:00.000Z',
    verdictAtScan: 'fresh',
    ...overrides,
  }
}

describe('openDoorStore', () => {
  it('returns null when IndexedDB is unavailable', async () => {
    expect(await openDoorStore(undefined)).toBeNull()
  })

  it('round-trips a pack and REPLACES it per event', async () => {
    const store = (await freshStore())!
    await store.savePack(pack('e1', '2026-08-14T13:00:00Z'))
    await store.savePack(pack('e1', '2026-08-14T14:00:00Z'))
    await store.savePack(pack('e2', '2026-08-14T13:30:00Z'))

    expect((await store.loadPack('e1'))?.generatedAt).toBe('2026-08-14T14:00:00Z')
    expect((await store.loadPack('e2'))?.generatedAt).toBe('2026-08-14T13:30:00Z')
    expect(await store.loadPack('e3')).toBeNull()
  })

  it('queues per event and removes only what it is told to', async () => {
    const store = (await freshStore())!
    const a = entry({ eventId: 'e1' })
    const b = entry({ eventId: 'e1', codeHash: 'h2', verdictAtScan: 'not_on_roster' })
    const other = entry({ eventId: 'e2' })
    await store.enqueue(a)
    await store.enqueue(b)
    await store.enqueue(other)

    const queued = await store.queueFor('e1')
    expect(queued.map((q) => q.id).sort()).toEqual([a.id, b.id].sort())

    await store.removeEntries('e1', [a.id])
    expect((await store.queueFor('e1')).map((q) => q.id)).toEqual([b.id])
    expect((await store.queueFor('e2')).map((q) => q.id)).toEqual([other.id])
  })

  it('a queue survives reopening the store (the locked-phone case)', async () => {
    const factory = new IDBFactory()
    const first = (await openDoorStore(factory))!
    const a = entry({ eventId: 'e1' })
    await first.enqueue(a)

    const second = (await openDoorStore(factory))!
    expect((await second.queueFor('e1')).map((q) => q.id)).toEqual([a.id])
  })
})
