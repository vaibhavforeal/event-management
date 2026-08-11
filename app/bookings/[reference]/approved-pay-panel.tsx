'use client'

import { useActionState } from 'react'
import { startApprovedPayment, type ApprovedPayState } from './actions'

/**
 * One tap creates the order; the server re-render then swaps this panel for
 * the checkout sheet. Everything authoritative happens server-side; this is a
 * form with a sentence.
 *
 * The sentence is a prop because there are two of them now — a host saying yes,
 * and a seat coming free off a waitlist — and they are the same machinery
 * underneath (awaiting_payment, approved_at, a 24-hour hold) telling a person
 * two different things. Both live in lib/bookings/waitlist-copy.ts.
 */
export function ApprovedPayPanel({
  reference,
  amountLabel,
  sentence,
}: {
  reference: string
  amountLabel: string
  sentence: string
}) {
  const [state, action, pending] = useActionState<ApprovedPayState, FormData>(startApprovedPayment, {})

  return (
    <section className="border-line mt-8 rounded-lg border p-4">
      <form action={action}>
        <input type="hidden" name="reference" value={reference} />
        <p className="text-sm">{sentence}</p>
        <button
          type="submit"
          disabled={pending}
          className="bg-ink text-paper mt-3 w-full rounded-lg px-5 py-3 text-[15px] font-medium disabled:opacity-60"
        >
          {pending ? 'Starting payment…' : `Pay ${amountLabel}`}
        </button>
        {state.error && <p className="text-muted mt-2 text-center text-[13px]">{state.error}</p>}
      </form>
    </section>
  )
}
