'use client'

import { useActionState } from 'react'
import { cancelAttendeeBooking, type CancelState } from './actions'

export function CancelAttendeeButton({
  bookingId,
  eventId,
}: {
  bookingId: string
  eventId: string
}) {
  const [state, action, pending] = useActionState<CancelState, FormData>(
    cancelAttendeeBooking,
    {},
  )

  return (
    <form action={action}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="eventId" value={eventId} />
      <button type="submit" disabled={pending} className="text-[13px] underline disabled:opacity-60">
        {pending ? 'Cancelling…' : 'Cancel'}
      </button>
      {state.error && <p className="mt-1 text-[13px] text-red-700">{state.error}</p>}
    </form>
  )
}
