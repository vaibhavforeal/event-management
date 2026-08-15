'use client'

import { useActionState, useState } from 'react'
import { joinTheWaitlist, type BookState } from './actions'

interface Props {
  ticketTypeId: string
  slug: string
  /** min(max_per_order, quantity) — NOT seats remaining. There are none; that
   *  is why this panel is mounted. */
  maxSeats: number
  /** "₹500 — you pay only if a seat opens for you". */
  priceLine: string
  /** "3 people waiting" — the number that decides whether joining is worth it. */
  lineLine: string
  /** Offer the online/cash choice — allows_cash events with a price. */
  offerCash: boolean
}

/**
 * The bottom bar on a sold-out event that keeps a line. Where "Sold out" used
 * to sit inert, this asks for a name and a seat count and nothing else — no
 * payment, no hold, no note. The money question is answered now only because
 * the offer, when it comes, has to know which door to open.
 */
export function JoinWaitlistPanel({
  ticketTypeId,
  slug,
  maxSeats,
  priceLine,
  lineLine,
  offerCash,
}: Props) {
  const [state, action, pending] = useActionState<BookState, FormData>(joinTheWaitlist, {})
  const [mode, setMode] = useState<'online' | 'cash'>('online')

  return (
    <form action={action} className="mx-auto max-w-2xl space-y-2">
      <input type="hidden" name="ticketTypeId" value={ticketTypeId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="paymentMode" value={mode} />

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[19px] leading-tight font-semibold">{priceLine}</p>
          <p className="text-muted font-mono text-[12px]">{state.error ?? lineLine}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="sr-only" htmlFor="attendeeName">Your name</label>
          <input
            id="attendeeName"
            name="attendeeName"
            type="text"
            required
            maxLength={80}
            placeholder="Your name"
            disabled={pending}
            className="border-cream-line bg-white w-28 rounded-lg border px-3 py-3 text-[15px]"
          />
          <label className="sr-only" htmlFor="quantity">Seats</label>
          <select
            id="quantity"
            name="quantity"
            defaultValue="1"
            disabled={pending}
            className="border-cream-line bg-white rounded-lg border px-3 py-3 font-mono text-[15px]"
          >
            {Array.from({ length: maxSeats }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={pending}
            className="bg-ember text-white rounded-full px-5 py-3 text-[15px] font-semibold hover:bg-ember-deep disabled:opacity-60"
          >
            {pending ? 'Joining…' : 'Join the waitlist'}
          </button>
        </div>
      </div>

      {offerCash && (
        <fieldset className="flex gap-4 font-mono text-[12px]">
          <legend className="sr-only">How you&apos;ll pay if a seat opens</legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="paymentModeChoice"
              checked={mode === 'online'}
              onChange={() => setMode('online')}
              disabled={pending}
            />
            Pay online if a seat opens
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="paymentModeChoice"
              checked={mode === 'cash'}
              onChange={() => setMode('cash')}
              disabled={pending}
            />
            Cash at the door
          </label>
        </fieldset>
      )}
    </form>
  )
}
