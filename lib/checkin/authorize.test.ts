import { describe, expect, it } from 'vitest'
import type { Caller } from '@/lib/bookings/caller'
import { mayCheckIn } from '@/lib/checkin/authorize'

const HOST = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const caller = (id: string) => ({ id }) as Caller

describe('mayCheckIn', () => {
  it('allows the host of the event', () => {
    expect(mayCheckIn(caller(HOST), { host_profile_id: HOST })).toBe(true)
  })
  it('refuses anyone else — attendees included; holding a ticket is not hosting', () => {
    expect(mayCheckIn(caller(OTHER), { host_profile_id: HOST })).toBe(false)
  })
  it('never lets two blanks match', () => {
    expect(mayCheckIn(caller(''), { host_profile_id: '' })).toBe(false)
  })
})
