import { describe, expect, it } from 'vitest'
import { deriveEventKey, verifyQrPayload } from '@/lib/tickets/signing'
import { ticketQrPayload, ticketQrSvg } from '@/lib/tickets/qr'

const SECRET = 's'.repeat(64)
const EVENT = '00000000-0000-4000-8000-0000000000e1'
const CODE = 'a'.repeat(32)

describe('ticketQrSvg', () => {
  it('renders an SVG', async () => {
    const svg = await ticketQrSvg(SECRET, EVENT, CODE)
    expect(svg.trimStart()).toMatch(/^<svg/)
  })

  it('encodes a payload that verifies under the same event key and fails under another', async () => {
    // The QR content is not inspectable from the SVG, so prove the pipeline by
    // construction: the payload the module builds must round-trip through
    // verifyQrPayload. This is the whole security property the page relies on.
    const key = await deriveEventKey(SECRET, EVENT)
    const payload = await ticketQrPayload(SECRET, EVENT, CODE)
    expect(await verifyQrPayload(key, payload)).toEqual({ valid: true, code: CODE })
    const otherKey = await deriveEventKey(SECRET, '00000000-0000-4000-8000-0000000000e2')
    expect(await verifyQrPayload(otherKey, payload)).toEqual({ valid: false, reason: 'bad_signature' })
  })
})
