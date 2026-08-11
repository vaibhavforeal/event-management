import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam these actions have is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import type { ApproveResult } from '@/lib/bookings/service'

// revalidatePath needs a request store; there isn't one here.
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))

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
 * A Server Action posts to the URL of the page the form is on, so proxy.ts
 * leaves that page's path here — the guest list, which is the only page
 * carrying these buttons.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': `/host/events/${EVENT_ID}/attendees` }),
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
 * Mocked because the authorisation these actions depend on is not theirs:
 * approveBooking and declineBooking own "may this caller decide this request"
 * (mayApprove against the booking's real event) in Task 3's suite. What is
 * tested here is the half that suite cannot see: what a handcrafted POST to
 * this endpoint can make the action do before it gets there, and whether it
 * gets there at all. cancelBooking is exported too because the module under
 * test imports it for the cancel action that shares this file.
 */
const approveBooking = vi.fn<(...args: unknown[]) => Promise<ApproveResult>>()
const declineBooking = vi.fn<(...args: unknown[]) => Promise<ApproveResult>>()
vi.mock('@/lib/bookings/service', () => ({
  approveBooking: (...args: unknown[]) => approveBooking(...args),
  declineBooking: (...args: unknown[]) => declineBooking(...args),
  cancelBooking: vi.fn(),
}))

const { approveRequest, declineRequest } = await import(
  '@/app/host/events/[id]/attendees/actions'
)

type Action = typeof approveRequest

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const BOOKING_ID = '00000000-0000-4000-8000-000000000042'
const ATTENDEES_PATH = `/host/events/${EVENT_ID}/attendees`
const EVENT_PATH = '/e/diwali-supper'

/** The form the approve button submits. Pass `undefined` to leave a field out.
    The decline button's form is the same minus the slug — its action never
    reads one, so the same builder serves both. */
function form(overrides: Record<string, string | undefined> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string | undefined> = {
    bookingId: BOOKING_ID,
    eventId: EVENT_ID,
    slug: 'diwali-supper',
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== undefined) fd.set(key, value)
  }
  return fd
}

/** Runs an action expecting a redirect, and returns where it went. */
async function captureRedirect(action: Action, fd: FormData): Promise<string> {
  try {
    await action({}, fd)
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to
    throw error
  }
  throw new Error('Expected a redirect, but the action returned normally')
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as Caller
  approveBooking.mockResolvedValue({ ok: true })
  declineBooking.mockResolvedValue({ ok: true })
})

describe('approval actions, signed out', () => {
  it('redirects both actions to login carrying the guest list the host was on', async () => {
    // The session expiring while the queue sat open is the ordinary way to
    // reach this, and the `?next=` puts the host back on the same event's
    // list afterwards rather than on the feed.
    caller = null

    for (const action of [approveRequest, declineRequest]) {
      expect(await captureRedirect(action, form())).toBe(
        `/login?next=${encodeURIComponent(ATTENDEES_PATH)}`,
      )
    }
    expect(approveBooking).not.toHaveBeenCalled()
    expect(declineBooking).not.toHaveBeenCalled()
  })
})

describe('approval actions input guards', () => {
  it('refuse a missing booking id without calling the service', async () => {
    // The buttons cannot produce this: bookingId is a hidden input the page
    // writes from a row it just rendered. A request built with curl can.
    for (const [action, service] of [
      [approveRequest, approveBooking],
      [declineRequest, declineBooking],
    ] as const) {
      const state = await action({}, form({ bookingId: undefined }))

      expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
      expect(service).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    }
  })

  it('refuse an empty booking id, not just an absent one', async () => {
    // `String(null)` is "null", so the guard has to test the coerced string.
    for (const [action, service] of [
      [approveRequest, approveBooking],
      [declineRequest, declineBooking],
    ] as const) {
      const state = await action({}, form({ bookingId: '' }))

      expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
      expect(service).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    }
  })
})

