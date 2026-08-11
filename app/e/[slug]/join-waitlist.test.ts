import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: runs dotenv so lib/env.ts can validate when the action's
// import chain pulls in the Supabase client.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))

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
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/e/test-event' }),
}))

let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

vi.mock('@/lib/bookings/service', () => ({
  joinWaitlist: vi.fn(),
  bookFreeTickets: vi.fn(),
  bookCashTickets: vi.fn(),
  requestBooking: vi.fn(),
}))
vi.mock('@/lib/payments/service', () => ({ startPaidCheckout: vi.fn() }))

const { joinWaitlist } = vi.mocked(await import('@/lib/bookings/service'))
const { joinTheWaitlist } = await import('@/app/e/[slug]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const RELOAD_SENTENCE = 'Something went wrong. Reload the page and try again.'

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.set('ticketTypeId', 'tt-1')
  fd.set('slug', 'test-event')
  fd.set('quantity', '2')
  fd.set('attendeeName', 'Asha')
  fd.set('paymentMode', 'online')
  for (const [key, value] of Object.entries(overrides)) fd.set(key, value)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as unknown as Caller
  joinWaitlist.mockResolvedValue({ ok: true, reference: 'VYRB4SHQ' })
})

describe('joinTheWaitlist', () => {
  it('sends the caller to sign in rather than joining as nobody', async () => {
    caller = null
    await expect(joinTheWaitlist({}, form())).rejects.toBeInstanceOf(RedirectSignal)
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it('joins as the caller and lands on the new entry', async () => {
    await expect(joinTheWaitlist({}, form())).rejects.toMatchObject({ to: '/bookings/VYRB4SHQ' })
    expect(joinWaitlist).toHaveBeenCalledWith(
      { id: CALLER_ID },
      'tt-1',
      2,
      'Asha',
      'online',
    )
  })

  it('repaints the event page, whose line just got longer', async () => {
    // Joining moves no inventory, so unlike bookEvent there is no feed number
    // to correct — but this page prints "N people waiting" and gates its whole
    // bottom bar on that number, so it must not be served stale.
    await expect(joinTheWaitlist({}, form())).rejects.toBeInstanceOf(RedirectSignal)
    expect(revalidatePath).toHaveBeenCalledWith('/e/test-event')
  })

  it('refuses a quantity that is not a whole number of seats', async () => {
    for (const bad of ['0', '-1', 'two', '1.5', '']) {
      expect(await joinTheWaitlist({}, form({ quantity: bad }))).toEqual({
        error: 'Choose how many seats you need.',
      })
    }
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it('insists on a name for the door list', async () => {
    expect(await joinTheWaitlist({}, form({ attendeeName: '   ' }))).toEqual({
      error: 'Tell the host who to expect.',
    })
  })

  it('caps the name at 80 characters, as the input does and a POST does not', async () => {
    await expect(joinTheWaitlist({}, form({ attendeeName: 'a'.repeat(200) }))).rejects.toBeInstanceOf(
      RedirectSignal,
    )
    expect(joinWaitlist).toHaveBeenCalledWith({ id: CALLER_ID }, 'tt-1', 2, 'a'.repeat(80), 'online')
  })

  it('knows only two payment modes, whatever the form says', async () => {
    await expect(joinTheWaitlist({}, form({ paymentMode: 'barter' }))).rejects.toBeInstanceOf(
      RedirectSignal,
    )
    expect(joinWaitlist).toHaveBeenCalledWith({ id: CALLER_ID }, 'tt-1', 2, 'Asha', 'online')
  })

  it('stops without a ticket type', async () => {
    const fd = form()
    fd.delete('ticketTypeId')
    expect(await joinTheWaitlist({}, fd)).toEqual({ error: RELOAD_SENTENCE })
  })

  it('hands the service’s refusal back as it is', async () => {
    joinWaitlist.mockResolvedValue({ ok: false, error: 'Seats are open — book instead of joining the waitlist.' })
    expect(await joinTheWaitlist({}, form())).toEqual({
      error: 'Seats are open — book instead of joining the waitlist.',
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
