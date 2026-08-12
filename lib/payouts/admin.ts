import 'server-only'
import { notFound } from 'next/navigation'
import { isPlatformAdmin } from '@/lib/payouts/queries'

/**
 * The route segment's gate.
 *
 * notFound() rather than a 403: whether a settlement console exists is not
 * something an unauthorised visitor needs confirmed. The database refuses them
 * anyway — every read behind this is RLS-scoped and every write is gated in
 * SQL — so this decides what the page LOOKS like, not what it may touch.
 */
export async function requirePlatformAdmin(): Promise<void> {
  if (!(await isPlatformAdmin())) notFound()
}
