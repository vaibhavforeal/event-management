import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import type { CheckoutStart } from '@/lib/payments/service'

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
 * A Server Action posts to the URL of the page the form is on, so proxy.ts
 * leaves that page's path here — which is what loginPath() turns into `?next=`
 * for a visitor whose session was gone by the time they pressed Pay.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/e/diwali-supper-club' }),
}))

/**
 * Identity is mocked at its source rather than supplied to the action, because
 * there is no way to supply it: `Caller` is branded and lib/bookings/caller.ts
 * is the only module that can mint one. The action reads four things out of
 * the form and who is paying is not one of them.
 */
let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

/**
 * The seam that would otherwise reach Razorpay and Postgres as the service
 * role. Mocked so these tests are about the action's own input handling — the
 * part a handcrafted POST meets, where `required` and `maxLength` on the
 * inputs count for nothing — and not about begin_paid_booking, which Task 5
 * covers against the real database.
 */
const startPaidCheckoutService = vi.fn<(...args: unknown[]) => Promise<CheckoutStart>>()
vi.mock('@/lib/payments/service', () => ({
  startPaidCheckout: (...args: unknown[]) => startPaidCheckoutService(...args),
}))

const { startPaidCheckout } = await import('@/app/e/[slug]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const TICKET_TYPE_ID = '11111111-2222-4333-8444-555555555555'

/** The form the paid panel submits. Pass `undefined` to leave a field out entirely. */
function form(overrides: Record<string, string | undefined> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string | undefined> = {
    ticketTypeId: TICKET_TYPE_ID,
    quantity: '2',
    attendeeName: 'Asha',
    slug: 'diwali-supper-club',
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== undefined) fd.set(key, value)
  }
  return fd
}

/** Runs the action expecting a redirect, and returns where it went. */
async function captureRedirect(fd: FormData): Promise<string> {
  try {
    await startPaidCheckout({}, fd)
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to
    throw error
  }
  throw new Error('Expected a redirect, but the action returned normally')
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as Caller
  startPaidCheckoutService.mockResolvedValue({ ok: true, reference: 'G09SPK0K' })
})

describe('startPaidCheckout (form action), signed out', () => {
  it('redirects to login carrying the page the visitor was on', async () => {
    caller = null
    expect(await captureRedirect(form())).toBe('/login?next=%2Fe%2Fdiwali-supper-club')
    expect(startPaidCheckoutService).not.toHaveBeenCalled()
  })
})

describe('startPaidCheckout (form action) input guards', () => {
  // The paid twin of bookEvent's guards, character for character: the two
  // actions must refuse the same mistake with the same sentence, or the paid
  // path leaks a different vocabulary for identical mistakes.

  it('refuses a missing ticket type without calling the service', async () => {
    const state = await startPaidCheckout({}, form({ ticketTypeId: undefined }))

    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(startPaidCheckoutService).not.toHaveBeenCalled()
  })

  it('refuses a garbled quantity before touching the service', async () => {
    const state = await startPaidCheckout({}, form({ quantity: 'lots' }))

    expect(state).toEqual({ error: 'Choose how many seats you need.' })
    expect(startPaidCheckoutService).not.toHaveBeenCalled()
  })

  it.each(['', '1.5', '0', '-1'])(
    'refuses quantity %o without calling the service',
    async (quantity) => {
      const state = await startPaidCheckout({}, form({ quantity }))

      expect(state).toEqual({ error: 'Choose how many seats you need.' })
      expect(startPaidCheckoutService).not.toHaveBeenCalled()
    },
  )

  it('requires a name for the host', async () => {
    const state = await startPaidCheckout({}, form({ attendeeName: '   ' }))

    expect(state).toEqual({ error: 'Tell the host who to expect.' })
    expect(startPaidCheckoutService).not.toHaveBeenCalled()
  })

  it('trims the name and caps it at 80 characters', async () => {
    await captureRedirect(form({ attendeeName: `   ${'a'.repeat(100)}   ` }))

    expect(startPaidCheckoutService).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      2,
      'a'.repeat(80),
    )
  })
})

describe('startPaidCheckout (form action), signed in', () => {
  it('redirects to the checkout home with the reference', async () => {
    expect(await captureRedirect(form())).toBe('/bookings/G09SPK0K')
    expect(startPaidCheckoutService).toHaveBeenCalledWith(
      { id: CALLER_ID },
      TICKET_TYPE_ID,
      2,
      'Asha',
    )
  })

  it('revalidates the event page and the feed, then redirects to the booking', async () => {
    // revalidatePath before redirect, because redirect() throws — the same
    // pair, in the same order, as bookEvent: the seats-left count this hold
    // just moved lives in both payloads.
    expect(await captureRedirect(form())).toBe('/bookings/G09SPK0K')
    expect(revalidatePath.mock.calls.flat()).toEqual(['/e/diwali-supper-club', '/'])
  })

  it('still redirects and still revalidates the feed when the slug is missing', async () => {
    expect(await captureRedirect(form({ slug: undefined }))).toBe('/bookings/G09SPK0K')
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/')
  })

  it('returns the service sentence on refusal', async () => {
    startPaidCheckoutService.mockResolvedValue({
      ok: false,
      error: 'This event has already started.',
    })

    const state = await startPaidCheckout({}, form())

    expect(state).toEqual({ error: 'This event has already started.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
