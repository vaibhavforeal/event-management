import { describe, expect, it } from 'vitest'
import { parseEventForm, validateForPublish } from '@/lib/events/validation'

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string> = {
    title: 'Diwali Supper Club',
    city: 'Indore',
    startsAtLocal: '2026-11-14T19:30',
    seats: '20',
    priceRupees: '500',
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== '') fd.set(key, value)
  }
  return fd
}

/** Throws rather than returning, so a test can never pass by not asserting. */
function errorsFor(overrides: Record<string, string>): Record<string, string> {
  const result = parseEventForm(form(overrides))
  if (result.success) throw new Error('expected the form to be rejected, but it parsed')
  return result.fieldErrors
}

describe('parseEventForm', () => {
  it('accepts the minimum the database requires', () => {
    const result = parseEventForm(form())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.title).toBe('Diwali Supper Club')
      expect(result.data.seats).toBe(20)
      expect(result.data.priceRupees).toBe(500)
    }
  })

  it('rejects a title shorter than the schema CHECK allows', () => {
    const result = parseEventForm(form({ title: 'ab' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.title).toBeTruthy()
  })

  it('rejects a missing city, because the column is NOT NULL', () => {
    const result = parseEventForm(form({ city: '' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.city).toBeTruthy()
  })

  it('rejects a missing start time, because the column is NOT NULL', () => {
    const result = parseEventForm(form({ startsAtLocal: '' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.startsAtLocal).toBeTruthy()
  })

  it('rejects zero or negative seats', () => {
    expect(parseEventForm(form({ seats: '0' })).success).toBe(false)
    expect(parseEventForm(form({ seats: '-3' })).success).toBe(false)
  })

  it('accepts a free event at zero rupees', () => {
    expect(parseEventForm(form({ priceRupees: '0' })).success).toBe(true)
  })

  it('accepts a fractional price', () => {
    const result = parseEventForm(form({ priceRupees: '499.99' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.priceRupees).toBeCloseTo(499.99)
  })

  it('rejects an end time before the start time', () => {
    const result = parseEventForm(
      form({ startsAtLocal: '2026-11-14T19:30', endsAtLocal: '2026-11-14T18:00' }),
    )
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.endsAtLocal).toBeTruthy()
  })

  it('reads unchecked toggles as false', () => {
    const result = parseEventForm(form())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requiresApproval).toBe(false)
      expect(result.data.allowsCash).toBe(false)
    }
  })

  it('reads a checked toggle as true', () => {
    const result = parseEventForm(form({ requiresApproval: 'on' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.requiresApproval).toBe(true)
  })

  it('reads the hide-venue toggle in both positions', () => {
    const off = parseEventForm(form())
    expect(off.success).toBe(true)
    if (off.success) expect(off.data.hideVenueUntilApproved).toBe(false)

    const on = parseEventForm(form({ hideVenueUntilApproved: 'on' }))
    expect(on.success).toBe(true)
    if (on.success) expect(on.data.hideVenueUntilApproved).toBe(true)
  })

  it('explains a non-numeric seats entry in words a host can act on', () => {
    // A number input constrains the browser widget; a form POST is not bound by it.
    expect(errorsFor({ seats: 'abc' }).seats).toBe('Seats must be a whole number')
  })

  it('explains a non-numeric price in words a host can act on', () => {
    expect(errorsFor({ priceRupees: 'abc' }).priceRupees).toBe('Price must be a number')
  })

  it('still reports the per-rule message, not the type-level one', () => {
    expect(errorsFor({ seats: '0' }).seats).toBe('You need at least one seat')
    expect(errorsFor({ seats: '2.5' }).seats).toBe('Seats must be a whole number')
    expect(errorsFor({ priceRupees: '-1' }).priceRupees).toBe('Price cannot be negative')
  })

  it('accepts a valid cover image link', () => {
    const result = parseEventForm(form({ coverImageUrl: 'https://example.com/poster.jpg' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.coverImageUrl).toBe('https://example.com/poster.jpg')
  })

  it('rejects a cover image link that is not a URL', () => {
    expect(errorsFor({ coverImageUrl: 'poster.jpg' }).coverImageUrl).toBeTruthy()
  })

  it('rejects a title longer than the schema CHECK allows', () => {
    expect(parseEventForm(form({ title: 'x'.repeat(140) })).success).toBe(true)
    expect(errorsFor({ title: 'x'.repeat(141) }).title).toBe('Keep the name under 140 characters')
  })
})

describe('validateForPublish', () => {
  const now = new Date('2026-08-08T00:00:00.000Z')
  const complete = {
    title: 'Diwali Supper Club',
    city: 'Indore',
    venue_name: 'The Terrace',
    starts_at: '2026-11-14T14:00:00.000Z',
    ticketTypes: [{ quantity: 20 }],
  }

  it('passes a complete event', () => {
    expect(validateForPublish(complete, now)).toEqual([])
  })

  it('blocks a missing venue', () => {
    const blockers = validateForPublish({ ...complete, venue_name: null }, now)
    expect(blockers.map((b) => b.field)).toContain('venue_name')
  })

  it('blocks a start time in the past', () => {
    const blockers = validateForPublish({ ...complete, starts_at: '2026-01-01T00:00:00.000Z' }, now)
    expect(blockers.map((b) => b.field)).toContain('starts_at')
  })

  it('blocks a start time it cannot read as a date', () => {
    // Fails closed: an unreadable date must not slip past the gate just because
    // NaN comparisons are false.
    const blockers = validateForPublish({ ...complete, starts_at: 'not-a-date' }, now)
    expect(blockers.map((b) => b.field)).toContain('starts_at')
  })

  it('blocks an event with no seats', () => {
    const blockers = validateForPublish({ ...complete, ticketTypes: [] }, now)
    expect(blockers.map((b) => b.field)).toContain('seats')
  })

  it('reports every blocker at once, not just the first', () => {
    // The edit page shows all of them together; one-per-attempt would make
    // publishing a guessing game.
    const blockers = validateForPublish(
      { title: null, city: null, venue_name: null, starts_at: '2020-01-01T00:00:00.000Z', ticketTypes: [] },
      now,
    )
    expect(blockers.length).toBeGreaterThanOrEqual(5)
  })
})
