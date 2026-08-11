import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: dotenv at load, so lib/env.ts can validate the client env
// when @/lib/auth/session pulls in the Supabase client below. Nothing here
// touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

// The mock block is approved-pay.test.ts's, seam for seam: this action is that
// action's twin, for the offers with no online money to ask for.

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

/**
 * A Server Action posts to the URL of the page it was called from, so proxy.ts
 * leaves that page's path here — the booking page carrying the Claim button.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/bookings/VYRB4SHQ' }),
}))

/**
 * Identity is mocked at its source rather than supplied to the action, because
 * there is no way to supply it: `Caller` is branded and lib/bookings/caller.ts
 * is the only module that can mint one.
 */
let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

/**
 * The seams that would otherwise reach Postgres. Mocked because the
 * authorisation this action leans on is not the action's: whether the caller IS
 * the attendee, and whether the row is still a live claimable offer, belongs to
 * claimOfferedSeat against the real database in Task 4's suite. What is tested
 * here is what a handcrafted POST to this endpoint can make the action do.
 */
vi.mock('@/lib/bookings/service', () => ({ claimOfferedSeat: vi.fn() }))
vi.mock('@/lib/payments/service', () => ({
  beginApprovedCheckout: vi.fn(),
  reconcileAfterCheckout: vi.fn(),
  reconcileBooking: vi.fn(),
}))
vi.mock('@/lib/bookings/queries', () => ({ getBookingByReference: vi.fn() }))

const { claimOfferedSeat } = vi.mocked(await import('@/lib/bookings/service'))
const { getBookingByReference } = vi.mocked(await import('@/lib/bookings/queries'))
const { claimSeat } = await import('@/app/bookings/[reference]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const RELOAD_SENTENCE = 'Something went wrong. Reload the page and try again.'
const OFFER = { id: 'b-1', status: 'awaiting_payment' }

/** The form the claim panel submits: one hidden reference field. */
function form(reference = 'VYRB4SHQ'): FormData {
  const fd = new FormData()
  fd.set('reference', reference)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as unknown as Caller
  getBookingByReference.mockResolvedValue(OFFER as never)
  claimOfferedSeat.mockResolvedValue({ ok: true })
})

describe('claimSeat', () => {
  it('sends a signed-out visitor to sign in rather than claiming as nobody', async () => {
    // The session expiring inside the 24-hour window, with the page still open,
    // is the ordinary way to get here. The destination is asserted too: a bare
    // '/login' loses the offer they were looking at, which is the one thing
    // this redirect exists to preserve.
    caller = null

    await expect(claimSeat({}, form())).rejects.toBeInstanceOf(RedirectSignal)
    await expect(claimSeat({}, form())).rejects.toMatchObject({
      to: '/login?next=%2Fbookings%2FVYRB4SHQ',
    })
    expect(getBookingByReference).not.toHaveBeenCalled()
    expect(claimOfferedSeat).not.toHaveBeenCalled()
  })

  it('claims through the service, which owns the decision', async () => {
    expect(await claimSeat({}, form())).toEqual({})
    expect(claimOfferedSeat).toHaveBeenCalledWith({ id: CALLER_ID }, 'b-1')
  })

  it('claims as the session, not as whoever the form says', async () => {
    // The branded Caller makes this a compile error rather than a live hole,
    // but the rule is worth a test at the boundary that receives the POST: a
    // field named like an identity must not become one.
    const fd = form()
    fd.set('callerId', '00000000-0000-4000-8000-0000000000ff')
    fd.set('attendeeId', '00000000-0000-4000-8000-0000000000ff')

    expect(await claimSeat({}, fd)).toEqual({})
    expect(claimOfferedSeat).toHaveBeenCalledWith({ id: CALLER_ID }, 'b-1')
  })

  it('repaints this booking and the list it appears on', async () => {
    // Asserted as the exact call list, the way joinTheWaitlist's and bookEvent's
    // tests assert theirs. A membership check would stay green if this action
    // also repainted '/' or the event page — neither of which it has any
    // business touching: claiming moves no public seat count, the hold that
    // reserved it did.
    await claimSeat({}, form())
    expect(revalidatePath.mock.calls.flat()).toEqual(['/bookings/VYRB4SHQ', '/bookings'])
  })

  it('refuses a reference that is not one', async () => {
    // Shape-checked because it is interpolated into a revalidate path, the
    // same rule the cancel actions follow for slugs and event ids. Asserted
    // against the query too: the guard has to come BEFORE the read, or a path
    // shape has already been handed to something.
    for (const bad of ['', 'short', 'VYRB4SHQX', 'vyrb4shq', '../../login', 'VYRB4SHI']) {
      vi.clearAllMocks()

      expect(await claimSeat({}, form(bad))).toEqual({ error: RELOAD_SENTENCE })
      expect(getBookingByReference).not.toHaveBeenCalled()
      expect(claimOfferedSeat).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    }
  })

  it('says nothing useful about a booking it cannot resolve', async () => {
    // "Does not exist" and "not yours to see" arrive here as the same null, and
    // leave as the same sentence — no oracle for which references are real.
    getBookingByReference.mockResolvedValue(null)

    expect(await claimSeat({}, form())).toEqual({ error: RELOAD_SENTENCE })
    expect(claimOfferedSeat).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('hands the service’s refusal back unchanged, and repaints nothing', async () => {
    // Nothing moved, so nothing is stale — and the refusal keeps the service's
    // own wording, one vocabulary per refusal.
    claimOfferedSeat.mockResolvedValue({ ok: false, error: 'That seat offer is not yours to claim.' })

    expect(await claimSeat({}, form())).toEqual({ error: 'That seat offer is not yours to claim.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
