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
  return {}
}
