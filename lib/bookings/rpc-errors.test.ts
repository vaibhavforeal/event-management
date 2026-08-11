import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'

function pgError(overrides: Partial<PostgrestError>): PostgrestError {
  return {
    name: 'PostgrestError',
    message: 'something went wrong',
    details: '',
    hint: '',
    code: 'XX000',
    ...overrides,
  } as PostgrestError
}

describe('mapBookingRpcError', () => {
  it('explains EH010 without naming a column', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH010' }))).toBe(
      'This event is not free yet, so booking has not opened.',
    )
  })

  it('explains EH011 in the host\'s terms', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH011' }))).toBe(
      'This host approves guests before booking, which is not available yet.',
    )
  })

  it('tells an attendee who already booked what to do about it', () => {
    // Not "duplicate key value violates unique constraint". The attendee's
    // next move is in the sentence, because there is a screen for it.
    expect(mapBookingRpcError(pgError({ code: 'EH012' }))).toBe(
      'You have already booked this event. Cancel that booking first to change it.',
    )
  })

  it('explains EH013 without a timestamp', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH013' }))).toBe('This event has already started.')
  })

  it('passes reserve_tickets\' own message through untouched', () => {
    // These are already written for a person: "only 3 seats remain",
    // "sales have closed". Remapping them would lose the number.
    expect(
      mapBookingRpcError(pgError({ code: '23514', message: 'only 3 seats remain' })),
    ).toBe('only 3 seats remain')
  })
})

describe('mapBookingRpcError EH05x', () => {
  it('maps every Phase 5a code to a sentence', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH050' }))).toBe("This event doesn't take requests — book it directly.")
    expect(mapBookingRpcError(pgError({ code: 'EH051' }))).toBe('This event has already started.')
    expect(mapBookingRpcError(pgError({ code: 'EH052' }))).toBe("This event doesn't take cash bookings.")
    expect(mapBookingRpcError(pgError({ code: 'EH053' }))).toBe("That's more seats than this event allows per booking.")
    expect(mapBookingRpcError(pgError({ code: 'EH054' }))).toBe('You have already booked this event. Cancel that booking first to change it.')
    expect(mapBookingRpcError(pgError({ code: 'EH055' }))).toBe('This event has already started.')
    expect(mapBookingRpcError(pgError({ code: 'EH056' }))).toBe('This request was already handled — refresh to see where it stands.')
    expect(mapBookingRpcError(pgError({ code: 'EH057' }))).toBe('This event is free — book it without paying.')
    expect(mapBookingRpcError(pgError({ code: 'EH058' }))).toBe('This host approves guests first — send a request instead.')
    expect(mapBookingRpcError(pgError({ code: 'EH059' }))).toBe('This event has already started.')
  })
  it('passes unmapped refusals through', () => {
    expect(mapBookingRpcError(pgError({ code: '23514', message: 'only 3 seats remain' }))).toBe('only 3 seats remain')
  })
})

describe('mapBookingRpcError EH06x', () => {
  it('maps every Phase 5b code to a sentence', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH060' }))).toBe("This event doesn't keep a waitlist.")
    expect(mapBookingRpcError(pgError({ code: 'EH061' }))).toBe('This event has already started.')
    expect(mapBookingRpcError(pgError({ code: 'EH062' }))).toBe("This event doesn't take cash bookings.")
    expect(mapBookingRpcError(pgError({ code: 'EH063' }))).toBe("That's more seats than this event allows per booking.")
    expect(mapBookingRpcError(pgError({ code: 'EH064' }))).toBe('Seats are open — book instead of joining the waitlist.')
    expect(mapBookingRpcError(pgError({ code: 'EH065' }))).toBe(
      'You have already booked this event. Cancel that booking first to change it.',
    )
  })
})
