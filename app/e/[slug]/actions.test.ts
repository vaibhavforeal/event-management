import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import type { BookingResult } from '@/lib/bookings/service'

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
 * for a visitor whose session was gone by the time they pressed Book.
 */
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/e/diwali-supper' }),
}))

/**
 * Identity is mocked at its source rather than supplied to the action, because
 * there is no way to supply it: `Caller` is branded and lib/bookings/caller.ts
 * is the only module that can mint one. That is the property under test in
 * `books under the caller's own identity` below — the action reads four things
 * out of the form and who is booking is not one of them.
 */
let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

/**
 * The seam that would otherwise reach Postgres as the service role. Mocked so
 * these tests are about the action's own input handling — the part a
 * handcrafted POST meets, where `required` and `maxLength` on the inputs count
 * for nothing — and not about book_free_tickets, which Task 1 covers against
 * the real database.
 */
const bookFreeTickets = vi.fn<(...args: unknown[]) => Promise<BookingResult>>()
vi.mock('@/lib/bookings/service', () => ({
  bookFreeTickets: (...args: unknown[]) => bookFreeTickets(...args),
}))

const { bookEvent } = await import('@/app/e/[slug]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const TICKET_TYPE_ID = '00000000-0000-4000-8000-000000000099'

/** The form the panel submits. Pass `undefined` to leave a field out entirely. */
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

/** Runs the action expecting a redirect, and returns where it went. */
async function captureRedirect(fd: FormData): Promise<string> {
  try {
    await bookEvent({}, fd)
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to
    throw error
  }
  throw new Error('Expected a redirect, but the action returned normally')
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as Caller
  bookFreeTickets.mockResolvedValue({ ok: true, reference: 'S2CVHBDE' })
})

describe('bookEvent, signed out', () => {
  it('redirects to login carrying the page the visitor was on', async () => {
    caller = null
    expect(await captureRedirect(form())).toBe('/login?next=%2Fe%2Fdiwali-supper')
    expect(bookFreeTickets).not.toHaveBeenCalled()
  })

  it('checks the session before it looks at the form at all', async () => {
    // The order matters: a signed-out visitor with a malformed form is sent to
    // sign in, not told to fix a field they cannot see. Every field is junk here
    // and the answer is still the login page.
    caller = null
    const junk = form({ ticketTypeId: undefined, quantity: 'x', attendeeName: '  ' })
    expect(await captureRedirect(junk)).toBe('/login?next=%2Fe%2Fdiwali-supper')
  })
})

describe('bookEvent input guards', () => {
  // These three branches exist for the handcrafted POST. The panel cannot
  // produce any of them: ticketTypeId and slug are hidden inputs it writes
  // itself, the picker only offers 1..maxSeats, and the name input is
  // `required` with `maxLength={80}`. None of that survives a request built
  // with curl, which is the request these guards are written against.

  it('refuses a missing ticket type without calling the service', async () => {
    const state = await bookEvent({}, form({ ticketTypeId: undefined }))

    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(bookFreeTickets).not.toHaveBeenCalled()
  })

  it('refuses an empty ticket type, not just an absent one', async () => {
    // `String(null)` is "null" and `String(undefined)` is "undefined", so the
    // guard has to test the coerced string rather than the FormData entry —
    // which is why it reads `?? ''` and then checks for falsiness.
    const state = await bookEvent({}, form({ ticketTypeId: '' }))

    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(bookFreeTickets).not.toHaveBeenCalled()
  })

  it.each(['abc', '', '1.5', '0', '-1', 'NaN', 'Infinity', '1e400', ' '])(
    'refuses quantity %o without calling the service',
    async (quantity) => {
      const state = await bookEvent({}, form({ quantity }))

      expect(state).toEqual({ error: 'Choose how many seats you need.' })
      expect(bookFreeTickets).not.toHaveBeenCalled()
    },
  )

  it('refuses a missing quantity', async () => {
    // Number(null) is 0, which is an integer — so the `< 1` half of the guard is
    // what catches this one, not the Number.isInteger half. Both halves are
    // load-bearing.
    const state = await bookEvent({}, form({ quantity: undefined }))

    expect(state).toEqual({ error: 'Choose how many seats you need.' })
    expect(bookFreeTickets).not.toHaveBeenCalled()
  })

  it.each(['', '   ', '\t\n', undefined])(
    'refuses attendee name %o without calling the service',
    async (attendeeName) => {
      const state = await bookEvent({}, form({ attendeeName }))

      expect(state).toEqual({ error: 'Tell the host who to expect.' })
      expect(bookFreeTickets).not.toHaveBeenCalled()
    },
  )

  it('does not let an over-large quantity through on its own', async () => {
    // Deliberately NOT refused here. reserve_tickets owns the real cap and
    // answers "cannot book more than N per order" — it checks max_per_order
    // before availability, so this is the message a 999 gets, not "only N seats
    // remain". Duplicating that bound in the action would mean two places to
    // get it wrong, and the action does not know the ticket type's cap anyway.
    await captureRedirect(form({ quantity: '999' }))

    expect(bookFreeTickets).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      999,
      'Asha Verma',
    )
  })
})

