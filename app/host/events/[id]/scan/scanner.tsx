'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { eventKeyFromHex, verifyQrPayload } from '@/lib/tickets/signing'
import { formatIst } from '@/lib/events/datetime'
import { checkInByCode } from './actions'
import {
  IDLE,
  reduceScan,
  type ScanEvent,
  type ScanSession,
  type ScanVerdict,
} from './scan-state'

/** How often the detector looks. Detection is cheap; admitting people is not a
 *  frame-rate problem. */
const DETECT_INTERVAL_MS = 300

// Minimal type for the native detector; TS has no built-in lib entry for it.
interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>
}
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => BarcodeDetectorLike
  }
}

/**
 * The camera loop stays dumb: it reports what it saw, and every decision about
 * what a detection *means* lives in reduceScan (tested) or on the server
 * (tested). This component only wires the two together.
 */
export function Scanner({ eventId, eventKeyHex }: { eventId: string; eventKeyHex: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const sessionRef = useRef<ScanSession>(IDLE)
  const [session, setSession] = useState<ScanSession>(IDLE)
  const [camera, setCamera] = useState<'starting' | 'on' | 'unsupported' | 'denied'>('starting')

  // One dispatcher: applies the reducer, and if this event opened a new
  // pending flight, runs verification for it. Named so the flight can land its
  // own verdict through the same door it came in by.
  const dispatch = useCallback(
    function dispatch(event: ScanEvent): void {
      const previous = sessionRef.current
      const next = reduceScan(previous, event)
      if (next === previous) return
      sessionRef.current = next
      setSession(next)

      // Identity is the reducer's contract: only a detection that returned a
      // NEW session with a pending current opened a flight. A re-detection of
      // the same QR hands back the same object and was caught above.
      if (event.type !== 'detected' || next.current?.verdict !== 'pending') return
      const payload = next.current.payload

      void (async () => {
        let verdict: ScanVerdict
        try {
          // Local first: the signature proves the QR was issued for this event,
          // so a random poster's QR never costs a server round-trip.
          const verified = await verifyQrPayload(eventKeyFromHex(eventKeyHex), payload)
          if (!verified.valid) {
            verdict = { kind: 'invalid', reason: verified.reason }
          } else {
            // The server does not rely on that local check — see actions.ts.
            const result = await checkInByCode(eventId, verified.code)
            verdict = !result.ok
              ? { kind: 'refused', message: result.error }
              : result.outcome === 'checked_in'
                ? {
                    kind: 'in',
                    name: result.attendeeName,
                    ticketsIn: result.ticketsIn,
                    ticketsTotal: result.ticketsTotal,
                  }
                : {
                    kind: 'already',
                    name: result.attendeeName,
                    checkedInAt: result.checkedInAt,
                  }
          }
        } catch {
          // The network dying mid-call, or the action redirecting a stale
          // session. Land the flight with the action's own generic sentence
          // rather than leaving the door wedged on "Checking…" — while a
          // flight is pending the reducer starts nothing new.
          verdict = { kind: 'refused', message: 'Something went wrong. Rescan the ticket.' }
        }
        dispatch({ type: 'verdict', payload, verdict })
      })()
    },
    [eventId, eventKeyHex],
  )

  useEffect(() => {
    // No detector → no camera. The guest list is the fallback and the page
    // says so; do not request camera permission for a screen that cannot use it.
    if (!window.BarcodeDetector) {
      setCamera('unsupported')
      return
    }

    const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
    let stream: MediaStream | null = null
    let interval: number | undefined
    let cancelled = false

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((granted) => {
        // The permission prompt can outlive the page it was asked on.
        if (cancelled || !videoRef.current) {
          granted.getTracks().forEach((track) => track.stop())
          return
        }
        stream = granted
        videoRef.current.srcObject = granted
        setCamera('on')
        interval = window.setInterval(async () => {
          const video = videoRef.current
          if (!video) return
          // A frame the detector cannot read (camera still warming up) is a
          // frame with no barcodes, not an error worth surfacing at a door.
          const barcodes = await detector.detect(video).catch(() => [])
          if (barcodes[0]) dispatch({ type: 'detected', payload: barcodes[0].rawValue })
        }, DETECT_INTERVAL_MS)
      })
      .catch(() => setCamera('denied'))

    return () => {
      cancelled = true
      if (interval !== undefined) window.clearInterval(interval)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [eventId, eventKeyHex, dispatch])

  if (camera === 'unsupported') {
    return (
      <div className="border-line mt-8 border p-4">
        <p className="text-[15px]">
          Point-and-scan needs Chrome on Android. Use the guest list to check people in.
        </p>
        <p className="mt-2">
          <Link
            href={`/host/events/${eventId}/attendees`}
            className="font-mono text-[13px] underline"
          >
            Guest list →
          </Link>
        </p>
      </div>
    )
  }

  if (camera === 'denied') {
    return (
      <div className="border-line mt-8 border p-4">
        <p className="text-[15px]">Camera permission was refused.</p>
        <p className="text-muted mt-2 text-[13px]">
          Allow camera access for this site in your browser settings, then reload this page.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-6">
      <video ref={videoRef} autoPlay muted playsInline className="bg-ink w-full" />
      {/* Rendered whether or not there is a verdict, because aria-live is only
          honoured on an element that was already in the DOM when its contents
          changed — same reasoning as the guest list's buttons. */}
      <div aria-live="polite">
        {session.current && (
          <div className="mt-4">
            <VerdictCard verdict={session.current.verdict} />
            {/* No Dismiss while pending: the reducer's invariant is that
                nothing new starts while a flight is up, and a dismissed
                pending card would reopen the door under an unresolved scan. */}
            {session.current.verdict !== 'pending' && (
              <button
                type="button"
                onClick={() => dispatch({ type: 'dismiss' })}
                className="bg-ink text-paper mt-3 w-full px-4 py-3 text-[15px] font-medium"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** One glance at arm's length: the name is the headline, the hue is the answer. */
function VerdictCard({ verdict }: { verdict: ScanVerdict | 'pending' }) {
  if (verdict === 'pending') {
    return <p className="text-muted text-[15px]">Checking…</p>
  }
  switch (verdict.kind) {
    case 'in':
      return (
        <div className="rounded-md bg-green-100 p-4 text-green-800">
          <p className="text-2xl font-semibold">{verdict.name ?? 'Guest'}</p>
          <p className="mt-1 text-[15px]">
            {verdict.ticketsIn} of {verdict.ticketsTotal} in
          </p>
        </div>
      )
    case 'already':
      return (
        <div className="rounded-md bg-amber-50 p-4 text-amber-800">
          <p className="text-2xl font-semibold">{verdict.name ?? 'Guest'}</p>
          <p className="mt-1 text-[15px]">
            Already checked in · {formatIst(new Date(verdict.checkedInAt))}
          </p>
        </div>
      )
    case 'refused':
      return (
        <div className="rounded-md bg-red-50 p-4 text-red-700">
          <p className="text-lg font-medium">{verdict.message}</p>
        </div>
      )
    case 'invalid':
      return (
        <div className="rounded-md bg-red-50 p-4 text-red-700">
          <p className="text-lg font-medium">Not a ticket for this event.</p>
        </div>
      )
  }
}
