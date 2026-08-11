import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

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
 * leaves that page's path here — the booking page whose panel carries the Pay
 * button.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/bookings/G09SPK0K' }),
}))

/**
 * Identity is mocked at its source rather than supplied to the action, because
 * there is no way to supply it: `Caller` is branded and lib/bookings/caller.ts
 * is the only module that can mint one.
 */
let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

/**
 * The seams that would otherwise reach Razorpay and Postgres. Mocked because
 * the authorisation this action leans on is not the action's: whether the
 * caller IS the attendee, and whether the booking is an approved unpaid one,
 * belongs to beginApprovedCheckout against the real database in Task 5's
 * suite. What is tested here is what a handcrafted POST to this endpoint can
 * make the action do — which inputs reach the service, and which never leave
 * the guard.
 */
vi.mock('@/lib/payments/service', () => ({
  beginApprovedCheckout: vi.fn(),
  reconcileAfterCheckout: vi.fn(),
  reconcileBooking: vi.fn(),
}))
vi.mock('@/lib/bookings/queries', () => ({ getBookingByReference: vi.fn() }))

const { beginApprovedCheckout } = vi.mocked(await import('@/lib/payments/service'))
const { getBookingByReference } = vi.mocked(await import('@/lib/bookings/queries'))
const { startApprovedPayment } = await import('@/app/bookings/[reference]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const RELOAD_SENTENCE = 'Something went wrong. Reload the page and try again.'

const APPROVED = { id: 'b-1', status: 'awaiting_payment' }

/** The form the approved-pay panel submits: one hidden reference field. */
function form(reference = 'G09SPK0K'): FormData {
  const fd = new FormData()
  fd.set('reference', reference)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as Caller
  beginApprovedCheckout.mockResolvedValue({ ok: true })
})

describe('startApprovedPayment, signed out', () => {
  it('redirects to login before reading anything', async () => {
    // The session expiring inside the 24-hour window, with the page still
    // open, is the ordinary way to get here.
    caller = null

    await expect(startApprovedPayment({}, form())).rejects.toBeInstanceOf(RedirectSignal)
    await expect(startApprovedPayment({}, form())).rejects.toMatchObject({
      to: '/login?next=%2Fbookings%2FG09SPK0K',
    })
    expect(getBookingByReference).not.toHaveBeenCalled()
    expect(beginApprovedCheckout).not.toHaveBeenCalled()
  })
})

describe('startApprovedPayment input guards', () => {
  it('refuses a malformed reference without touching the database', async () => {
    // Path shapes, the wrong case, the wrong length: the hidden input is
    // whatever the request says it is, and only reference-shaped strings have
    // any business reaching a query.
    for (const reference of ['../../etc', 'g09spk0k', 'G09SPK0']) {
      vi.clearAllMocks()

      const state = await startApprovedPayment({}, form(reference))

      expect(state).toEqual({ error: RELOAD_SENTENCE })
      expect(getBookingByReference).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    }
  })

  it('answers the same sentence for a reference that resolves to nothing', async () => {
    // "Does not exist" and "not yours to see" arrive here as the same null,
    // and leave as the same sentence — no oracle for which references are real.
    getBookingByReference.mockResolvedValue(null)

    const state = await startApprovedPayment({}, form('AAAAAAAA'))

    expect(state).toEqual({ error: RELOAD_SENTENCE })
    expect(beginApprovedCheckout).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('startApprovedPayment, signed in', () => {
  it('starts the checkout and revalidates the booking page', async () => {
    getBookingByReference.mockResolvedValue(APPROVED as never)

    const state = await startApprovedPayment({}, form())

    expect(beginApprovedCheckout).toHaveBeenCalledWith({ id: CALLER_ID }, 'b-1')
    expect(revalidatePath).toHaveBeenCalledWith('/bookings/G09SPK0K')
    expect(state).toEqual({})
  })

  it("surfaces the service's refusal and revalidates nothing", async () => {
    // Nothing moved, so nothing is stale — and the refusal keeps the service's
    // own wording, one vocabulary per refusal.
    getBookingByReference.mockResolvedValue(APPROVED as never)
    beginApprovedCheckout.mockResolvedValue({
      ok: false,
      error: 'There is nothing to pay on this booking right now.',
    })

    const state = await startApprovedPayment({}, form())

    expect(state).toEqual({ error: 'There is nothing to pay on this booking right now.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
