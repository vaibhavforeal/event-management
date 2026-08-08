import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { anonClient, userClient } from './db'

/**
 * Lets a test call the real functions in lib/events/queries.ts.
 *
 * Those functions reach the database through one seam —
 * `@/lib/supabase/server#createClient` — so that seam is the only thing mocked.
 * Everything below it is real: a real PostgREST client, carrying a real JWT for
 * the chosen user, hitting the real local Postgres under real RLS. Re-issuing
 * equivalent queries in the test instead would pass happily while queries.ts was
 * missing a filter, which is the class of bug this suite exists to catch.
 *
 * IMPORTING THIS MODULE INSTALLS THE MOCK. There is nothing to call — the
 * vi.mock below is hoisted above the imports and runs on import, for every file
 * that takes anything from here.
 *
 * The consequence, which is easy to get wrong: a test file must pull in the
 * module under test with a top-level `await import(...)`, never a static import.
 * Static imports are evaluated before this module's body, so the module under
 * test would bind the real @/lib/supabase/server, signInAs() would stop having
 * any effect, and every RLS assertion in the file would quietly pass against
 * whatever session the real client happened to have (none).
 *
 *   import { signInAs } from '@/tests/helpers/session'
 *   const { listHostEvents } = await import('@/lib/events/queries')
 */

let currentUserId: string | null = null

/** Who subsequent createClient() calls act as. null means signed out. */
export function signInAs(userId: string | null): void {
  currentUserId = userId
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async (): Promise<SupabaseClient> =>
    currentUserId ? userClient(currentUserId) : anonClient(),
}))
