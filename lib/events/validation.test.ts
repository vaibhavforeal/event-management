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
