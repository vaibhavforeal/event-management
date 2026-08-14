import { describe, expect, it } from 'vitest'
import { decideOffline, type QueuedScanFacts } from './verdict'
import type { DoorPack, PackTicket } from './pack'

const VALID = { valid: true, code: 'a'.repeat(32) } as const
const HASH = 'h-scanned'

function ticket(overrides: Partial<PackTicket>): PackTicket {
  return {
    codeHash: HASH,
    attendeeName: 'Asha',
    reference: 'ABCD1234',
    bookingId: 'b1',
    checkedInAt: null,
    ticketsTotal: 3,
    ticketsIn: 1,
    ...overrides,
  }
}

function pack(...tickets: PackTicket[]): DoorPack {
  return { eventId: 'e1', generatedAt: '2026-08-14T13:32:00Z', tickets }
}

describe('decideOffline', () => {
  it('an invalid signature is red and never queued — same reasons as online', () => {
    const decision = decideOffline(
      { valid: false, reason: 'bad_signature' },
      null,
      pack(ticket({})),
      [],
    )
    expect(decision).toEqual({
      verdict: { kind: 'invalid', reason: 'bad_signature' },
      enqueue: null,
    })
  })

  it('a valid payload without its hash is a programmer error, loudly', () => {
    expect(() => decideOffline(VALID, null, pack(ticket({})), [])).toThrow()
  })

  it('pack says checked in → amber with the pack timestamp, no queue', () => {
    const decision = decideOffline(
      VALID,
      HASH,
      pack(ticket({ checkedInAt: '2026-08-14T13:40:00Z', ticketsIn: 2 })),
      [],
    )
    expect(decision).toEqual({
      verdict: { kind: 'already', name: 'Asha', checkedInAt: '2026-08-14T13:40:00Z' },
      enqueue: null,
    })
  })

  it('already in the local queue → amber with the local scan time, no double-queue', () => {
    const queued: QueuedScanFacts[] = [{ codeHash: HASH, scannedAt: '2026-08-14T13:35:00Z' }]
    const decision = decideOffline(VALID, HASH, pack(ticket({})), queued)
    expect(decision).toEqual({
      verdict: { kind: 'already_queued', name: 'Asha', scannedAt: '2026-08-14T13:35:00Z' },
      enqueue: null,
    })
  })

  it('a queued-but-unlisted rescan is already_queued too (name unknown)', () => {
    const queued: QueuedScanFacts[] = [{ codeHash: HASH, scannedAt: '2026-08-14T13:35:00Z' }]
    const decision = decideOffline(VALID, HASH, pack(), queued)
    expect(decision).toEqual({
      verdict: { kind: 'already_queued', name: null, scannedAt: '2026-08-14T13:35:00Z' },
      enqueue: null,
    })
  })

  it('fresh and on the roster → green, counting pack + queued siblings + this scan', () => {
    const sibling = ticket({ codeHash: 'h-sibling' })
    const queued: QueuedScanFacts[] = [{ codeHash: 'h-sibling', scannedAt: '2026-08-14T13:30:00Z' }]
    const decision = decideOffline(VALID, HASH, pack(ticket({}), sibling), queued)
    expect(decision).toEqual({
      verdict: { kind: 'queued', name: 'Asha', ticketsIn: 3, ticketsTotal: 3 },
      enqueue: 'fresh',
    })
    // 3 = 1 (pack's ticketsIn) + 1 (queued sibling on booking b1) + 1 (this scan)
  })

  it('queued strangers on OTHER bookings do not inflate the count', () => {
    const stranger = ticket({ codeHash: 'h-stranger', bookingId: 'b2' })
    const queued: QueuedScanFacts[] = [{ codeHash: 'h-stranger', scannedAt: '2026-08-14T13:30:00Z' }]
    const decision = decideOffline(VALID, HASH, pack(ticket({}), stranger), queued)
    expect(decision.verdict).toEqual({ kind: 'queued', name: 'Asha', ticketsIn: 2, ticketsTotal: 3 })
  })

  it('valid HMAC but not on the roster → amber, queued as not_on_roster', () => {
    const decision = decideOffline(VALID, HASH, pack(ticket({ codeHash: 'h-other' })), [])
    expect(decision).toEqual({
      verdict: { kind: 'queued_unlisted', rosterAsOf: '2026-08-14T13:32:00Z' },
      enqueue: 'not_on_roster',
    })
  })

  it('no pack at all (never armed) → every valid ticket is unlisted with a null rosterAsOf', () => {
    const decision = decideOffline(VALID, HASH, null, [])
    expect(decision).toEqual({
      verdict: { kind: 'queued_unlisted', rosterAsOf: null },
      enqueue: 'not_on_roster',
    })
  })

  it('pack-checked-in wins over a stale local queue entry (DB truth beats device memory)', () => {
    const queued: QueuedScanFacts[] = [{ codeHash: HASH, scannedAt: '2026-08-14T13:35:00Z' }]
    const decision = decideOffline(
      VALID,
      HASH,
      pack(ticket({ checkedInAt: '2026-08-14T13:40:00Z' })),
      queued,
    )
    expect(decision).toEqual({
      verdict: { kind: 'already', name: 'Asha', checkedInAt: '2026-08-14T13:40:00Z' },
      enqueue: null,
    })
  })
})
