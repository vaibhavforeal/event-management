import type { DoorPack } from './pack'

/**
 * The ONLY file that touches IndexedDB. Everything above it is pure
 * (verdict.ts, sync.ts's planning) or a React component (scanner.tsx).
 *
 * Durability is the point: queued scans must survive a locked phone, a killed
 * tab and a reboot — that is why this is IndexedDB and not component state or
 * Next's in-memory pending Server Actions (see the spec's rejected
 * approaches). openDoorStore returns null where IndexedDB is unavailable
 * (private mode, storage pressure); the scanner then works exactly as today,
 * online-only, behind a visible banner. Any rejection mid-session is treated
 * the same way by callers. Never a hard failure.
 */

export interface QueueEntry {
  /** crypto.randomUUID() at scan time; sync outcomes echo it. */
  id: string
  eventId: string
  /** Raw code — needed to sync (the RPC's authority is the code lookup). */
  code: string
  /** sha256Hex(code) — what the verdict tree deduplicates on. */
  codeHash: string
  /** Device clock at scan time, ISO 8601. */
  scannedAt: string
  verdictAtScan: 'fresh' | 'not_on_roster'
}

export interface DoorStore {
  /** Replaces the event's previous pack — the roster is always whole. */
  savePack(pack: DoorPack): Promise<void>
  loadPack(eventId: string): Promise<DoorPack | null>
  enqueue(entry: QueueEntry): Promise<void>
  queueFor(eventId: string): Promise<QueueEntry[]>
  removeEntries(eventId: string, ids: string[]): Promise<void>
}

const DB_NAME = 'happenly-door'
const DB_VERSION = 1
const PACKS = 'packs'
const QUEUE = 'queue'
const QUEUE_BY_EVENT = 'by-event'

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function openDoorStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<DoorStore | null> {
  if (!factory) return null

  let db: IDBDatabase
  try {
    const request = factory.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const upgrading = request.result
      if (!upgrading.objectStoreNames.contains(PACKS)) {
        upgrading.createObjectStore(PACKS, { keyPath: 'eventId' })
      }
      if (!upgrading.objectStoreNames.contains(QUEUE)) {
        const queue = upgrading.createObjectStore(QUEUE, { keyPath: 'id' })
        queue.createIndex(QUEUE_BY_EVENT, 'eventId')
      }
    }
    db = await asPromise(request)
  } catch {
    return null
  }

  return {
    async savePack(pack) {
      const tx = db.transaction(PACKS, 'readwrite')
      tx.objectStore(PACKS).put(pack)
      await done(tx)
    },
    async loadPack(eventId) {
      const tx = db.transaction(PACKS, 'readonly')
      const found = await asPromise(tx.objectStore(PACKS).get(eventId))
      return (found as DoorPack | undefined) ?? null
    },
    async enqueue(entry) {
      const tx = db.transaction(QUEUE, 'readwrite')
      tx.objectStore(QUEUE).put(entry)
      await done(tx)
    },
    async queueFor(eventId) {
      const tx = db.transaction(QUEUE, 'readonly')
      const rows = await asPromise(tx.objectStore(QUEUE).index(QUEUE_BY_EVENT).getAll(eventId))
      return rows as QueueEntry[]
    },
    async removeEntries(eventId, ids) {
      // eventId is belt-and-braces: only this event's rows can be deleted even
      // if a stale id list crosses doors.
      const tx = db.transaction(QUEUE, 'readwrite')
      const queue = tx.objectStore(QUEUE)
      for (const id of ids) {
        const row = (await asPromise(queue.get(id))) as QueueEntry | undefined
        if (row && row.eventId === eventId) queue.delete(id)
      }
      await done(tx)
    },
  }
}
