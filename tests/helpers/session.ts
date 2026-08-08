import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { anonClient, userClient } from './db'

/**
 * Lets a test call the real functions in lib/events/queries.ts.
 *
 * Those functions reach the database through one seam —
 * `@/lib/supabase/server#createClient` — so that seam is the only thing mocked.
 * Everything below it is real: a real PostgREST client, carrying a real JWT for
 * the chosen user, hitting the real local Postgres under real RLS.
 *
 * The alternative — re-issuing equivalent queries in the test — would pass
 * happily while queries.ts was missing a filter, which is exactly the class of
 * bug this suite exists to catch.
 */

let currentUserId: string | null = null

/** Who subsequent createClient() calls act as. null means signed out. */
export function signInAs(userId: string | null): void {
  currentUserId = userId
}

/**
 * Call at the top level of a test file, before importing the module under test.
 * vi.mock is hoisted, so the factory must not close over anything but the
 * mutable module-scope variable above.
 */
export function mockSupabaseSession(): void {
  vi.mock('@/lib/supabase/server', () => ({
    createClient: async (): Promise<SupabaseClient> =>
      currentUserId ? userClient(currentUserId) : anonClient(),
  }))
}
