import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapCheckinRpcError } from '@/lib/checkin/rpc-errors'

const err = (code: string, message = 'raw database text'): PostgrestError =>
  ({ code, message, details: '', hint: '', name: 'PostgrestError' }) as PostgrestError

describe('mapCheckinRpcError', () => {
  it('maps EH020 without distinguishing wrong-event from cancelled', () => {
    expect(mapCheckinRpcError(err('EH020'))).toBe(
      'No such ticket for this event. It may be for a different event, or its booking was cancelled.',
    )
  })
  it('maps EH021', () => {
    expect(mapCheckinRpcError(err('EH021'))).toBe('This booking is not confirmed.')
  })
  it('maps EH022', () => {
    expect(mapCheckinRpcError(err('EH022'))).toBe('All seats on this booking are already checked in.')
  })
  it('passes anything else through as its own message', () => {
    expect(mapCheckinRpcError(err('23505', 'duplicate key'))).toBe('duplicate key')
  })
})
