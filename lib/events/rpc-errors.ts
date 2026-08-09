import type { PostgrestError } from '@supabase/supabase-js'

/**
 * The failure half of EventFormState.
 *
 * Declared here rather than imported from app/host/events/actions.ts, which is
 * a 'use server' module: this one is pure and unit-tested, and importing across
 * that boundary to reach a type would drag a server module into a test that
 * needs no server.
 */
export interface EventRpcFailure {
  error?: string
  blockers?: string[]
}

/** Capacity below reserved_count. DETAIL carries the reserved count. */
const OVERSELL = 'EH001'
/** The event is not the caller's — wrong id, or RLS refused it. */
const NOT_YOURS = 'EH002'

/**
 * Turns a refusal from the event-write functions into something a host can read.
 *
 * The wording is copied verbatim from the TypeScript checks these functions
 * replaced, so moving the logic into Postgres changed no sentence any host has
 * ever seen — and so the assertions in lib/events/actions.test.ts still test the
 * copy rather than being quietly rewritten to match whatever came out.
 *
 * Anything unrecognised falls through to the raw message. That is deliberate:
 * inventing a friendly sentence for an error nobody anticipated hides which one
 * it was, and this is a product whose failures reach a host by way of a form,
 * not a log.
 */
export function mapEventRpcError(error: PostgrestError, seats: number): EventRpcFailure {
  if (error.code === OVERSELL) {
    const reserved = error.details?.trim() || 'Some'
    return {
      blockers: [
        `${reserved} of those seats are already taken, so capacity cannot go down to ${seats}`,
      ],
    }
  }

  if (error.code === NOT_YOURS) return { error: 'That event is not yours to edit' }

  return { error: error.message }
}
