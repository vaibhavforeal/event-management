/**
 * Ticket QR signing.
 *
 * Threat model: an attendee should not be able to manufacture a valid ticket,
 * and a host device compromised at one event should not be able to forge
 * tickets for a different event.
 *
 * So keys are derived per event:
 *
 *   eventKey = HMAC(TICKET_SIGNING_SECRET, "event:" + eventId)
 *   signature = HMAC(eventKey, code)[0..10]
 *
 * The host's scanner is handed only the event key for the door it is working,
 * which is what makes offline verification possible without shipping the root
 * secret to a phone.
 *
 * Built on Web Crypto so the identical code runs in Node (server issuance) and
 * in the browser (offline scanning).
 */

const PAYLOAD_VERSION = 'EH1'
const SIGNATURE_BYTES = 10 // 80 bits — forgery-resistant, keeps the QR small

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return new Uint8Array(signature)
}

/**
 * Per-event key. Derived on the server from the root secret, then shipped to
 * the host's scanner for that event only.
 */
export async function deriveEventKey(rootSecret: string, eventId: string): Promise<Uint8Array> {
  if (!rootSecret || rootSecret.length < 32) {
    throw new Error('TICKET_SIGNING_SECRET must be at least 32 characters')
  }
  return hmacSha256(encoder.encode(rootSecret), `event:${eventId}`)
}

/** Hex-encoded event key, for handing to a scanner over the wire. */
export async function deriveEventKeyHex(rootSecret: string, eventId: string): Promise<string> {
  return toHex(await deriveEventKey(rootSecret, eventId))
}

export function eventKeyFromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('event key must be an even-length hex string')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export async function signTicketCode(eventKey: Uint8Array, code: string): Promise<string> {
  const mac = await hmacSha256(eventKey, code)
  return toHex(mac.slice(0, SIGNATURE_BYTES))
}

/** The string that goes into the QR image. */
export async function buildQrPayload(eventKey: Uint8Array, code: string): Promise<string> {
  const signature = await signTicketCode(eventKey, code)
  return `${PAYLOAD_VERSION}.${code}.${signature}`
}

export type VerifyResult =
  | { valid: true; code: string }
  | { valid: false; reason: 'malformed' | 'unsupported_version' | 'bad_signature' }

/**
 * Verifies a scanned payload. Safe to run offline: it proves the QR was issued
 * for this event, but says nothing about whether the ticket is cancelled or
 * already used — the scanner checks its cached list for that.
 */
export async function verifyQrPayload(
  eventKey: Uint8Array,
  payload: string,
): Promise<VerifyResult> {
  const parts = payload.trim().split('.')
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' }
  }

  const [version, code, signature] = parts
  if (version !== PAYLOAD_VERSION) {
    return { valid: false, reason: 'unsupported_version' }
  }
  if (!/^[0-9a-f]{32}$/.test(code)) {
    return { valid: false, reason: 'malformed' }
  }

  const expected = await signTicketCode(eventKey, code)
  if (!timingSafeEqual(expected, signature)) {
    return { valid: false, reason: 'bad_signature' }
  }

  return { valid: true, code }
}

/**
 * Constant-time string comparison. A scanner is a low-value oracle, but leaking
 * signature bytes through timing is free to avoid.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