describe('approveRequest, signed in', () => {
  it("approves under the caller's own identity, with the form's bookingId only", async () => {
    // Two arguments and eventId is not among them: the service re-derives the
    // event from the booking row and runs mayApprove against it, so a hidden
    // input naming somebody else's event cannot widen what can be approved.
    await approveRequest({}, form())

    expect(approveBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID)
  })

  it('revalidates the guest list, the event page and the feed, and returns a clear state', async () => {
    // All three, because approval moves reserved_count: the row leaves the
    // queue, the public page's seats-left count just dropped, and the feed
    // carries the same reserved_count in its payload. The cancel action next
    // door revalidates the same pair, pointing the other way. The empty object
    // clears an error left over from a previous submit of the same form.
    const state = await approveRequest({}, form())

    expect(state).toEqual({})
    expect(revalidatePath.mock.calls.flat()).toEqual([ATTENDEES_PATH, EVENT_PATH, '/'])
  })

  it('only lets a uuid-shaped eventId name the attendees path', async () => {
    // eventId is a hidden input interpolated into a path — a junk shape means
    // no attendees revalidation, not a path of the sender's choosing. The
    // other two paths do not depend on it.
    for (const eventId of ['../../../login', 'not-a-uuid', '']) {
      vi.clearAllMocks()
      approveBooking.mockResolvedValue({ ok: true })

      const state = await approveRequest({}, form({ eventId }))

      expect(state).toEqual({})
      expect(revalidatePath.mock.calls.flat()).toEqual([EVENT_PATH, '/'])
    }
  })

  it('only lets a slug-shaped slug name the event path', async () => {
    // Same guard as the cancel action's: falsiness alone let `../../host`
    // through as a path segment. isEventSlug owns the real shape.
    for (const slug of ['../../host/events', 'a/b', 'x%2fy', '']) {
      vi.clearAllMocks()
      approveBooking.mockResolvedValue({ ok: true })

      const state = await approveRequest({}, form({ slug }))

      expect(state).toEqual({})
      expect(revalidatePath.mock.calls.flat()).toEqual([ATTENDEES_PATH, '/'])
    }
  })

  it("returns the service's own refusal and revalidates nothing", async () => {
    // Nothing moved, so nothing is stale — and the one refusal sentence is
    // the service's, not re-worded here.
    approveBooking.mockResolvedValue({ ok: false, error: 'That request is not yours to decide.' })

    const state = await approveRequest({}, form())

    expect(state).toEqual({ error: 'That request is not yours to decide.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('declineRequest, signed in', () => {
  it("declines under the caller's own identity, with the form's bookingId only", async () => {
    await declineRequest({}, form())

    expect(declineBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID)
  })

  it('revalidates ONLY the attendees path — a decline moves no inventory', async () => {
    // The request never held a seat, so the public page's count and the feed
    // payload are exactly as they were. Only the queue needs repainting.
    const state = await declineRequest({}, form())

    expect(state).toEqual({})
    expect(revalidatePath.mock.calls.flat()).toEqual([ATTENDEES_PATH])
  })

  it('does not let a junk eventId reach revalidatePath at all', async () => {
    // With the attendees path being decline's only revalidation, a junk shape
    // means no revalidation whatsoever — not `/host/events/../../../login/…`.
    for (const eventId of ['../../../login', 'not-a-uuid', '']) {
      vi.clearAllMocks()
      declineBooking.mockResolvedValue({ ok: true })

      const state = await declineRequest({}, form({ eventId }))

      expect(state).toEqual({})
      expect(revalidatePath).not.toHaveBeenCalled()
    }
  })

  it("returns the service's own refusal and revalidates nothing", async () => {
    declineBooking.mockResolvedValue({
      ok: false,
      error: 'This request was already handled — refresh to see where it stands.',
    })

    const state = await declineRequest({}, form())

    expect(state).toEqual({
      error: 'This request was already handled — refresh to see where it stands.',
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
