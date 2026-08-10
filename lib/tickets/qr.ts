import 'server-only'
import QRCode from 'qrcode'
import { buildQrPayload, deriveEventKey } from '@/lib/tickets/signing'

/**
 * The QR an attendee holds up at the door.
 *
 * Server-only on purpose: building a payload requires the per-event key, which
 * requires the root secret, and neither may reach an attendee's browser. The
 * page embeds the finished SVG; the only secret-derived thing in it is the
 * 80-bit signature inside the payload, which is exactly what a QR is for.
 */

/** The signed payload string — split out so a test can verify the round trip. */
export async function ticketQrPayload(
  rootSecret: string,
  eventId: string,
  code: string,
): Promise<string> {
  const key = await deriveEventKey(rootSecret, eventId)
  return buildQrPayload(key, code)
}

/** The payload as an SVG. Margin 1 module; the page supplies visual padding. */
export async function ticketQrSvg(
  rootSecret: string,
  eventId: string,
  code: string,
): Promise<string> {
  const payload = await ticketQrPayload(rootSecret, eventId, code)
  return QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
}
