import { describe, expect, it } from 'vitest'
import {
  formatIst,
  formatIstDateOnly,
  hasEnded,
  hasStarted,
  istLocalToUtc,
  utcToIstLocal,
} from '@/lib/events/datetime'

describe('istLocalToUtc', () => {
  it('subtracts the 5:30 offset', () => {
    expect(istLocalToUtc('2026-08-15T19:30').toISOString()).toBe('2026-08-15T14:00:00.000Z')
  })

  it('uses the same offset in January as in July', () => {
    // India observes no DST. If these differ, the implementation is reading the
    // host machine's zone instead of Asia/Kolkata — which is the exact bug that
    // makes every event 5.5 hours wrong once deployed to a UTC server.
    const jan = istLocalToUtc('2026-01-15T19:30')
    const jul = istLocalToUtc('2026-07-15T19:30')
    expect(jan.toISOString()).toBe('2026-01-15T14:00:00.000Z')
    expect(jul.toISOString()).toBe('2026-07-15T14:00:00.000Z')
  })

  it('rolls back across midnight', () => {
    expect(istLocalToUtc('2026-08-15T04:00').toISOString()).toBe('2026-08-14T22:30:00.000Z')
  })

  it('rejects a value that is not a datetime-local string', () => {
    expect(() => istLocalToUtc('2026-08-15')).toThrow(RangeError)
    expect(() => istLocalToUtc('')).toThrow(RangeError)
    expect(() => istLocalToUtc('2026-08-15T19:30:00Z')).toThrow(RangeError)
  })
})

describe('utcToIstLocal', () => {
  it('round-trips with istLocalToUtc', () => {
    const local = '2026-08-15T19:30'
    expect(utcToIstLocal(istLocalToUtc(local))).toBe(local)
  })

  it('produces a value a datetime-local input accepts', () => {
    expect(utcToIstLocal(new Date('2026-08-15T14:00:00.000Z'))).toBe('2026-08-15T19:30')
  })
})

describe('formatIst', () => {
  it('renders in IST regardless of the machine zone', () => {
    const text = formatIst(new Date('2026-08-15T14:00:00.000Z'))
    expect(text).toContain('7:30')
    expect(text).toContain('Aug')
  })
})

describe('formatIstDateOnly', () => {
  it('reports the IST calendar day, not the UTC one', () => {
    // 20:00 UTC on Sat 15 Aug is 01:30 IST on Sun 16 Aug. The two zones disagree
    // about the date, so a formatter that lost its timeZone pin renders
    // "Sat, 15 Aug" here — a whole day early on the listing page.
    expect(formatIstDateOnly(new Date('2026-08-15T20:00:00.000Z'))).toBe('Sun, 16 Aug')
  })
})

describe('hasStarted', () => {
  const now = new Date('2026-08-15T14:00:00.000Z')

  it('is false for an event still ahead of the clock', () => {
    expect(hasStarted('2026-08-15T14:00:00.001Z', now)).toBe(false)
  })

  it('is true once the start time has arrived', () => {
    // Inclusive, matching book_free_tickets: an event that starts exactly now is
    // not one a stranger should still be joining.
    expect(hasStarted('2026-08-15T14:00:00.000Z', now)).toBe(true)
    expect(hasStarted('2026-08-15T13:59:59.999Z', now)).toBe(true)
  })

  it('treats an unreadable start time as started', () => {
    // Fails closed. `NaN <= anything` is false, so a naive comparison would call
    // this "not started" and offer a Book button for an event whose date nobody
    // can read.
    expect(hasStarted('nonsense', now)).toBe(true)
    expect(hasStarted('', now)).toBe(true)
  })

  it('treats an unreadable clock as started too', () => {
    // The other side of the same comparison. `anything <= NaN` is also false, so
    // an Invalid Date handed in as `now` would open the control rather than
    // close it — the opposite of what the branch above is for.
    expect(hasStarted('2026-08-15T14:00:00.001Z', new Date('nonsense'))).toBe(true)
    expect(hasStarted('2026-08-15T13:00:00.000Z', new Date(NaN))).toBe(true)
  })

  it('reads the real clock when none is given', () => {
    expect(hasStarted(new Date(Date.now() - 60_000).toISOString())).toBe(true)
    expect(hasStarted(new Date(Date.now() + 60_000).toISOString())).toBe(false)
  })
})

describe('hasEnded', () => {
  const now = new Date('2026-08-15T14:00:00.000Z')

  it('is false for an event whose end is still ahead', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', '2026-08-15T14:00:00.001Z', now)).toBe(false)
  })

  it('is true once the end is behind us', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', '2026-08-15T13:59:59.999Z', now)).toBe(true)
  })

  it('is false at the exact end instant — "ended" means strictly past', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', '2026-08-15T14:00:00.000Z', now)).toBe(false)
  })

  it('falls back to starts_at when the event carries no end time', () => {
    // ends_at is nullable, and without this fallback every such host is
    // permanently unpayable and nothing says so.
    expect(hasEnded('2026-08-15T13:00:00.000Z', null, now)).toBe(true)
    expect(hasEnded('2026-08-15T15:00:00.000Z', null, now)).toBe(false)
  })

  it('fails closed on an unreadable time — the OPPOSITE of hasStarted', () => {
    // hasStarted('nonsense') is true: no Book button is the safe answer there.
    // Here the safe answer is refusing to pay, so this must be false. A later
    // reader will be tempted to implement this by calling hasStarted; these two
    // assertions are what stops them.
    expect(hasStarted('nonsense', now)).toBe(true)
    expect(hasEnded('nonsense', null, now)).toBe(false)
    expect(hasEnded('2026-08-15T10:00:00.000Z', 'nonsense', now)).toBe(false)
  })

  it('fails closed on an unreadable clock', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', null, new Date(NaN))).toBe(false)
  })

  it('defaults now to the current time', () => {
    expect(hasEnded(new Date(Date.now() - 60_000).toISOString(), null)).toBe(true)
    expect(hasEnded(new Date(Date.now() + 60_000).toISOString(), null)).toBe(false)
  })
})
