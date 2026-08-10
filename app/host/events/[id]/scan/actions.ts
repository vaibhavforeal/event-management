'use server'

import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { checkInTicket, type CheckInResult } from '@/lib/checkin/service'
import { RESCAN_SENTENCE } from '@/lib/checkin/sentences'
import { loginPath } from '@/lib/auth/session'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_PATTERN = /^[0-9a-f]{32}$/

/**
 * The scanner's write. Called imperatively from the client after a local
 * signature check — which the server does NOT rely on: authorisation is the
 * service's host check, and authenticity is the code lookup. A forged-but-
 * well-shaped payload that somehow passed the local verify still admits
 * nobody, because its code matches no row.
 */
export async function checkInByCode(eventId: string, code: string): Promise<CheckInResult> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  if (!UUID_PATTERN.test(eventId) || !CODE_PATTERN.test(code)) {
    // Junk shapes stop here. One sentence, because the scanner's next move is
    // the same regardless: scan again.
    return { ok: false, error: RESCAN_SENTENCE }
  }

  // No revalidatePath, deliberately — unlike checkInAttendee, which mutates
  // the very rows its page is showing. The scanner paints its verdict from
  // this return value, and the guest list re-renders when the host next opens
  // it; there is no cached payload here that just went stale.
  return checkInTicket(caller, eventId, code)
}
