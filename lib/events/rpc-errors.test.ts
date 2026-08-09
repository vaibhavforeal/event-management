import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapEventRpcError } from '@/lib/events/rpc-errors'

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

describe('mapEventRpcError', () => {
  it('turns EH001 into the blocker a host can act on', () => {
    const state = mapEventRpcError(pgError({ code: 'EH001', details: '12' }), 8)

    // Word for word what the TypeScript pre-check used to return, so a host
    // sees no change and the assertion in actions.test.ts keeps meaning what
    // it meant.
    expect(state.blockers).toEqual([
      '12 of those seats are already taken, so capacity cannot go down to 8',
    ])
    expect(state.error).toBeUndefined()
  })

  it('puts oversell in blockers, never in error', () => {
    // The form renders the two differently: blockers are a fixable condition,
    // error is a fault. Collapsing them would show a host a red failure for
    // something they can correct by typing a bigger number.
    const state = mapEventRpcError(pgError({ code: 'EH001', details: '3' }), 1)
    expect(state.error).toBeUndefined()
    expect(state.blockers).toHaveLength(1)
  })

  it('turns EH002 into the ownership refusal', () => {
    const state = mapEventRpcError(pgError({ code: 'EH002' }), 20)
    expect(state).toEqual({ error: 'That event is not yours to edit' })
  })

  it('passes an unrecognised error through by message', () => {
    const state = mapEventRpcError(
      pgError({ code: '23514', message: 'new row violates check constraint' }),
      20,
    )
    expect(state).toEqual({ error: 'new row violates check constraint' })
  })

  it('does not print "null" when EH001 arrives without a detail', () => {
    // Defensive: if DETAIL is ever dropped in transit the host must still get a
    // sentence, not "null of those seats are already taken".
    const state = mapEventRpcError(pgError({ code: 'EH001', details: '' }), 8)
    expect(state.blockers![0]).toBe('Some of those seats are already taken, so capacity cannot go down to 8')
  })

  it('handles EH001 arriving with details: null (the real wire shape)', () => {
    // PostgrestError.details is typed as string, but at runtime EH002 arrives with
    // details: null. The optional chaining in mapEventRpcError holds it null-safe;
    // this test pins that behavior against future refactors that might delete the `?.`
    const state = mapEventRpcError(pgError({ code: 'EH001', details: null as unknown as string }), 8)
    expect(state.blockers![0]).toBe('Some of those seats are already taken, so capacity cannot go down to 8')
  })
})
