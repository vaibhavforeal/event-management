'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { cancelBooking } from '@/lib/bookings/service'
import { loginPath } from '@/lib/auth/session'

export interface CancelState {
  error?: string
}

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

  if (eventId) revalidatePath(`/host/events/${eventId}/attendees`)

  // The seat is back, and the public page is where a visitor reads how many are
  // left — so a host removing a guest moves two numbers, not one. The same pair
  // app/bookings/actions.ts revalidates for the attendee's own cancel, and the
  // slug comes from the same place the ids do: a hidden input the page wrote
  // from the row it had just rendered. Falsy means no second path, not `/e/`.
  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`)
  return {}
}
