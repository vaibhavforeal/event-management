import 'server-only'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

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
  if (!user) redirect('/login')
  return user
}
