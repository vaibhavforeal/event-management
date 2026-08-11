'use client'

import { useActionState } from 'react'
import { approveRequest, type ApprovalActionState } from './actions'

/**
 * Its own Client Component so one approval's pending and error state belongs
 * to one row — the same reasoning as cancel-attendee-button.tsx next door: a
 * single form around the queue would make every row spin when any one of them
 * was submitted.
 */
export function ApproveRequestButton({
  bookingId,
  eventId,
  slug,
  consequence,
}: {
  bookingId: string
  eventId: string
  slug: string
  /** What approving takes and what the guest then owes, stated before the
      tap. Computed by the server page, where the price is known. */
  consequence: string
}) {
  const [state, action, pending] = useActionState<ApprovalActionState, FormData>(
    approveRequest,
    {},
  )

  return (
    <form action={action} className="text-right">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="eventId" value={eventId} />
      {/* Names the public event page to revalidate — approval takes inventory,
          so its seats-left count is about to move. Not looked up in the
          action: the page already has it. */}
      <input type="hidden" name="slug" value={slug} />
      <button
        type="submit"
        disabled={pending}
        className="bg-ink text-paper rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-60"
      >
        {pending ? 'Approving…' : 'Approve'}
      </button>
      {/* The live region is rendered whether or not there is an error, because
          aria-live is only honoured on an element that was already in the DOM
          when its contents changed — same markup and reasoning as
          cancel-attendee-button.tsx. */}
      <div aria-live="polite">
        {/* max-w so the sentence wraps under the button: this column is
            shrink-0, so at its natural width the sentence would crush the
            guest's name on a phone. */}
        <p className="text-muted mt-1 max-w-[16ch] font-mono text-[11px]">{consequence}</p>
        {state.error && <p className="mt-1 max-w-[16ch] text-[13px] text-red-700">{state.error}</p>}
      </div>
    </form>
  )
}
