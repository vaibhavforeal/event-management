'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { cancelBooking } from '@/lib/bookings/service'
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
  const result = await cancelBooking(caller, bookingId, 'cancelled by host')
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
