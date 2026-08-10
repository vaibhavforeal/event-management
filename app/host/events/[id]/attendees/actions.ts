'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { cancelBooking } from '@/lib/bookings/service'
import { checkInNextTicket } from '@/lib/checkin/service'
import { isEventSlug } from '@/lib/events/slug'
import { loginPath } from '@/lib/auth/session'

export interface CancelState {
  error?: string
}

// events.id is a uuid and never anything else, so the check on the value before
// it is pasted into a path can be exact. Version and variant nibbles are left
// unconstrained on purpose: this asks whether the string may name a path, not
// which generator made it, and pinning them would be a second, stricter claim
// that nothing here needs.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function cancelAttendeeBooking(
  _previous: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  const eventId = String(formData.get('eventId') ?? '')
  if (!bookingId) return { error: 'Something went wrong. Reload the page and try again.' }

  // The same mayCancel() the attendee's own cancel goes through. A host is
  // entitled here only because they host *this* event, and `eventId` arrives
  // from a form — so it is used for revalidation and never for the decision.
  const result = await cancelBooking(caller, bookingId, 'host')
  if (!result.ok) return { error: result.error }

  // Shape-checked rather than merely non-empty, for the same reason the slug
  // below is: both are hidden inputs and both get interpolated into a path, so
  // a falsiness check let `../../../login` through as a path segment. It stays
  // no part of the authorisation decision either way — that is the test two
  // files over named "never passes the form's eventId into the authorisation
  // decision", and a valid uuid naming somebody else's event is still accepted
  // here on purpose.
  if (UUID_PATTERN.test(eventId)) revalidatePath(`/host/events/${eventId}/attendees`)

  // The seat is back, and the public page is where a visitor reads how many are
  // left — so a host removing a guest moves two numbers, not one. The same pair
  // app/bookings/actions.ts revalidates for the attendee's own cancel, and the
  // slug comes from the same place the ids do: a hidden input the page wrote
  // from the row it had just rendered. Anything that is not slug-shaped means
  // no second path, not `/e/` and not a path of the sender's choosing.
  const slug = String(formData.get('slug') ?? '')
  if (isEventSlug(slug)) revalidatePath(`/e/${slug}`)

  // The feed carries the same reserved_count in its payload — it is in
  // FEED_COLUMNS (lib/events/queries.ts) — without painting it:
  // app/_components/event-card.tsx renders date, title, venue and price and no
  // seat count. So nothing visible is corrected here today. Unlike the two
  // paths above, this one is a constant, so no missing field can skip it.
  //
  // Why it is here anyway, why it is not about server rendering, and why the
  // answer to a stale count is never `export const revalidate`, is written out
  // once — over the same pair of calls in app/e/[slug]/actions.ts.
  revalidatePath('/')
  return {}
}

export interface CheckInState {
  error?: string
}

/**
 * Admits the next person on a booking — the tap fallback for a guest with no
 * QR, no camera, or no Chrome. The service re-checks that the caller hosts
 * this event; eventId arriving from a hidden input is safe for the same
 * reason the cancel action's is — lying about it changes which door you are
 * refused at, not what you may do — but unlike the cancel action it IS passed
 * to the service, as the scope to authorise against, so a junk shape stops
 * here rather than travelling.
 */
export async function checkInAttendee(
  _previous: CheckInState,
  formData: FormData,
): Promise<CheckInState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  const eventId = String(formData.get('eventId') ?? '')
  // bookingId is shape-checked here where the cancel above stops at emptiness,
  // because the services differ: cancelBooking folds every failure into one
  // refusal sentence, but a junk shape given to checkInNextTicket dies as a
  // failed uuid cast in the RPC, and mapCheckinRpcError's fallback would hand
  // the host raw Postgres.
  if (!UUID_PATTERN.test(bookingId) || !UUID_PATTERN.test(eventId)) {
    return { error: 'Something went wrong. Reload the page and try again.' }
  }

  const result = await checkInNextTicket(caller, eventId, bookingId)
  if (!result.ok) return { error: result.error }

  revalidatePath(`/host/events/${eventId}/attendees`)
  return {}
}
