'use client'

import { useActionState } from 'react'
import { bookEvent, type BookState } from './actions'

const MIST = '#E7E2D8'
const SLATE = '#6B6560'

interface Props {
  ticketTypeId: string
  slug: string
  /** Upper bound of the picker: min(seats left, max_per_order). */
  maxSeats: number
  priceLabel: string
  seatsLabel: string
}

/**
 * The bottom bar's live half. A Client Component because the quantity picker
 * and the pending state need state; the page around it stays a Server
 * Component, so the event itself is still server-rendered for the WhatsApp
 * crawler.
 */
export function BookPanel({ ticketTypeId, slug, maxSeats, priceLabel, seatsLabel }: Props) {
  const [state, action, pending] = useActionState<BookState, FormData>(bookEvent, {})

  return (
    <form action={action} className="mx-auto flex max-w-2xl items-center justify-between gap-3">
      <input type="hidden" name="ticketTypeId" value={ticketTypeId} />
      <input type="hidden" name="slug" value={slug} />

      <div className="min-w-0">
        <p className="font-mono text-[19px] leading-tight font-semibold">{priceLabel}</p>
        <p className="font-mono text-[12px]" style={{ color: SLATE }}>
          {state.error ?? seatsLabel}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <label className="sr-only" htmlFor="attendeeName">
          Your name
        </label>
        <input
          id="attendeeName"
          name="attendeeName"
          type="text"
          required
          maxLength={80}
          placeholder="Your name"
          disabled={pending}
          className="w-28 rounded-lg border px-3 py-3 text-[15px]"
          style={{ borderColor: MIST }}
        />

        <label className="sr-only" htmlFor="quantity">
          Seats
        </label>
        <select
          id="quantity"
          name="quantity"
          defaultValue="1"
          disabled={pending}
          className="rounded-lg border px-3 py-3 font-mono text-[15px]"
          style={{ borderColor: MIST }}
        >
          {Array.from({ length: maxSeats }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg px-5 py-3 text-[15px] font-medium text-white disabled:opacity-60"
          style={{ backgroundColor: '#1B1917' }}
        >
          {pending ? 'Booking…' : 'Book'}
        </button>
      </div>
    </form>
  )
}
