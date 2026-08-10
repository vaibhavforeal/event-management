import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapPaymentRpcError } from '@/lib/payments/rpc-errors'

function rpcError(code: string, message = 'raw database sentence'): PostgrestError {
  return { code, message, details: '', hint: '', name: 'PostgrestError' } as PostgrestError
}

describe('mapPaymentRpcError', () => {
  it.each([
    ['EH030', 'This event is free — book it without paying.'],
    ['EH031', 'This host approves guests before booking, which is not available yet.'],
    ['EH032', 'This event has already started.'],
    ['EH033', 'You have already booked this event. Cancel that booking first to change it.'],
  ])('%s becomes a sentence', (code, sentence) => {
    expect(mapPaymentRpcError(rpcError(code))).toBe(sentence)
  })

  it('passes reserve_tickets refusals through unchanged', () => {
    expect(mapPaymentRpcError(rpcError('23514', 'only 3 seats remain'))).toBe('only 3 seats remain')
  })
})
