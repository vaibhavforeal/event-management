'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { eventKeyFromHex, verifyQrPayload } from '@/lib/tickets/signing'
import { formatIst } from '@/lib/events/datetime'
import { sha256Hex } from '@/lib/checkin/offline/hash'
import { decideOffline } from '@/lib/checkin/offline/verdict'
import { openDoorStore, type DoorStore } from '@/lib/checkin/offline/store'
import { drainQueue, type SyncReportLine } from '@/lib/checkin/offline/sync'
import type { DoorPack } from '@/lib/checkin/offline/pack'
import {
  ARMING_UNAVAILABLE_SENTENCE,
  NOT_ON_ROSTER_SENTENCE,
  RESCAN_SENTENCE,
} from '@/lib/checkin/sentences'
import { checkInByCode, loadDoorPack, syncOfflineCheckins } from './actions'
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

  // The door's offline half. storeRef holds the ONE store handle; null after
  // a failed open means IndexedDB is unavailable and the banner says so.
  const storeRef = useRef<DoorStore | null | 'opening'>('opening')
  const [pack, setPack] = useState<DoorPack | null>(null)
  const [storeUnavailable, setStoreUnavailable] = useState(false)
  const [queueCount, setQueueCount] = useState(0)
  const [report, setReport] = useState<SyncReportLine[]>([])
  const syncingRef = useRef(false)

  /** Arms the door: fresh pack from the server (online), cached pack for the
   *  header regardless. Any store rejection downgrades to online-only. */
  const arm = useCallback(async () => {
    try {
      if (storeRef.current === 'opening') {
        storeRef.current = await openDoorStore()
        if (storeRef.current === null) setStoreUnavailable(true)
      }
      // No 'opening' check here: the branch above just replaced it, and TS
      // knows — only null (unavailable) or a live store can remain.
      const store = storeRef.current
      if (!store) return
      const cached = await store.loadPack(eventId)
      if (cached) setPack(cached)
      setQueueCount((await store.queueFor(eventId)).length)
      if (navigator.onLine) {
        const result = await loadDoorPack(eventId)
        if (result.ok) {
          await store.savePack(result.pack)
          setPack(result.pack)
        }
      }
    } catch {
      // Store died mid-session (eviction, private mode): same downgrade as
      // never having opened. Online scanning is untouched.
      storeRef.current = null
      setStoreUnavailable(true)
    }
  }, [eventId])

  /** Drains the queue through the sync action. Never concurrent with itself. */
  const runSync = useCallback(async () => {
    const store = storeRef.current
    if (!store || store === 'opening' || syncingRef.current || !navigator.onLine) return
    syncingRef.current = true
    try {
      const { lines, remaining } = await drainQueue({
        store,
        eventId,
        // A thrown action (network died again, or a stale session's redirect)
        // reads as transport failure: keep the queue, retry on the next trigger.
        post: (entries) => syncOfflineCheckins(eventId, entries).catch(() => ({
          ok: false as const,
          error: RESCAN_SENTENCE,
        })),
      })
      if (lines.length > 0) {
        setReport((prev) => [...prev, ...lines])
        void arm() // counts moved server-side; refresh the roster if online
      }
      setQueueCount(remaining)
    } finally {
      syncingRef.current = false
    }
  }, [eventId, arm])

  useEffect(() => {
    void arm().then(() => runSync())
    const onOnline = () => void runSync()
    window.addEventListener('online', onOnline)
    // 30s heartbeat: only drains when a queue exists and the network is back.
    const interval = window.setInterval(() => void runSync(), 30_000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.clearInterval(interval)
    }
  }, [arm, runSync])

  /** The offline path: pack + queue → decideOffline → maybe enqueue. */
  const offlineVerdict = useCallback(
    async (code: string): Promise<ScanVerdict> => {
      const store = storeRef.current
      if (!store || store === 'opening') {
        // Nowhere durable to queue: honest refusal, not a silent drop.
        return { kind: 'refused', message: ARMING_UNAVAILABLE_SENTENCE }
      }
      try {
        const codeHash = await sha256Hex(code)
        const cachedPack = await store.loadPack(eventId)
        const queued = await store.queueFor(eventId)
        const decision = decideOffline({ valid: true, code }, codeHash, cachedPack, queued)
        if (decision.enqueue) {
          await store.enqueue({
            id: crypto.randomUUID(),
            eventId,
            code,
            codeHash,
            scannedAt: new Date().toISOString(),
            verdictAtScan: decision.enqueue,
          })
          setQueueCount(queued.length + 1)
        }
        // decideOffline never returns 'invalid' for a valid input, so this
        // cast is the union narrowing the reducer already understands.
        return decision.verdict as ScanVerdict
      } catch {
        storeRef.current = null
        setStoreUnavailable(true)
        return { kind: 'refused', message: ARMING_UNAVAILABLE_SENTENCE }
      }
    },
    [eventId],
  )

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
        // Last-resort net around the whole computation: while a flight is
        // pending the reducer starts nothing new, so a throw that never lands
        // a verdict would wedge the door on "Checking…" until reload.
        try {
          // Local first: the signature proves the QR was issued for this event,
          // so a random poster's QR never costs a server round-trip.
          const verified = await verifyQrPayload(eventKeyFromHex(eventKeyHex), payload)
          if (!verified.valid) {
            verdict = { kind: 'invalid', reason: verified.reason }
          } else if (!navigator.onLine) {
            verdict = await offlineVerdict(verified.code)
          } else {
            try {
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
            } catch {
              // The network dying mid-call. This used to be a dead-end "rescan";
              // now it is the door going offline mid-scan: same path as no
              // signal, so the scan still lands somewhere durable.
              verdict = await offlineVerdict(verified.code)
            }
          }
        } catch {
          verdict = { kind: 'refused', message: RESCAN_SENTENCE }
        }
        dispatch({ type: 'verdict', payload, verdict })
      })()
    },
    [eventId, eventKeyHex, offlineVerdict],
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
      <div className="border-line mb-4 border p-3 text-[13px]">
        {pack ? (
          <p>
            Roster as of {formatIst(new Date(pack.generatedAt))} · {pack.tickets.length} tickets ·{' '}
            {pack.tickets.filter((t) => t.checkedInAt !== null).length} in
            <button type="button" onClick={() => void arm()} className="ml-2 font-mono underline">
              Refresh
            </button>
          </p>
        ) : (
          <p className="text-muted">Roster not cached yet — it loads while you have signal.</p>
        )}
        {storeUnavailable && <p className="text-muted mt-1">{ARMING_UNAVAILABLE_SENTENCE}</p>}
        {queueCount > 0 && (
          <p className="mt-1 font-medium">
            {queueCount} scan{queueCount === 1 ? '' : 's'} pending sync
          </p>
        )}
      </div>
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
      {report.length > 0 && (
        <div className="border-line mt-6 border p-3">
          <p className="text-[13px] font-medium">Synced this session</p>
          <ul className="mt-1 space-y-1 text-[13px]">
            {report.map((line) => (
              <li key={line.entryId}>
                {line.result.status === 'refused'
                  ? `Scanned ${formatIst(new Date(line.scannedAt))} — refused: ${line.result.message}`
                  : line.result.status === 'already_checked_in'
                    ? `${line.result.attendeeName ?? 'Guest'} — scanned here ${formatIst(new Date(line.scannedAt))} · already in at ${formatIst(new Date(line.result.checkedInAt))}`
                    : `${line.result.attendeeName ?? 'Guest'} — in (scanned ${formatIst(new Date(line.scannedAt))})`}
              </li>
            ))}
          </ul>
        </div>
      )}
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
    case 'queued':
      return (
        <div className="rounded-md bg-green-100 p-4 text-green-800">
          <p className="text-2xl font-semibold">{verdict.name ?? 'Guest'}</p>
          <p className="mt-1 text-[15px]">
            {verdict.ticketsIn} of {verdict.ticketsTotal} in · offline, will sync
          </p>
        </div>
      )
    case 'queued_unlisted':
      return (
        <div className="rounded-md bg-amber-50 p-4 text-amber-800">
          <p className="text-lg font-medium">{NOT_ON_ROSTER_SENTENCE}</p>
          {verdict.rosterAsOf && (
            <p className="mt-1 text-[13px]">
              Roster as of {formatIst(new Date(verdict.rosterAsOf))}
            </p>
          )}
        </div>
      )
    case 'already_queued':
      return (
        <div className="rounded-md bg-amber-50 p-4 text-amber-800">
          <p className="text-2xl font-semibold">{verdict.name ?? 'Guest'}</p>
          <p className="mt-1 text-[15px]">
            Already scanned here · {formatIst(new Date(verdict.scannedAt))} · pending sync
          </p>
        </div>
      )
  }
}
