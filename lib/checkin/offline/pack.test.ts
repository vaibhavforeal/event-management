import { describe, expect, it } from 'vitest'
import { packIndex, type DoorPack, type PackTicket } from './pack'

function ticket(overrides: Partial<PackTicket>): PackTicket {
  return {
    codeHash: 'h1',
    attendeeName: 'Asha',
    reference: 'ABCD1234',
    bookingId: 'b1',
    checkedInAt: null,
    ticketsTotal: 2,
    ticketsIn: 0,
    ...overrides,
  }
}

describe('packIndex', () => {
  it('indexes tickets by codeHash', () => {
    const pack: DoorPack = {
      eventId: 'e1',
      generatedAt: '2026-08-14T13:32:00Z',
      tickets: [ticket({ codeHash: 'h1' }), ticket({ codeHash: 'h2', attendeeName: 'Ravi' })],
    }
    const index = packIndex(pack)
    expect(index.get('h1')?.attendeeName).toBe('Asha')
    expect(index.get('h2')?.attendeeName).toBe('Ravi')
    expect(index.get('h3')).toBeUndefined()
  })
})