describe('bookEvent, signed in', () => {
  it('books under the caller\'s own identity, never a form field', async () => {
    // The form carries an attendeeId; the action must ignore it. There is no
    // parameter for it in bookFreeTickets and no way to mint a Caller outside
    // lib/bookings/caller.ts, so this is belt and braces over a compile-time
    // guarantee — but it is the property the whole module exists for.
    const fd = form()
    fd.set('attendeeId', '00000000-0000-4000-8000-00000000dead')

    await captureRedirect(fd)

    expect(bookFreeTickets).toHaveBeenCalledWith(
      { id: CALLER_ID },
      TICKET_TYPE_ID,
      2,
      'Asha Verma',
    )
  })

  it('trims the name and caps it at 80 characters', async () => {
    // The cap is applied after trimming, so leading whitespace does not eat
    // into the 80 a host will actually read. maxLength on the input enforces
    // the same number for anyone using the page; this is the half that holds
    // for anyone not.
    await captureRedirect(form({ attendeeName: `   ${'a'.repeat(100)}   ` }))

    expect(bookFreeTickets).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      2,
      'a'.repeat(80),
    )
  })

  it('passes a name that needs neither trimming nor capping through untouched', async () => {
    // So the assertion above cannot pass because the action mangles every name.
    await captureRedirect(form({ attendeeName: 'Ravi Krishnan' }))

    expect(bookFreeTickets).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_TYPE_ID,
      2,
      'Ravi Krishnan',
    )
  })

  it('revalidates the event page and redirects to the booking', async () => {
    // revalidatePath before redirect, because redirect() throws: the seats-left
    // count on the page behind the visitor has just moved, and a call placed
    // after the redirect would never run.
    expect(await captureRedirect(form())).toBe('/bookings/S2CVHBDE')
    expect(revalidatePath).toHaveBeenCalledWith('/e/diwali-supper')
  })

  it('still redirects when the slug is missing, without revalidating', async () => {
    // The slug is only there to name a path to revalidate. Losing it should cost
    // a stale seat count, not the booking the visitor just made.
    expect(await captureRedirect(form({ slug: undefined }))).toBe('/bookings/S2CVHBDE')
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('returns the service\'s own refusal rather than a message of its own', async () => {
    // EH010 through EH013 are translated once, in lib/bookings/rpc-errors.ts.
    // The action re-wording them here would mean two vocabularies for the same
    // refusals, and the panel prints whatever it is given.
    bookFreeTickets.mockResolvedValue({
      ok: false,
      error: 'You have already booked this event. Cancel that booking first to change it.',
    })

    const state = await bookEvent({}, form())

    expect(state).toEqual({
      error: 'You have already booked this event. Cancel that booking first to change it.',
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
