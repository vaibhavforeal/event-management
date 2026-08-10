'use client'

import { useActionState } from 'react'
import { cancelMyBooking, type CancelState } from './actions'

/**
 * Its own Client Component so one cancel's pending and error state belongs to
 * one row. A single form around the list would make every row spin when any one
 * of them was submitted.
 */
export function CancelButton({
  bookingId,
  slug,
  consequence,
}: {
  bookingId: string
  slug: string
  /** The money consequence of this cancel, stated before the tap. Computed by
      the server (it owns the clock and the policy); null when no money moved. */
  consequence?: string | null
}) {
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelMyBooking, {})

  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="slug" value={slug} />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] underline disabled:opacity-60"
      >
        {pending ? 'Cancelling…' : 'Cancel booking'}
      </button>
      {/* The live region is rendered whether or not there is an error, because
          aria-live is only honoured on an element that was already in the DOM
          when its contents changed. A refusal here appears under a button the
          visitor just pressed and replaces nothing on screen, so a screen reader
          would otherwise announce nothing at all. */}
      <div aria-live="polite">
        {consequence && <p className="text-muted mt-1 text-[13px]">{consequence}</p>}
        {state.error && <p className="mt-1 text-[13px] text-red-700">{state.error}</p>}
      </div>
    </form>
  )
}
