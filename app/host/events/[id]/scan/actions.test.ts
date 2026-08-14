import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import type { CheckInResult } from '@/lib/checkin/service'
import type { DoorPackResult, OfflineScanEntry, SyncResult } from '@/lib/checkin/offline/contract'

// Next's redirect() signals by throwing. Reproduce that so a test can assert a
// redirect happened without depending on Next's internal error shape.
class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`)
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))

const EVENT_ID = '00000000-0000-4000-8000-0000000000e1'

/**
 * A Server Action posts to the URL of the page it was called from, so proxy.ts
 * leaves that page's path here — the scanner, which is the only page calling
 * this action.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': `/host/events/${EVENT_ID}/scan` }),
}))

/**
 * Identity is mocked at its source rather than supplied to the action, because
 * there is no way to supply it: `Caller` is branded and lib/bookings/caller.ts
 * is the only module that can mint one.
 */
let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

/**
 * The seam that would otherwise reach Postgres as the service role.
 *
 * Mocked because the authorisation this action depends on is not the action's:
 * checkInTicket owns "may this caller admit guests to this event", against the
 * real database, in Task 3's suite. What is tested here is the half that suite
 * cannot see: what a handcrafted POST to this endpoint can make the action do
 * before it gets there, and whether it gets there at all.
 */
const checkInTicket = vi.fn<(...args: unknown[]) => Promise<CheckInResult>>()
const buildDoorPack = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const syncOfflineCheckIns = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('@/lib/checkin/service', () => ({
  checkInTicket: (...args: unknown[]) => checkInTicket(...args),
  buildDoorPack: (...args: unknown[]) => buildDoorPack(...args),
  syncOfflineCheckIns: (...args: unknown[]) => syncOfflineCheckIns(...args),
}))

const { checkInByCode, loadDoorPack, syncOfflineCheckins } = await import(
  '@/app/host/events/[id]/scan/actions'
)

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const CODE = 'a'.repeat(32)
const GENERIC = 'Something went wrong. Rescan the ticket.'

/** Runs the action expecting a redirect, and returns where it went. */
async function captureRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to
    throw error
  }
  throw new Error('Expected a redirect, but the action returned normally')
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as Caller
})

describe('checkInByCode', () => {
  it('redirects a signed-out caller to login carrying the scanner path', async () => {
    caller = null
    expect(await captureRedirect(() => checkInByCode(EVENT_ID, CODE))).toBe(
      `/login?next=${encodeURIComponent(`/host/events/${EVENT_ID}/scan`)}`,
    )
  })

  it('refuses junk before the service sees it', async () => {
    expect(await checkInByCode('not-a-uuid', CODE)).toEqual({ ok: false, error: GENERIC })
    expect(await checkInByCode(EVENT_ID, 'not-hex')).toEqual({ ok: false, error: GENERIC })
    expect(checkInTicket).not.toHaveBeenCalled()
  })

  it('passes a well-shaped scan through under the caller’s identity', async () => {
    checkInTicket.mockResolvedValue({ ok: true, outcome: 'checked_in', attendeeName: 'Asha',
      checkedInAt: 'now', reference: 'ABCD1234', ticketsTotal: 2, ticketsIn: 1 })
    const result = await checkInByCode(EVENT_ID, CODE)
    expect(checkInTicket).toHaveBeenCalledWith({ id: CALLER_ID }, EVENT_ID, CODE)
    expect(result.ok).toBe(true)
  })

  it('returns the service refusal untouched', async () => {
    checkInTicket.mockResolvedValue({ ok: false, error: 'This booking is not confirmed.' })
    expect(await checkInByCode(EVENT_ID, CODE)).toEqual({ ok: false, error: 'This booking is not confirmed.' })
  })
})

describe('loadDoorPack', () => {
  it('redirects a signed-out caller to login carrying the scanner path', async () => {
    caller = null
    expect(await captureRedirect(() => loadDoorPack(EVENT_ID))).toBe(
      `/login?next=${encodeURIComponent(`/host/events/${EVENT_ID}/scan`)}`,
    )
  })

  it('refuses a junk event id before the service sees it', async () => {
    expect(await loadDoorPack('not-a-uuid')).toEqual({ ok: false, error: GENERIC })
    expect(buildDoorPack).not.toHaveBeenCalled()
  })

  it('passes through under the caller\'s identity', async () => {
    const pack = { eventId: EVENT_ID, generatedAt: 'now', tickets: [] }
    buildDoorPack.mockResolvedValue({ ok: true, pack })
    expect(await loadDoorPack(EVENT_ID)).toEqual({ ok: true, pack })
    expect(buildDoorPack).toHaveBeenCalledWith({ id: CALLER_ID }, EVENT_ID)
  })
})

describe('syncOfflineCheckins', () => {
  const ENTRY = {
    id: '00000000-0000-4000-8000-00000000000a',
    code: 'b'.repeat(32),
    scannedAt: '2026-08-14T13:05:00.000Z',
  }

  it('redirects a signed-out caller', async () => {
    caller = null
    expect(await captureRedirect(() => syncOfflineCheckins(EVENT_ID, [ENTRY]))).toBe(
      `/login?next=${encodeURIComponent(`/host/events/${EVENT_ID}/scan`)}`,
    )
  })

  it('refuses junk shapes before the service sees them', async () => {
    expect(await syncOfflineCheckins('not-a-uuid', [ENTRY])).toEqual({ ok: false, error: GENERIC })
    expect(await syncOfflineCheckins(EVENT_ID, [])).toEqual({ ok: false, error: GENERIC })
    expect(await syncOfflineCheckins(EVENT_ID, [{ ...ENTRY, code: 'nope' }])).toEqual({
      ok: false,
      error: GENERIC,
    })
    expect(await syncOfflineCheckins(EVENT_ID, [{ ...ENTRY, id: 'nope' }])).toEqual({
      ok: false,
      error: GENERIC,
    })
    expect(await syncOfflineCheckins(EVENT_ID, [{ ...ENTRY, scannedAt: 'yesterday-ish' }])).toEqual({
      ok: false,
      error: GENERIC,
    })
    expect(syncOfflineCheckIns).not.toHaveBeenCalled()
  })

  it('caps a batch at 200 entries', async () => {
    const entries = Array.from({ length: 201 }, () => ({ ...ENTRY, id: crypto.randomUUID() }))
    expect(await syncOfflineCheckins(EVENT_ID, entries)).toEqual({ ok: false, error: GENERIC })
    expect(syncOfflineCheckIns).not.toHaveBeenCalled()
  })

  it('strips extra properties and passes through under the caller\'s identity', async () => {
    syncOfflineCheckIns.mockResolvedValue({ ok: true, outcomes: [] })
    const smuggled = { ...ENTRY, extra: 'ignored' } as typeof ENTRY
    expect(await syncOfflineCheckins(EVENT_ID, [smuggled])).toEqual({ ok: true, outcomes: [] })
    expect(syncOfflineCheckIns).toHaveBeenCalledWith({ id: CALLER_ID }, EVENT_ID, [ENTRY])
  })
})
