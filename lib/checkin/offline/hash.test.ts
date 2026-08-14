import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hash'

describe('sha256Hex', () => {
  it('matches the published SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is stable for a 32-hex ticket code shape', async () => {
    const code = 'a'.repeat(32)
    expect(await sha256Hex(code)).toBe(await sha256Hex(code))
    expect(await sha256Hex(code)).toMatch(/^[0-9a-f]{64}$/)
  })
})
