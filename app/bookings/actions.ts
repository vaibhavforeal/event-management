'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { cancelBooking } from '@/lib/bookings/service'
import { loginPath } from '@/lib/auth/session'

export interface CancelState {
  error?: string
}

/**
 * Cancels one of the caller's own bookings.
 *
 * The form carries a bookingId and nothing else that matters — who is asking
 * comes from currentCaller() and cannot come from a field. See
 * lib/bookings/caller.ts.
 */
export async function cancelMyBooking(
  _previous: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  if (!bookingId) return { error: 'Something went wrong. Reload the page and try again.' }

  // cancelBooking re-checks who the caller is against the booking. Being signed
  // in is not the same as being entitled to this row, and RLS is not in this
  // path to make the difference for us.
  const result = await cancelBooking(caller, bookingId, 'cancelled by attendee')
  if (!result.ok) return { error: result.error }

  revalidatePath('/bookings')
  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`) // the seat is back

  // The feed holds the same freed seat in its payload without painting it:
  // reserved_count is in FEED_COLUMNS (lib/events/queries.ts), while
  // app/_components/event-card.tsx renders only date, title, venue and price.
  // So this corrects no visible number today.
  //
  // Why it is here anyway, why it is not about server rendering, and why the
  // answer to a stale count is never `export const revalidate`, is written out
  // once — over the same pair of calls in app/e/[slug]/actions.ts.
  revalidatePath('/')
  return {}
}
