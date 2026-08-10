import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: this module runs dotenv at load, and lib/env.ts validates
// the client env when @/lib/auth/session pulls in the Supabase client below.
// Nothing here touches the database — every seam this action has is mocked.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import type { CancelResult } from '@/lib/bookings/service'

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
 * cancelBooking owns "may this caller cancel this booking", against the real
 * database, in Task 3's suite — including the host half of mayCancel that this
 * page relies on. What is tested here is the half that suite cannot see: what a
 * handcrafted POST to this endpoint can make the action do before it gets
 * there, and whether it gets there at all.
 */
const cancelBooking = vi.fn<(...args: unknown[]) => Promise<CancelResult>>()
vi.mock('@/lib/bookings/service', () => ({
  cancelBooking: (...args: unknown[]) => cancelBooking(...args),
}))

const { cancelAttendeeBooking } = await import('@/app/host/events/[id]/attendees/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const BOOKING_ID = '00000000-0000-4000-8000-000000000042'
const ATTENDEES_PATH = `/host/events/${EVENT_ID}/attendees`
const EVENT_PATH = '/e/diwali-supper'

/** The form the cancel button submits. Pass `undefined` to leave a field out. */
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

/** Runs the action expecting a redirect, and returns where it went. */
async function captureRedirect(fd: FormData): Promise<string> {
  try {
    await cancelAttendeeBooking({}, fd)
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to
    throw error
  }
  throw new Error('Expected a redirect, but the action returned normally')
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as Caller
  cancelBooking.mockResolvedValue({ ok: true })
})

describe('cancelAttendeeBooking, signed out', () => {
  it('redirects to login carrying the guest list the host was on', async () => {
    // The session expiring while the guest list sat open is the ordinary way to
    // reach this, and the `?next=` is what puts the host back on the same
    // event's list afterwards rather than on the feed.
    caller = null

    expect(await captureRedirect(form())).toBe(
      `/login?next=${encodeURIComponent(ATTENDEES_PATH)}`,
    )
    expect(cancelBooking).not.toHaveBeenCalled()
  })

  it('checks the session before it looks at the form at all', async () => {
    // A signed-out visitor with a malformed form is sent to sign in, not told to
    // fix a field they cannot see.
    caller = null

    const junk = form({ bookingId: undefined, eventId: undefined, slug: undefined })
    expect(await captureRedirect(junk)).toBe(
      `/login?next=${encodeURIComponent(ATTENDEES_PATH)}`,
    )
    expect(cancelBooking).not.toHaveBeenCalled()
  })
})

