import { describe, expect, it } from 'vitest'
import { mayCancel, mayApprove } from '@/lib/bookings/authorize'
import type { Caller } from '@/lib/bookings/caller'

/**
 * Tests are the one place a Caller is fabricated, and it takes a cast to do it.
 * That cast is available anywhere, so the brand is not a wall — it is the
 * difference between reaching for identity and passing a string that happened
 * to be to hand. `mayCancel(formData.get('attendeeId'), …)` does not compile;
 * asserting your way past the type is a deliberate act that shows up in review.
 */
function callerOf(id: string): Caller {
  return { id } as Caller
}

const ATTENDEE = '11111111-1111-1111-1111-111111111111'
const HOST = '22222222-2222-2222-2222-222222222222'
const STRANGER = '33333333-3333-3333-3333-333333333333'

const booking = { attendee_id: ATTENDEE, event_host_profile_id: HOST }

describe('mayCancel', () => {
  it('lets the attendee cancel their own booking', () => {
    expect(mayCancel(callerOf(ATTENDEE), booking)).toBe(true)
  })

  it('lets the host of the event cancel it', () => {
    expect(mayCancel(callerOf(HOST), booking)).toBe(true)
  })

  it('refuses everyone else', () => {
    expect(mayCancel(callerOf(STRANGER), booking)).toBe(false)
  })

  it('refuses an empty caller id against a blank booking column', () => {
    // Defensive. Without the guard, a caller whose id failed to resolve to a
    // string matches a booking column that also came back empty, and two absent
    // identities compare equal — a refusal that reads as an approval.
    //
    // One column blanked at a time, never both. Blanking both would pass
    // against a guard that only checked the attendee side, leaving an empty
    // caller still matching a blank host — so the test would be watching the
    // case it was written for and reporting the wrong answer about it.
    expect(mayCancel(callerOf(''), { attendee_id: ATTENDEE, event_host_profile_id: '' })).toBe(false)
    expect(mayCancel(callerOf(''), { attendee_id: '', event_host_profile_id: HOST })).toBe(false)
  })
})

describe('mayApprove', () => {
  const host = { id: 'host-profile' } as unknown as Caller
  const attendee = { id: 'attendee' } as unknown as Caller
  const blank = { id: '' } as unknown as Caller

  it('allows only the host of the event', () => {
    expect(mayApprove(host, { event_host_profile_id: 'host-profile' })).toBe(true)
    expect(mayApprove(attendee, { event_host_profile_id: 'host-profile' })).toBe(false)
  })
  it('never matches an absent id against an absent column', () => {
    expect(mayApprove(blank, { event_host_profile_id: '' })).toBe(false)
  })
})
