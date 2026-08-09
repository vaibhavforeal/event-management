'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { currentCaller } from '@/lib/bookings/caller'
import { bookFreeTickets } from '@/lib/bookings/service'
import { loginPath } from '@/lib/auth/session'

export interface BookState {
  error?: string
}

/**
 * Note what this does not read from the form: who is booking. That comes from
 * currentCaller() and cannot come from anywhere else — see lib/bookings/caller.ts.
 */
export async function bookEvent(_previous: BookState, formData: FormData): Promise<BookState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const ticketTypeId = String(formData.get('ticketTypeId') ?? '')
  if (!ticketTypeId) return { error: 'Something went wrong. Reload the page and try again.' }

  // Parsed rather than trusted: the picker offers 1..max_per_order, but a
  // handcrafted POST is not obliged to. reserve_tickets enforces the real cap;
  // this only keeps a non-number from reaching Postgres as `NaN`.
  const quantity = Number(formData.get('quantity'))
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'Choose how many seats you need.' }
  }

  // The only name the host will ever see: profiles are unreadable to them and
  // full_name is null for everyone. Capped here as well as by maxLength on the
  // input, which a handcrafted POST ignores.
  const attendeeName = String(formData.get('attendeeName') ?? '').trim().slice(0, 80)
  if (!attendeeName) return { error: 'Tell the host who to expect.' }

  const result = await bookFreeTickets(caller, ticketTypeId, quantity, attendeeName)
  if (!result.ok) return { error: result.error }

  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`) // the seats-left count just moved
  redirect(`/bookings/${result.reference}`)
}
