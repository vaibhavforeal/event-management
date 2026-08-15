'use client'

import Script from 'next/script'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { formatPaise } from '@/lib/money'
import { pollBookingStatus } from './actions'

/**
 * The pay button, the Razorpay sheet, the hold countdown, and the
 * status polling — everything client-side about checkout, and none of it
 * authoritative: the server confirms from Razorpay's own answers, this
 * component only watches for the flip and refreshes.
 */

interface RazorpaySheet {
  open(): void
  close(): void
}

interface RazorpayOptions {
  key: string
  amount: number
  currency: string
  name: string
  order_id: string
  handler: (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => void
  modal?: { ondismiss?: () => void }
  prefill?: { name?: string }
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpaySheet
  }
}

const POLL_MS = 2500

function secondsLeft(until: string): number {
  const ms = new Date(until).getTime() - Date.now()
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 1000))
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function CheckoutPanel({
  reference,
  orderId,
  amountPaise,
  keyId,
  eventTitle,
  holdExpiresAt,
  attendeeName,
  deadlineLabel,
}: {
  reference: string
  orderId: string
  amountPaise: number
  keyId: string
  eventTitle: string
  holdExpiresAt: string
  attendeeName: string | null
  /** Preformatted IST deadline; shown instead of the mm:ss clock when the
   *  hold is longer than an hour (the 24h approval window). */
  deadlineLabel: string
}) {
  const router = useRouter()
  // Seeded from window rather than a bare `false`: on a client-side remount
  // (my-bookings → booking A → back → booking B) checkout.js is already on the
  // page and next/script fires no load event for it, so a false start here
  // would leave the button disabled until a hard reload. At hydration the
  // script has not run yet — afterInteractive injects after hydration — so
  // this initializer answers false there and matches the server HTML.
  const [scriptReady, setScriptReady] = useState(
    () => typeof window !== 'undefined' && !!window.Razorpay,
  )
  const [remaining, setRemaining] = useState(() => secondsLeft(holdExpiresAt))
  const [paid, setPaid] = useState<{ paymentId: string; signature: string } | null>(null)
  const sheetRef = useRef<RazorpaySheet | null>(null)

  // The hold countdown. At zero the sheet closes and the server re-renders
  // this page into its expired shape; a capture that raced the deadline is
  // the processor's auto-refund case, not this component's problem.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const left = secondsLeft(holdExpiresAt)
      setRemaining(left)
      if (left <= 0) {
        sheetRef.current?.close()
        window.clearInterval(interval)
        router.refresh()
      }
    }, 1000)
    return () => window.clearInterval(interval)
  }, [holdExpiresAt, router])

  // Polling starts when the sheet reports success. The first tick carries the
  // checkout proof; after that it is a plain read every POLL_MS until the
  // status flips, then a server re-render swaps this panel for the QR view.
  useEffect(() => {
    if (!paid) return
    let firstTick: { paymentId: string; signature: string } | null = paid
    const interval = window.setInterval(async () => {
      const attempt = firstTick
      firstTick = null
      try {
        const result = await pollBookingStatus(reference, attempt ?? undefined)
        if (result.status !== 'awaiting_payment' && result.status !== 'unknown') {
          window.clearInterval(interval)
          router.refresh()
        }
      } catch {
        // transient; the next tick tries again, and the webhook is landing anyway
      }
    }, POLL_MS)
    return () => window.clearInterval(interval)
  }, [paid, reference, router])

  function openSheet() {
    if (!window.Razorpay) return
    const sheet = new window.Razorpay({
      key: keyId,
      amount: amountPaise,
      currency: 'INR',
      name: eventTitle,
      order_id: orderId,
      handler: (response) =>
        setPaid({ paymentId: response.razorpay_payment_id, signature: response.razorpay_signature }),
      modal: { ondismiss: () => {} }, // an abandoned sheet resumes from this same page
      prefill: attendeeName ? { name: attendeeName } : {},
    })
    sheetRef.current = sheet
    sheet.open()
  }

  const expired = remaining <= 0

  return (
    <section className="mt-8 rounded-xl bg-white p-4 shadow-[0_2px_12px_rgba(124,45,18,0.10)]">
      {/* onReady, not onLoad: onLoad fires once per script load, so a remount
          with checkout.js already cached would never enable the button.
          onReady fires on every mount, including that one. */}
      <Script src="https://checkout.razorpay.com/v1/checkout.js" onReady={() => setScriptReady(true)} />
      <div aria-live="polite">
        {paid ? (
          <p className="text-sm">Payment received — issuing your tickets…</p>
        ) : expired ? (
          <p className="text-sm">This hold has expired. Nothing was charged.</p>
        ) : (
          <>
            <button
              type="button"
              onClick={openSheet}
              disabled={!scriptReady}
              className="w-full bg-ember text-white rounded-full px-5 py-3 text-[15px] font-semibold hover:bg-ember-deep disabled:opacity-60"
            >
              Pay {formatPaise(amountPaise)}
            </button>
            <p className="text-muted mt-2 text-center font-mono text-[12px]">
              {remaining > 3600 ? `Pay by ${deadlineLabel}` : `Seats held for another ${clock(remaining)}`}
            </p>
          </>
        )}
      </div>
    </section>
  )
}
