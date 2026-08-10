import { describe, expect, it } from 'vitest'
import { IDLE, reduceScan, type ScanVerdict } from './scan-state'

const IN: ScanVerdict = { kind: 'in', name: 'Asha', ticketsIn: 1, ticketsTotal: 2 }

describe('reduceScan', () => {
  it('a detection from idle becomes pending', () => {
    const s = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    expect(s.current).toEqual({ payload: 'EH1.a.b', verdict: 'pending' })
  })

  it('the same payload detected again changes nothing — one QR held up is one scan', () => {
    const s1 = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    const s2 = reduceScan(s1, { type: 'detected', payload: 'EH1.a.b' })
    expect(s2).toBe(s1)
  })

  it('a different payload is ignored while a verdict is pending — one flight at a time', () => {
    const s1 = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    const s2 = reduceScan(s1, { type: 'detected', payload: 'EH1.c.d' })
    expect(s2).toBe(s1)
  })

  it('a verdict lands only on the payload it was computed for', () => {
    const s1 = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    const stale = reduceScan(s1, { type: 'verdict', payload: 'EH1.zzz.q', verdict: IN })
    expect(stale).toBe(s1)
    const landed = reduceScan(s1, { type: 'verdict', payload: 'EH1.a.b', verdict: IN })
    expect(landed.current?.verdict).toEqual(IN)
  })

  it('after a verdict, the same payload still changes nothing, but a new one replaces the card', () => {
    let s = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    s = reduceScan(s, { type: 'verdict', payload: 'EH1.a.b', verdict: IN })
    expect(reduceScan(s, { type: 'detected', payload: 'EH1.a.b' })).toBe(s)
    const next = reduceScan(s, { type: 'detected', payload: 'EH1.c.d' })
    expect(next.current).toEqual({ payload: 'EH1.c.d', verdict: 'pending' })
  })

  it('dismiss clears everything, and the same QR can then be scanned again', () => {
    let s = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    s = reduceScan(s, { type: 'verdict', payload: 'EH1.a.b', verdict: IN })
    s = reduceScan(s, { type: 'dismiss' })
    expect(s).toEqual(IDLE)
    expect(reduceScan(s, { type: 'detected', payload: 'EH1.a.b' }).current?.verdict).toBe('pending')
  })
})
