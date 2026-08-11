'use client'

import { useActionState } from 'react'
import { claimSeat, type ClaimState } from './actions'

/**
 * "A seat opened up — claim it by <deadline>." One tap confirms; the server
 * re-render then swaps this panel for the tickets. Everything authoritative
 * happens server-side; this is a form with a sentence.
 *
 * The sentence arrives as a prop rather than being written here: it lives in
 * lib/bookings/waitlist-copy.ts with its three siblings, where a test can hold
 * it to its word.
 */
export function ClaimSeatPanel({ reference, sentence }: { reference: string; sentence: string }) {
  const [state, action, pending] = useActionState<ClaimState, FormData>(claimSeat, {})

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
          {pending ? 'Claiming…' : 'Claim your seat'}
        </button>
        {state.error && <p className="text-muted mt-2 text-center text-[13px]">{state.error}</p>}
      </form>
    </section>
  )
}
