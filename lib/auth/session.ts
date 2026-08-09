import 'server-only'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { PATHNAME_HEADER, safeNextPath } from '@/lib/auth/next-path'

/**
 * Always getUser(), never getSession(): getSession() trusts the cookie without
 * revalidating it, which makes it useless as an authorization check.
 */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user ?? null
}

/** Redirects to /login when signed out. Never returns null. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser()
  if (!user) redirect(await loginPath())
  return user
}

/**
 * `/login`, carrying where the visitor was headed when that is safe to say.
 *
 * Without the `?next=`, a host who taps their own edit link while signed out
 * signs in and lands on the feed — the page they actually asked for is two
 * navigations behind them, and nothing on screen says so.
 *
 * Exported for the Server Actions, which reach the same dead end by a different
 * route: a session that expired while the form sat open. An action posts to the
 * URL of the page it was submitted from, so the header holds that page.
 */
export async function loginPath(): Promise<string> {
  const next = safeNextPath((await headers()).get(PATHNAME_HEADER))
  return next ? `/login?next=${encodeURIComponent(next)}` : '/login'
}
