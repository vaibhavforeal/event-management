/**
 * The scanner's session state, pure so the camera loop can stay dumb.
 *
 * The properties the tests pin, in order of what they cost the door if lost:
 * a QR held steady in front of the camera fires 'detected' several times a
 * second and must cost ONE server action; a verdict computed for one payload
 * must never label another; and while one scan is in flight, nothing else
 * gets started — a door admits one person at a time.
 */
export type ScanVerdict =
  | { kind: 'in'; name: string | null; ticketsIn: number; ticketsTotal: number }
  | { kind: 'already'; name: string | null; checkedInAt: string }
  | { kind: 'refused'; message: string }
  | { kind: 'invalid'; reason: 'malformed' | 'unsupported_version' | 'bad_signature' }

export interface ScanSession {
  current: { payload: string; verdict: ScanVerdict | 'pending' } | null
}

export const IDLE: ScanSession = { current: null }

export type ScanEvent =
  | { type: 'detected'; payload: string }
  | { type: 'verdict'; payload: string; verdict: ScanVerdict }
  | { type: 'dismiss' }

export function reduceScan(session: ScanSession, event: ScanEvent): ScanSession {
  switch (event.type) {
    case 'detected': {
      if (session.current) {
        // Same QR still in frame, or a different one while a scan is in
        // flight: either way, not a new scan. Returning the SAME object is
        // what lets the component use identity to skip re-processing.
        if (session.current.payload === event.payload) return session
        if (session.current.verdict === 'pending') return session
      }
      return { current: { payload: event.payload, verdict: 'pending' } }
    }
    case 'verdict': {
      if (session.current?.payload !== event.payload) return session // stale flight
      if (session.current.verdict !== 'pending') return session
      return { current: { payload: event.payload, verdict: event.verdict } }
    }
    case 'dismiss':
      return IDLE
  }
}
