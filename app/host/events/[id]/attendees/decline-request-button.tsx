'use client'

import { useActionState } from 'react'
import { declineRequest, type ApprovalActionState } from './actions'

/**
 * The approve button's secondary twin: same one-row ownership of pending and
 * error state, no slug input — a decline moves no inventory, so the public
 * page has nothing to repaint.
 */
export function DeclineRequestButton({
  bookingId,
  eventId,
}: {
  bookingId: string
  eventId: string
}) {
  const [state, action, pending] = useActionState<ApprovalActionState, FormData>(
    declineRequest,
    {},
  )

  return (
    <form action={action} className="text-right">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="eventId" value={eventId} />
      <button
        type="submit"
        disabled={pending}
        className="border-line text-ink rounded-lg border px-4 py-2 text-[13px] font-medium disabled:opacity-60"
      >
        {pending ? 'Declining…' : 'Decline'}
      </button>
      {/* The live region is rendered whether or not there is an error, for the
          same reason as the approve button's. */}
      <div aria-live="polite">
        {/* Declining is not a door slammed: the request row simply frees, and
            nothing stops the guest asking again. Said here so the softer
            button reads as the softer act. */}
        <p className="text-muted mt-1 max-w-[16ch] font-mono text-[11px]">
          They can request again.
        </p>
        {state.error && <p className="mt-1 max-w-[16ch] text-[13px] text-red-700">{state.error}</p>}
      </div>
    </form>
  )
}
