'use client'

import { useActionState } from 'react'
import { ALL_SEATS_IN_SENTENCE } from '@/lib/checkin/sentences'
import { checkInAttendee, type CheckInState } from './actions'

/**
 * Its own Client Component so one check-in's pending and error state belongs
 * to one row — the same reasoning as cancel-attendee-button.tsx beside it,
 * whose shape this clones.
 *
 * "+1" and not a name because check_in_next_ticket admits seats in ticket
 * order, not people: the booking knows how many are in, never which of the
 * three friends walked through first.
 */
export function CheckInButton({
  bookingId,
  eventId,
  remaining,
}: {
  bookingId: string
  eventId: string
  remaining: number
}) {
  const [state, action, pending] = useActionState<CheckInState, FormData>(checkInAttendee, {})

  // Disabled rather than hidden when everyone is in, so the row still reads as
  // "this control exists and there is nothing left for it to do". The title is
  // the EH022 sentence the service would return, so hover and a handcrafted
  // POST meet the same vocabulary.
  const allIn = remaining === 0

  return (
    <form action={action}>
      <input type="hidden" name="bookingId" value={bookingId} />
      {/* The scope the service authorises against — see checkInAttendee. */}
      <input type="hidden" name="eventId" value={eventId} />
      <button
        type="submit"
        disabled={pending || allIn}
        title={allIn ? ALL_SEATS_IN_SENTENCE : undefined}
        className="text-[13px] underline disabled:opacity-60"
      >
        {pending ? 'Checking in…' : 'Check in +1'}
      </button>
      {/* The live region is rendered whether or not there is an error, because
          aria-live is only honoured on an element that was already in the DOM
          when its contents changed. Same reasoning, and the same markup, as
          cancel-attendee-button.tsx. */}
      <div aria-live="polite">
        {state.error && <p className="mt-1 text-[13px] text-red-700">{state.error}</p>}
      </div>
    </form>
  )
}
