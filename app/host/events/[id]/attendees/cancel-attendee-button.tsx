'use client'

import { useActionState } from 'react'
import { cancelAttendeeBooking, type CancelState } from './actions'

/**
 * Its own Client Component so one cancel's pending and error state belongs to
 * one row. A single form around the list would make every row spin when any one
 * of them was submitted. Same shape as app/bookings/cancel-button.tsx, which is
 * this control on the attendee's side of the same booking.
 */
export function CancelAttendeeButton({
  bookingId,
  eventId,
  slug,
}: {
  bookingId: string
  eventId: string
  slug: string
}) {
  const [state, action, pending] = useActionState<CancelState, FormData>(
    cancelAttendeeBooking,
    {},
  )

  return (
    <form action={action}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="eventId" value={eventId} />
      {/* Names the public event page to revalidate — its seats-left count has
          just moved. Not looked up in the action: the page already has it. */}
      <input type="hidden" name="slug" value={slug} />
      <button type="submit" disabled={pending} className="text-[13px] underline disabled:opacity-60">
        {pending ? 'Cancelling…' : 'Cancel'}
      </button>
      {/* The live region is rendered whether or not there is an error, because
          aria-live is only honoured on an element that was already in the DOM
          when its contents changed. A refusal here appears under a button the
          host just pressed and replaces nothing on screen, so a screen reader
          would otherwise announce nothing at all. Same reasoning, and the same
          markup, as app/bookings/cancel-button.tsx. */}
      <div aria-live="polite">
        {state.error && <p className="mt-1 text-[13px] text-red-700">{state.error}</p>}
      </div>
    </form>
  )
}
