import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam these actions have is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import type { BookingResult } from '@/lib/bookings/service'
import type { BookState } from '@/app/e/[slug]/actions'

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
 * for a visitor whose session was gone by the time they pressed Request.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/e/diwali-supper' }),
}))

/**
 * Identity is mocked at its source rather than supplied to the action, because
 * there is no way to supply it: `Caller` is branded and lib/bookings/caller.ts
 * is the only module that can mint one. Both actions read their fields out of
 * the form and who is asking is not one of them.
 */
let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

/**
 * The seam that would otherwise reach Postgres as the service role. Mocked so
 * these tests are about the actions' own input handling — the part a
 * handcrafted POST meets, where `required` and `maxLength` on the inputs count
 * for nothing — and not about request_booking or book_cash_tickets, which
 * Task 3 covers against the real database. bookFreeTickets is exported too
 * because actions.ts imports it; nothing in this file reaches it.
 */
const requestBooking = vi.fn<(...args: unknown[]) => Promise<BookingResult>>()
const bookCashTickets = vi.fn<(...args: unknown[]) => Promise<BookingResult>>()
vi.mock('@/lib/bookings/service', () => ({
  bookFreeTickets: vi.fn(),
  requestBooking: (...args: unknown[]) => requestBooking(...args),
  bookCashTickets: (...args: unknown[]) => bookCashTickets(...args),
}))

const { requestToJoin, bookCashEvent } = await import('@/app/e/[slug]/actions')

type FormAction = (previous: BookState, formData: FormData) => Promise<BookState>

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const TICKET_TYPE_ID = '00000000-0000-4000-8000-000000000099'

/**
 * The form the request panel submits, minus paymentMode and note — the two
 * optional fields whose absent case is itself under test. Tests that need
 * them set them explicitly. Pass `undefined` to leave a field out entirely.
 */
function form(overrides: Record<string, string | undefined> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string | undefined> = {
    ticketTypeId: TICKET_TYPE_ID,
    quantity: '2',
    attendeeName: 'Asha Verma',
    slug: 'diwali-supper',
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== undefined) fd.set(key, value)
  }
  return fd
}

/** Runs an action expecting a redirect, and returns where it went. */
async function captureRedirect(action: FormAction, fd: FormData): Promise<string> {
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
  requestBooking.mockResolvedValue({ ok: true, reference: 'RQ2VHBDE' })
  bookCashTickets.mockResolvedValue({ ok: true, reference: 'CD9SPK0K' })
})

