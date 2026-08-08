import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { clientEnv, serverEnv } from '@/lib/env'
import type { Database } from '@/lib/supabase/types'

/**
 * Service-role client. **Bypasses RLS entirely.**
 *
 * Only for trusted server-side entry points that have no user session:
 * payment webhooks, cron jobs, and admin tooling. Never import this from a
 * path a request-scoped user can influence without re-checking authorisation
 * yourself — RLS will not save you here.
 *
 * The `server-only` import makes bundling this into client code a build error.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}
