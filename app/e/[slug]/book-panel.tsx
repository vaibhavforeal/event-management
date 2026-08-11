'use client'

import { useActionState } from 'react'
import { bookCashEvent, bookEvent, startPaidCheckout, type BookState } from './actions'

// Colours come from the globals.css tokens. This file used to carry its own
// MIST/SLATE literals that had drifted a few values away from the page it sits
// inside — the kind of drift the tokens exist to end, so do not reintroduce
// local constants here.

interface Props {
  ticketTypeId: string
  slug: string
  /** Upper bound of the picker: min(seats left, max_per_order). */
  maxSeats: number
  priceLabel: string
  seatsLabel: string
  /**
   * Swaps the free path for the paid one: startPaidCheckout instead of
   * bookEvent, and a button that says what tapping it costs. The form is
   * otherwise identical — the two actions read the same four fields and
   * refuse the same mistakes with the same sentences.
   */
  paid?: boolean
  /** Offers "cash at the door" beside the online button. Paid panels only. */
  cash?: boolean
}

/**
 * The bottom bar's live half. A Client Component because the quantity picker
 * and the pending state need state; the page around it stays a Server
 * Component, so the event itself is still server-rendered for the WhatsApp
 * crawler.
 */
export function BookPanel({
  ticketTypeId,
  slug,
  maxSeats,
  priceLabel,
  seatsLabel,
  paid = false,
  cash = false,
}: Props) {
  const [state, action, pending] = useActionState<BookState, FormData>(
    paid ? startPaidCheckout : bookEvent,
    {},
  )
  // A second useActionState for the cash path: two dispatchers, one form —
  // each button names its action via formAction, each action owns its
  // pending/error state.
  const [cashState, cashAction, cashPending] = useActionState<BookState, FormData>(bookCashEvent, {})
  const busy = pending || cashPending

  return (
    <form action={action} className="mx-auto flex max-w-2xl items-center justify-between gap-3">
      <input type="hidden" name="ticketTypeId" value={ticketTypeId} />
      <input type="hidden" name="slug" value={slug} />

      <div className="min-w-0">
        <p className="font-mono text-[19px] leading-tight font-semibold">{priceLabel}</p>
        <p className="text-muted font-mono text-[12px]">
          {state.error ?? cashState.error ?? seatsLabel}
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
          disabled={busy}
          className="border-line w-28 rounded-lg border px-3 py-3 text-[15px]"
        />

        <label className="sr-only" htmlFor="quantity">
          Seats
        </label>
        <select
          id="quantity"
          name="quantity"
          defaultValue="1"
          disabled={busy}
          className="border-line rounded-lg border px-3 py-3 font-mono text-[15px]"
        >
          {Array.from({ length: maxSeats }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        <button
          type="submit"
          disabled={busy}
          className="bg-ink text-paper rounded-lg px-5 py-3 text-[15px] font-medium disabled:opacity-60"
        >
          {pending ? (paid ? 'Starting payment…' : 'Booking…') : paid ? `Pay ${priceLabel}` : 'Book'}
        </button>

        {paid && cash && (
          <button
            type="submit"
            formAction={cashAction}
            disabled={busy}
            className="border-line text-ink rounded-lg border px-4 py-3 text-[14px] font-medium disabled:opacity-60"
          >
            {cashPending ? 'Booking…' : 'Cash at the door'}
          </button>
        )}
      </div>
    </form>
  )
}