describe('signed out', () => {
  it('requestToJoin redirects to login carrying the page the visitor was on', async () => {
    caller = null

    expect(await captureRedirect(requestToJoin, form())).toBe('/login?next=%2Fe%2Fdiwali-supper')
    expect(requestBooking).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('bookCashEvent redirects to login carrying the page the visitor was on', async () => {
    caller = null

    expect(await captureRedirect(bookCashEvent, form())).toBe('/login?next=%2Fe%2Fdiwali-supper')
    expect(bookCashTickets).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('checks the session before it looks at the form at all', async () => {
    // A signed-out visitor with a malformed form is sent to sign in, not told
    // to fix a field they cannot see. Every field is junk here and the answer
    // is still the login page — for both actions.
    caller = null
    const junk = () => form({ ticketTypeId: undefined, quantity: 'x', attendeeName: '  ' })

    expect(await captureRedirect(requestToJoin, junk())).toBe('/login?next=%2Fe%2Fdiwali-supper')
    expect(await captureRedirect(bookCashEvent, junk())).toBe('/login?next=%2Fe%2Fdiwali-supper')
  })
})

describe('input guards', () => {
  // These branches exist for the handcrafted POST. The panels cannot produce
  // any of them: ticketTypeId and slug are hidden inputs they write themselves,
  // the picker only offers 1..maxSeats, and the name input is `required` with
  // `maxLength={80}`. None of that survives a request built with curl, which
  // is the request these guards are written against.

  it.each([
    ['requestToJoin', requestToJoin, requestBooking],
    ['bookCashEvent', bookCashEvent, bookCashTickets],
  ] as const)('%s refuses a missing ticket type without calling the service', async (_name, action, service) => {
    const state = await action({}, form({ ticketTypeId: undefined }))

    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(service).not.toHaveBeenCalled()
  })

  it.each(['abc', '0'])('requestToJoin refuses quantity %o without calling the service', async (quantity) => {
    const state = await requestToJoin({}, form({ quantity }))

    expect(state).toEqual({ error: 'Choose how many seats you need.' })
    expect(requestBooking).not.toHaveBeenCalled()
  })

  it.each(['abc', '0'])('bookCashEvent refuses quantity %o without calling the service', async (quantity) => {
    const state = await bookCashEvent({}, form({ quantity }))

    expect(state).toEqual({ error: 'Choose how many seats you need.' })
    expect(bookCashTickets).not.toHaveBeenCalled()
  })

  it.each([
    ['requestToJoin', requestToJoin, requestBooking],
    ['bookCashEvent', bookCashEvent, bookCashTickets],
  ] as const)('%s refuses a blank attendee name without calling the service', async (_name, action, service) => {
    const state = await action({}, form({ attendeeName: '   ' }))

    expect(state).toEqual({ error: 'Tell the host who to expect.' })
    expect(service).not.toHaveBeenCalled()
  })
})

describe('requestToJoin, signed in', () => {
  it("requests under the caller's own identity, never a form field", async () => {
    // The form carries an attendeeId; the action must ignore it. There is no
    // parameter for it in requestBooking and no way to mint a Caller outside
    // lib/bookings/caller.ts, so this is belt and braces over a compile-time
    // guarantee — but it is the property the whole module exists for.
    const fd = form({ paymentMode: 'cash', note: 'Two of us, friends of Ravi.' })
    fd.set('attendeeId', '00000000-0000-4000-8000-00000000dead')

    await captureRedirect(requestToJoin, fd)

    expect(requestBooking).toHaveBeenCalledWith(
      { id: CALLER_ID },
      TICKET_TYPE_ID,
      2,
      'Asha Verma',
      'cash',
      'Two of us, friends of Ravi.',
    )
  })

  it("defaults the payment mode to 'online' when the field is absent", async () => {
    await captureRedirect(requestToJoin, form())

    expect(requestBooking).toHaveBeenCalledWith(
      { id: CALLER_ID },
      TICKET_TYPE_ID,
      2,
      'Asha Verma',
      'online',
      undefined,
    )
  })

  it.each(['CASH', 'upi', 'card', ''])(
    "parses paymentMode %o as 'online' — a handcrafted POST cannot invent a third mode",
    async (paymentMode) => {
      await captureRedirect(requestToJoin, form({ paymentMode }))

      expect(requestBooking).toHaveBeenCalledWith(
        expect.anything(),
        TICKET_TYPE_ID,
        2,
        'Asha Verma',
        'online',
        undefined,
      )
    },
  )

  it('trims the name and caps it at 80 characters', async () => {
    // The cap is applied after trimming, so leading whitespace does not eat
    // into the 80 a host will actually read. maxLength on the input enforces
    // the same number for anyone using the page; this is the half that holds
    // for anyone not.
    await captureRedirect(requestToJoin, form({ attendeeName: `   ${'a'.repeat(100)}   ` }))

    expect(requestBooking).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      2,
      'a'.repeat(80),
      'online',
      undefined,
    )
  })

  it('trims the note and caps it at 280 characters', async () => {
    await captureRedirect(requestToJoin, form({ note: `   ${'n'.repeat(300)}   ` }))

    expect(requestBooking).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      2,
      'Asha Verma',
      'online',
      'n'.repeat(280),
    )
  })

  it.each(['', '   ', '\t\n'])('sends a blank note %o as undefined, not as an empty string', async (note) => {
    await captureRedirect(requestToJoin, form({ note }))

    expect(requestBooking).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      2,
      'Asha Verma',
      'online',
      undefined,
    )
  })

  it("returns the service's own refusal rather than a message of its own, without redirecting", async () => {
    requestBooking.mockResolvedValue({
      ok: false,
      error: 'You have already booked this event. Cancel that booking first to change it.',
    })

    const state = await requestToJoin({}, form())

    expect(state).toEqual({
      error: 'You have already booked this event. Cancel that booking first to change it.',
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('redirects to the booking and revalidates nothing — a request moves no inventory', async () => {
    // Unlike bookEvent and bookCashEvent: neither the event page's seats-left
    // count nor the feed's payload changed, so there is nothing stale to drop.
    expect(await captureRedirect(requestToJoin, form())).toBe('/bookings/RQ2VHBDE')
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('bookCashEvent, signed in', () => {
  it("books under the caller's own identity, never a form field", async () => {
    const fd = form()
    fd.set('attendeeId', '00000000-0000-4000-8000-00000000dead')

    await captureRedirect(bookCashEvent, fd)

    expect(bookCashTickets).toHaveBeenCalledWith(
      { id: CALLER_ID },
      TICKET_TYPE_ID,
      2,
      'Asha Verma',
    )
  })

  it('trims the name and caps it at 80 characters', async () => {
    await captureRedirect(bookCashEvent, form({ attendeeName: `   ${'a'.repeat(100)}   ` }))

    expect(bookCashTickets).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      2,
      'a'.repeat(80),
    )
  })

  it("returns the service's own refusal rather than a message of its own, without redirecting", async () => {
    bookCashTickets.mockResolvedValue({ ok: false, error: 'This event has already started.' })

    const state = await bookCashEvent({}, form())

    expect(state).toEqual({ error: 'This event has already started.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('revalidates the event page and the feed, then redirects to the booking', async () => {
    // revalidatePath before redirect, because redirect() throws — the same
    // pair, in the same order, as bookEvent: a cash booking reserves and
    // confirms, so the reserved_count in both payloads just moved.
    expect(await captureRedirect(bookCashEvent, form())).toBe('/bookings/CD9SPK0K')
    expect(revalidatePath.mock.calls.flat()).toEqual(['/e/diwali-supper', '/'])
  })

  it('still redirects and still revalidates the feed when the slug is missing', async () => {
    expect(await captureRedirect(bookCashEvent, form({ slug: undefined }))).toBe('/bookings/CD9SPK0K')
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/')
  })

  it('does not revalidate an empty slug into the feed', async () => {
    // `/e/${''}` is `/e/`, which is not this route and not nothing either. The
    // falsiness check is what keeps a blank hidden input from naming a path.
    await captureRedirect(bookCashEvent, form({ slug: '' }))

    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/')
  })
})
