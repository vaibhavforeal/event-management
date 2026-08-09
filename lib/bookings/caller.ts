import 'server-only'
import { getCurrentUser } from '@/lib/auth/session'

declare const verified: unique symbol

/**
 * A user id that provably came from a validated session.
 *
 * This phase writes bookings as the service role, because `bookings` and
 * `tickets` are deliberately not writable by `authenticated`. RLS therefore
 * does not scope these writes, and every authorisation decision is ours to
 * make in TypeScript.
 *
 * The brand is what stops that being a matter of remembering. `bookFreeTickets`
 * takes a Caller, `verified` is not exported, and nothing here turns a string
 * into one — so `bookFreeTickets(formData.get('attendeeId'), …)` is a compile
 * error rather than an attacker booking under someone else's name. Identity can
 * only originate below.
 */
export type Caller = { readonly id: string; readonly [verified]: true }

/** The only way to obtain a Caller. Null when signed out. */
export async function currentCaller(): Promise<Caller | null> {
  const user = await getCurrentUser()
  return user ? ({ id: user.id } as Caller) : null
}
