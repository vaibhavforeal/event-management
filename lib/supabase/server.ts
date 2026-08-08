import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { clientEnv } from '@/lib/env'
import type { Database } from '@/lib/supabase/types'

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * Acts as the signed-in user and is subject to RLS.
 *
 * `cookies()` is async as of Next.js 16, so this must be awaited.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Server Components cannot set cookies. Safe to ignore: proxy.ts
            // refreshes the session on every request, so the cookie is already
            // current by the time a Server Component reads it.
          }
        },
      },
    },
  )
}
