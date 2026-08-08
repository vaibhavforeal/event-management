import { describe, expect, it } from 'vitest'
import {
  buildQrPayload,
  deriveEventKey,
  deriveEventKeyHex,
  eventKeyFromHex,
  signTicketCode,
  verifyQrPayload,
} from '@/lib/tickets/signing'

const ROOT = 'test-root-secret-that-is-long-enough-to-pass'
const EVENT_A = '11111111-1111-1111-1111-111111111111'
const EVENT_B = '22222222-2222-2222-2222-222222222222'
const CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('event key derivation', () => {
  it('is deterministic', async () => {
    const a = await deriveEventKeyHex(ROOT, EVENT_A)
    const b = await deriveEventKeyHex(ROOT, EVENT_A)
    expect(a).toBe(b)
  })

  it('gives different events different keys', async () => {
    expect(await deriveEventKeyHex(ROOT, EVENT_A)).not.toBe(
      await deriveEventKeyHex(ROOT, EVENT_B),
    )
  })

  it('survives a hex round trip', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)
    const hex = await deriveEventKeyHex(ROOT, EVENT_A)
    expect(Array.from(eventKeyFromHex(hex))).toEqual(Array.from(key))
  })

  it('refuses a weak root secret', async () => {
    await expect(deriveEventKey('short', EVENT_A)).rejects.toThrow(/at least 32/)
  })

  it('rejects malformed hex', () => {
    expect(() => eventKeyFromHex('nothex')).toThrow()
    expect(() => eventKeyFromHex('abc')).toThrow()
  })
})

describe('QR payload', () => {
  it('verifies a payload it just issued', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)
    const payload = await buildQrPayload(key, CODE)

    expect(payload.startsWith('EH1.')).toBe(true)
    expect(await verifyQrPayload(key, payload)).toEqual({ valid: true, code: CODE })
  })

  it('stays short enough to scan reliably', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)
    const payload = await buildQrPayload(key, CODE)
    expect(payload.length).toBeLessThanOrEqual(64)
  })

  it('rejects a ticket minted for a different event', async () => {
    const keyA = await deriveEventKey(ROOT, EVENT_A)
    const keyB = await deriveEventKey(ROOT, EVENT_B)
    const payloadForA = await buildQrPayload(keyA, CODE)

    // This is the property that makes handing an event key to a host's phone
    // safe: that key cannot admit anyone to someone else's event.
    expect(await verifyQrPayload(keyB, payloadForA)).toEqual({
      valid: false,
      reason: 'bad_signature',
    })
  })

  it('rejects a tampered signature', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)
    const payload = await buildQrPayload(key, CODE)
    const tampered = payload.slice(0, -1) + (payload.endsWith('0') ? '1' : '0')

    expect(await verifyQrPayload(key, tampered)).toEqual({
      valid: false,
      reason: 'bad_signature',
    })
  })

  it('rejects a swapped-in ticket code', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)
    const payload = await buildQrPayload(key, CODE)
    const otherCode = 'ffffffffffffffffffffffffffffffff'
    const forged = payload.replace(CODE, otherCode)

    expect(await verifyQrPayload(key, forged)).toEqual({
      valid: false,
      reason: 'bad_signature',
    })
  })

  it('rejects junk a camera might pick up', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)

    expect(await verifyQrPayload(key, 'https://example.com')).toEqual({
      valid: false,
      reason: 'malformed',
    })
    expect(await verifyQrPayload(key, '')).toEqual({ valid: false, reason: 'malformed' })
    expect(await verifyQrPayload(key, 'EH1.nothex.abcdef')).toEqual({
      valid: false,
      reason: 'malformed',
    })
    expect(await verifyQrPayload(key, `EH9.${CODE}.abcdef`)).toEqual({
      valid: false,
      reason: 'unsupported_version',
    })
  })

  it('tolerates whitespace from the scanner', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)
    const payload = await buildQrPayload(key, CODE)
    expect(await verifyQrPayload(key, `  ${payload}\n`)).toEqual({ valid: true, code: CODE })
  })

  it('produces a distinct signature per ticket code', async () => {
    const key = await deriveEventKey(ROOT, EVENT_A)
    const codes = Array.from({ length: 50 }, () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    )
    const signatures = await Promise.all(codes.map((c) => signTicketCode(key, c)))
    expect(new Set(signatures).size).toBe(50)
  })
})
