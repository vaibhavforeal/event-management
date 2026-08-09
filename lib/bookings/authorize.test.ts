import { describe, expect, it } from 'vitest'
import { mayCancel } from '@/lib/bookings/authorize'
import type { Caller } from '@/lib/bookings/caller'

/**
 * Tests are the one place a Caller is fabricated. Application code cannot do
 * this — the brand is not exported — which is the entire point of the type.
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

  it('refuses an empty caller id even against empty booking fields', () => {
    // Defensive. Without the guard, a caller whose id failed to resolve to a
    // string matches a booking whose columns also came back empty, and two
    // absent identities compare equal — a refusal that reads as an approval.
    expect(mayCancel(callerOf(''), { attendee_id: '', event_host_profile_id: '' })).toBe(false)
  })
})
