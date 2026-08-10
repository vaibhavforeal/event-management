import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import type { CheckInResult } from '@/lib/checkin/service'

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
 * carrying this button.
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
 * Mocked because the authorisation this action depends on is not the action's:
 * checkInNextTicket owns "may this caller admit guests to this event", against
 * the real database, in Task 3's suite. What is tested here is the half that
 * suite cannot see: what a handcrafted POST to this endpoint can make the
 * action do before it gets there, and whether it gets there at all.
 */
const checkInNextTicket = vi.fn<(...args: unknown[]) => Promise<CheckInResult>>()
vi.mock('@/lib/checkin/service', () => ({
  checkInNextTicket: (...args: unknown[]) => checkInNextTicket(...args),
}))

const { checkInAttendee } = await import('@/app/host/events/[id]/attendees/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const BOOKING_ID = '00000000-0000-4000-8000-000000000042'
const ATTENDEES_PATH = `/host/events/${EVENT_ID}/attendees`

/** The form the check-in button submits. Pass `undefined` to leave a field out. */
function form(overrides: Record<string, string | undefined> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string | undefined> = {
    bookingId: BOOKING_ID,
    eventId: EVENT_ID,
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== undefined) fd.set(key, value)
  }
  return fd
}

/** Runs the action expecting a redirect, and returns where it went. */
async function captureRedirect(fd: FormData): Promise<string> {
  try {
    await checkInAttendee({}, fd)
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

describe('checkInAttendee', () => {
  it('redirects a signed-out host to login', async () => {
    caller = null
    expect(await captureRedirect(form())).toBe(`/login?next=${encodeURIComponent(ATTENDEES_PATH)}`)
    expect(checkInNextTicket).not.toHaveBeenCalled()
  })

  it('refuses a missing booking id without calling the service', async () => {
    const state = await checkInAttendee({}, form({ bookingId: undefined }))
    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(checkInNextTicket).not.toHaveBeenCalled()
  })

  it('refuses a booking id that is not uuid-shaped before the service sees it', async () => {
    // The cancel action next door deliberately validates its bookingId no
    // further than emptiness, because cancelBooking folds every failure into
    // one refusal sentence. checkInNextTicket does not: a junk shape reaches
    // the RPC as a failed uuid cast, and mapCheckinRpcError's fallback would
    // hand the host raw Postgres ("invalid input syntax for type uuid: …").
    checkInNextTicket.mockResolvedValue({ ok: true, outcome: 'checked_in', attendeeName: 'Asha',
      checkedInAt: 'now', reference: 'ABCD1234', ticketsTotal: 2, ticketsIn: 1 })
    const state = await checkInAttendee({}, form({ bookingId: 'not-a-uuid' }))
    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(checkInNextTicket).not.toHaveBeenCalled()
  })

  it('refuses an event id that is not uuid-shaped, because the service scopes by it', async () => {
    // Unlike the cancel action, eventId here is not merely a revalidation path —
    // it is the scope the service authorises against. Still safe if lied about
    // (wrong host → refused; wrong event → EH020), but a junk shape stops here.
    const state = await checkInAttendee({}, form({ eventId: 'not-a-uuid' }))
    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(checkInNextTicket).not.toHaveBeenCalled()
  })

  it('checks in under the caller’s identity and revalidates the list', async () => {
    checkInNextTicket.mockResolvedValue({ ok: true, outcome: 'checked_in', attendeeName: 'Asha',
      checkedInAt: 'now', reference: 'ABCD1234', ticketsTotal: 2, ticketsIn: 1 })
    const state = await checkInAttendee({}, form())
    expect(state).toEqual({})
    expect(checkInNextTicket).toHaveBeenCalledWith({ id: CALLER_ID }, EVENT_ID, BOOKING_ID)
    expect(revalidatePath).toHaveBeenCalledWith(ATTENDEES_PATH)
  })

  it('returns the service refusal verbatim and revalidates nothing', async () => {
    checkInNextTicket.mockResolvedValue({ ok: false, error: 'All seats on this booking are already checked in.' })
    const state = await checkInAttendee({}, form())
    expect(state).toEqual({ error: 'All seats on this booking are already checked in.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
