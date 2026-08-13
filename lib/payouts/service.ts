import 'server-only'
import type { PostgrestError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * The one write in this phase.
 *
 * NOT service-role, and that is the point: record_payout is SECURITY DEFINER
 * and gated on is_platform_admin(), so this calls it as the signed-in user and
 * the database decides. Nothing here belongs in the eslint fence, and nothing
 * here may import @/lib/supabase/admin.
 */

export type RecordPayoutResult = { ok: true } | { ok: false; error: string }

export interface RecordPayoutInput {
  eventId: string
  grossPaise: number
  commissionPaise: number
  forfeitedPaise: number
  status: 'paid' | 'on_hold'
  utrReference: string | null
  notes: string | null
}

/** Refusals as sentences an operator can act on. Anything unmapped passes through. */
function refusal(error: PostgrestError): string {
  switch (error.code) {
    case 'EH070':
      return 'This payout is already settled. Its amounts are what left the bank — record the correction in the notes instead.'
    case 'EH071':
      return 'You are not a platform admin.'
    case 'EH072':
      return 'That event no longer exists.'
    case 'EH073':
      return 'This event has not ended yet.'
    case 'EH074':
      return 'A payout is recorded as paid or on hold.'
    case 'EH075':
      return 'A settled payout needs its bank reference.'
    case 'EH077':
      return 'Only a published event can be settled. A cancelled or unpublished event settles by refunding its attendees, not by a payout.'
    default:
      return error.message
  }
}

export async function recordPayout(input: RecordPayoutInput): Promise<RecordPayoutResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('record_payout', {
    p_event_id: input.eventId,
    p_gross_paise: input.grossPaise,
    p_commission_paise: input.commissionPaise,
    p_forfeited_paise: input.forfeitedPaise,
    p_status: input.status,
    p_utr_reference: input.utrReference ?? undefined,
    p_notes: input.notes ?? undefined,
  })
  if (error) return { ok: false, error: refusal(error) }
  return { ok: true }
}
