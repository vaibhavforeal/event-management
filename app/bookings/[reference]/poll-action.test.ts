import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

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
 * leaves that page's path here — the booking page whose panel is polling.
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
 * signature verification and reconciliation belong to Task 9's suite; what is
 * tested here is what a handcrafted invocation of this endpoint can make the
 * action do — which inputs reach the service, and which never leave the guard.
 */
vi.mock('@/lib/payments/service', () => ({
  reconcileAfterCheckout: vi.fn(),
  reconcileBooking: vi.fn(),
}))
vi.mock('@/lib/bookings/queries', () => ({ getBookingByReference: vi.fn() }))

const { reconcileAfterCheckout } = vi.mocked(await import('@/lib/payments/service'))
const { getBookingByReference } = vi.mocked(await import('@/lib/bookings/queries'))
const { pollBookingStatus } = await import('@/app/bookings/[reference]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'

const AWAITING = { id: 'b-1', status: 'awaiting_payment' }
const CONFIRMED = { id: 'b-1', status: 'confirmed' }

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as Caller
})

describe('pollBookingStatus, signed out', () => {
  it('redirects to login before reading anything', async () => {
    // The session expiring while the sheet sat open is the ordinary way here.
    caller = null

    await expect(pollBookingStatus('G09SPK0K')).rejects.toBeInstanceOf(RedirectSignal)
    await expect(pollBookingStatus('G09SPK0K')).rejects.toMatchObject({
      to: '/login?next=%2Fbookings%2FG09SPK0K',
    })
    expect(getBookingByReference).not.toHaveBeenCalled()
    expect(reconcileAfterCheckout).not.toHaveBeenCalled()
  })
})

describe('pollBookingStatus', () => {
  it('is a plain read without a checkout attempt', async () => {
    getBookingByReference.mockResolvedValue(AWAITING as never)
    await expect(pollBookingStatus('G09SPK0K')).resolves.toEqual({ status: 'awaiting_payment' })
    expect(reconcileAfterCheckout).not.toHaveBeenCalled()
  })

  it('hands a first-poll checkout attempt to the service, then re-reads', async () => {
    getBookingByReference.mockResolvedValueOnce(AWAITING as never).mockResolvedValueOnce(CONFIRMED as never)
    const result = await pollBookingStatus('G09SPK0K', { paymentId: 'pay_1', signature: 'sig' })
    expect(reconcileAfterCheckout).toHaveBeenCalledWith('b-1', { paymentId: 'pay_1', signature: 'sig' })
    expect(result).toEqual({ status: 'confirmed' })
  })

  it('shrugs at a malformed reference without touching the database', async () => {
    await expect(pollBookingStatus('../etc')).resolves.toEqual({ status: 'unknown' })
    expect(getBookingByReference).not.toHaveBeenCalled()
  })

  it('answers unknown for a reference that resolves to nothing', async () => {
    getBookingByReference.mockResolvedValue(null)
    await expect(pollBookingStatus('AAAAAAAA')).resolves.toEqual({ status: 'unknown' })
  })

  it('ignores a checkout attempt on a booking that is not awaiting payment', async () => {
    getBookingByReference.mockResolvedValue(CONFIRMED as never)
    await expect(pollBookingStatus('G09SPK0K', { paymentId: 'pay_1', signature: 'sig' })).resolves.toEqual({ status: 'confirmed' })
    expect(reconcileAfterCheckout).not.toHaveBeenCalled()
  })

  it('ignores a checkout attempt whose payment id is not payment-id-shaped', async () => {
    // The id is forwarded to a provider API by the service; only pay_… shapes
    // have any business leaving this action. The poll still answers.
    getBookingByReference.mockResolvedValue(AWAITING as never)
    const result = await pollBookingStatus('G09SPK0K', { paymentId: '../pay', signature: 'sig' })
    expect(result).toEqual({ status: 'awaiting_payment' })
    expect(reconcileAfterCheckout).not.toHaveBeenCalled()
  })
})
