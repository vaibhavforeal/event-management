'use client'

import { useActionState } from 'react'
import { recordPayoutAction, type RecordPayoutState } from '@/app/admin/actions'

export function RecordPayoutForm({ eventId }: { eventId: string }) {
  const [state, action, pending] = useActionState<RecordPayoutState, FormData>(
    recordPayoutAction,
    {},
  )

  return (
    <form action={action} className="border-line mt-3 space-y-2 border-t pt-3">
      <input type="hidden" name="eventId" value={eventId} />
      {/* No amount fields, deliberately. The server recomputes them. */}
      <div className="flex flex-wrap gap-2">
        <input
          name="utr"
          placeholder="UTR / bank reference"
          className="border-line min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
        />
        <input
          name="notes"
          placeholder="Notes (optional)"
          className="border-line min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          name="status"
          value="paid"
          disabled={pending}
          className="bg-ink text-paper rounded-lg px-3 py-2 text-sm disabled:opacity-50"
        >
          Record payment
        </button>
        <button
          type="submit"
          name="status"
          value="on_hold"
          disabled={pending}
          className="border-line rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
        >
          Put on hold
        </button>
      </div>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      {state.ok && <p className="text-muted text-sm">Recorded.</p>}
    </form>
  )
}
