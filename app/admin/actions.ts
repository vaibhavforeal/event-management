'use server'

import { revalidatePath } from 'next/cache'
import { listSettleableEvents } from '@/lib/payouts/queries'
import { recordPayout } from '@/lib/payouts/service'

export interface RecordPayoutState {
  error?: string
  ok?: boolean
}

export async function recordPayoutAction(
  _previous: RecordPayoutState,
  formData: FormData,
): Promise<RecordPayoutState> {
  const eventId = String(formData.get('eventId') ?? '')
  const status = String(formData.get('status') ?? '')
  const utr = String(formData.get('utr') ?? '').trim()
  const notes = String(formData.get('notes') ?? '').trim()

  if (status !== 'paid' && status !== 'on_hold') {
    return { error: 'A payout is recorded as paid or on hold.' }
  }
  if (status === 'paid' && utr === '') {
    return { error: 'A settled payout needs its bank reference.' }
  }

  // The amounts are RECOMPUTED here and never read from the form. A hidden
  // input is a number of the sender's choosing; this is a number the server
  // derived from the booking rows a moment ago. Same posture as the attendees
  // actions, which take ids from a form and authorisation from nowhere near it.
  //
  // This also re-runs the RLS-scoped read, so a non-admin finds no event and is
  // refused here before record_payout ever refuses them in SQL.
  const settleable = await listSettleableEvents()
  const event = settleable.find((row) => row.eventId === eventId)
  if (!event) return { error: 'That event is not settleable.' }

  const result = await recordPayout({
    eventId,
    grossPaise: event.statement.grossPaise,
    commissionPaise: event.statement.commissionPaise,
    forfeitedPaise: event.statement.forfeitedPaise,
    status,
    utrReference: status === 'paid' ? utr : null,
    notes: notes === '' ? null : notes,
  })
  if (!result.ok) return { error: result.error }

  revalidatePath('/admin')
  revalidatePath('/host/payouts')
  return { ok: true }
}