describe('cancelAttendeeBooking input guards', () => {
  // Both branches exist for the handcrafted POST. The button cannot produce
  // either: bookingId is a hidden input the page writes itself from a row it
  // just rendered. None of that survives a request built with curl, which is
  // the request these guards are written against.

  it('refuses a missing booking id without calling the service', async () => {
    const state = await cancelAttendeeBooking({}, form({ bookingId: undefined }))

    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(cancelBooking).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('refuses an empty booking id, not just an absent one', async () => {
    // `String(null)` is "null" and `String(undefined)` is "undefined", so the
    // guard has to test the coerced string rather than the FormData entry —
    // which is why it reads `?? ''` and then checks for falsiness.
    const state = await cancelAttendeeBooking({}, form({ bookingId: '' }))

    expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
    expect(cancelBooking).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('does not validate the id past emptiness', async () => {
    // Deliberately NOT refused here. A syntactically valid uuid that belongs to
    // somebody else's event and a string that is no uuid at all must arrive at
    // the same refusal, and cancelBooking is where that single sentence lives.
    // An early "that is not a booking id" here would tell a stranger which ids
    // are real, which is the oracle lib/bookings/service.ts is written to deny.
    cancelBooking.mockResolvedValue({ ok: false, error: 'That booking is not yours to cancel.' })

    const state = await cancelAttendeeBooking({}, form({ bookingId: 'not-a-uuid' }))

    expect(state).toEqual({ error: 'That booking is not yours to cancel.' })
    expect(cancelBooking).toHaveBeenCalledWith({ id: CALLER_ID }, 'not-a-uuid', 'host')
  })
})

describe('cancelAttendeeBooking, signed in', () => {
  it("cancels under the caller's own identity, never a form field", async () => {
    // The form carries an attendeeId; the action must ignore it. There is no
    // parameter for it in cancelBooking and no way to mint a Caller outside
    // lib/bookings/caller.ts, so this is belt and braces over a compile-time
    // guarantee — but it is the property the whole module exists for.
    const fd = form()
    fd.set('attendeeId', '00000000-0000-4000-8000-00000000dead')

    await cancelAttendeeBooking({}, fd)

    expect(cancelBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID, 'host')
  })

  it('never passes the form\'s eventId into the authorisation decision', async () => {
    // The whole risk this page adds over the attendee's own cancel: a host is
    // entitled here only because they host *this* event, and eventId arrives in
    // a hidden input. Naming somebody else's event must not widen what can be
    // cancelled, so cancelBooking is called with three arguments and eventId is
    // not among them — it only ever names a path to revalidate.
    const other = '00000000-0000-4000-8000-0000000000e2'

    await cancelAttendeeBooking({}, form({ eventId: other }))

    expect(cancelBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID, 'host')
    expect(revalidatePath).toHaveBeenCalledWith(`/host/events/${other}/attendees`)
  })

  it('does not let the form\'s slug decide anything either', async () => {
    // Same property as above for the other field the form carries. A slug
    // naming somebody else's event costs one wasted revalidation and nothing
    // more — the booking cancelled is still the one `bookingId` named, checked
    // against the caller by cancelBooking.
    await cancelAttendeeBooking({}, form({ slug: 'somebody-elses-event' }))

    expect(cancelBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID, 'host')
    expect(revalidatePath).toHaveBeenCalledWith('/e/somebody-elses-event')
  })

  it("marks the cancellation as the host's, not the attendee's", async () => {
    // The initiator decides two things in the service: the prose written to
    // bookings.cancellation_reason ('cancelled by host' — the only thing
    // separating "I changed my mind" from "the host removed me" after the
    // fact), and the refund rule (a host removal refunds in full, cutoff or
    // no). The attendee's own action passes 'attendee'.
    await cancelAttendeeBooking({}, form())

    expect(cancelBooking).toHaveBeenCalledWith(expect.anything(), BOOKING_ID, 'host')
  })

  it('revalidates the guest list, the event page and the feed, and returns a clear state', async () => {
    // All three, because all three payloads are now stale: the row has left the
    // guest list and the seat total above it has moved, the public page's
    // seats-left count has gone back up, and the feed carries the same
    // reserved_count even though its card does not paint one. The attendee's
    // own cancel revalidates the same three for the same reason. The empty
    // object is what clears an error left over from a previous submit of the
    // same form.
    const state = await cancelAttendeeBooking({}, form())

    expect(state).toEqual({})
    expect(revalidatePath.mock.calls.flat()).toEqual([ATTENDEES_PATH, EVENT_PATH, '/'])
  })

  it('still cancels, and still frees the seat on the public page, without the event id', async () => {
    // The eventId is only there to name one of the three paths. Losing it
    // should cost a stale guest list, not the cancellation the host asked for
    // and not the other two revalidations.
    const state = await cancelAttendeeBooking({}, form({ eventId: undefined }))

    expect(state).toEqual({})
    expect(cancelBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID, 'host')
    expect(revalidatePath.mock.calls.flat()).toEqual([EVENT_PATH, '/'])
  })

  it('does not revalidate an empty event id into some other route', async () => {
    // `/host/events/${''}/attendees` is `/host/events//attendees`, which is not
    // this route and not nothing either. The falsiness check is what keeps a
    // blank hidden input from naming a path.
    await cancelAttendeeBooking({}, form({ eventId: '' }))

    expect(revalidatePath.mock.calls.flat()).toEqual([EVENT_PATH, '/'])
  })

  it('still revalidates the guest list and the feed when the slug is missing', async () => {
    // Mirror of the case above. A booking whose event embed came back null has
    // no slug; losing it should cost a stale seats-left count on the public
    // page, not a stale guest list — and not a stale feed either, whose path is
    // a constant and needs no field.
    const state = await cancelAttendeeBooking({}, form({ slug: undefined }))

    expect(state).toEqual({})
    expect(revalidatePath.mock.calls.flat()).toEqual([ATTENDEES_PATH, '/'])
  })

  it('does not revalidate an empty slug into the event route', async () => {
    // `/e/${''}` is `/e/`, which is not this route and not nothing either.
    await cancelAttendeeBooking({}, form({ slug: '' }))

    expect(revalidatePath.mock.calls.flat()).toEqual([ATTENDEES_PATH, '/'])
  })

  it('does not let a slug that is not slug-shaped name the path', async () => {
    // Same guard as the attendee's own cancel. Falsiness alone let `../../host`
    // and `x%2fy` through — no write and nothing exposed either way, since
    // revalidatePath only drops cache entries, but a hidden input was choosing
    // the path. isEventSlug owns the real shape; the cases are in
    // lib/events/slug.test.ts.
    for (const slug of ['../../host/events', 'a/b', 'Diwali Supper', 'x%2fy']) {
      vi.clearAllMocks()
      cancelBooking.mockResolvedValue({ ok: true })

      const state = await cancelAttendeeBooking({}, form({ slug }))

      expect(state).toEqual({})
      expect(cancelBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID, 'host')
      expect(revalidatePath.mock.calls.flat()).toEqual([ATTENDEES_PATH, '/'])
    }
  })

  it('does not let an event id that is not uuid-shaped name the path', async () => {
    // The same defect one line above the slug: eventId is a hidden input and it
    // is interpolated into `/host/events/${eventId}/attendees`. A uuid is the
    // only thing this column ever holds, so the shape check is exact — and it
    // does not narrow authorisation, which cancelBooking still owns alone. The
    // test above ("never passes the form's eventId into the authorisation
    // decision") pins that a *valid* uuid naming somebody else's event is still
    // accepted here, so this guard cannot be mistaken for one.
    for (const eventId of ['../../../login', 'not-a-uuid', 'e1']) {
      vi.clearAllMocks()
      cancelBooking.mockResolvedValue({ ok: true })

      const state = await cancelAttendeeBooking({}, form({ eventId }))

      expect(state).toEqual({})
      expect(cancelBooking).toHaveBeenCalledWith({ id: CALLER_ID }, BOOKING_ID, 'host')
      expect(revalidatePath.mock.calls.flat()).toEqual([EVENT_PATH, '/'])
    }
  })

  it("returns the service's own refusal rather than a message of its own", async () => {
    // "Not yours", "does not exist" and "the lookup failed" are deliberately one
    // sentence in lib/bookings/service.ts, so an outsider cannot tell them
    // apart. Re-wording it here would mean two vocabularies for one refusal.
    cancelBooking.mockResolvedValue({ ok: false, error: 'That booking is not yours to cancel.' })

    const state = await cancelAttendeeBooking({}, form())

    expect(state).toEqual({ error: 'That booking is not yours to cancel.' })
  })

  it('does not revalidate anything when the cancellation failed', async () => {
    // Nothing moved, so nothing is stale. Revalidating regardless would mean a
    // refused cancellation costs a page re-render and reads, to anyone watching
    // the network tab, as though something had happened.
    cancelBooking.mockResolvedValue({ ok: false, error: 'That booking is not yours to cancel.' })

    await cancelAttendeeBooking({}, form())

    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
