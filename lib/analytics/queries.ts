import 'server-only'
import type { BusinessSnapshot } from '@/lib/analytics/rates'
import { createClient } from '@/lib/supabase/server'

/**
 * The one read for the operator's numbers, through the ordinary session
 * client — the database answers the admin question (EH071), not this file.
 * A failed read THROWS: the console fails to render rather than showing
 * wrong business numbers. Same ruling as every money read since 6a.
 */
export async function businessSnapshot(): Promise<BusinessSnapshot> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_business_snapshot')
  if (error) throw new Error(`Failed to read the business snapshot: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as BusinessSnapshot | undefined
  if (!row) throw new Error('Failed to read the business snapshot: no row came back')
  return row
}
