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
 * So the module under test must be evaluated after this one. A top-level
 * `await import(...)` guarantees that, because it runs after every static import
 * regardless of how the import block is ordered — and import blocks get
 * reordered by formatters and by anyone tidying up.
 *
 *   import { signInAs } from '@/tests/helpers/session'
 *   const { listHostEvents } = await import('@/lib/events/queries')
 *
 * Getting the order wrong fails loudly, never silently: too early and the module
 * under test binds the real @/lib/supabase/server, so every test dies on
 * "`cookies` was called outside a request scope" (or, before ./db has run
 * dotenv, on "Invalid client environment" at load). Measured, all three
 * orderings. There is no arrangement that passes while testing the wrong thing.
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
