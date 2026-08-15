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
    <section className="mt-8 rounded-xl bg-white p-4 shadow-[0_2px_12px_rgba(124,45,18,0.10)]">
      <form action={action}>
        <input type="hidden" name="reference" value={reference} />
        <p className="text-sm">{sentence}</p>
        <button
          type="submit"
          disabled={pending}
          className="mt-3 w-full bg-ember text-white rounded-full px-5 py-3 text-[15px] font-semibold hover:bg-ember-deep disabled:opacity-60"
        >
          {pending ? 'Claiming…' : 'Claim your seat'}
        </button>
        {state.error && <p className="text-muted mt-2 text-center text-[13px]">{state.error}</p>}
      </form>
    </section>
  )
}
