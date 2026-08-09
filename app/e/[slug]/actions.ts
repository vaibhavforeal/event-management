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

  // Two routes carry this ticket type's reserved_count, and it has just moved:
  // this event's page, which paints "N of 12 seats left", and the feed, which
  // selects reserved_count in FEED_COLUMNS (lib/events/queries.ts) but does not
  // paint it — app/_components/event-card.tsx renders date, title, venue and
  // price and no count. So the second call corrects a stale payload rather than
  // a stale number, and is what keeps a "seats left" line safe to add to the
  // card later.
  //
  // What neither call is for, in order of how tempting the wrong answer is:
  //
  //  1. Server staleness. Every page here is dynamically rendered, because
  //     lib/supabase/server.ts awaits cookies() on every query path, so a fresh
  //     request always reads the truth. Do not "fix" a count that looks stale
  //     by reaching for `export const revalidate` — there is no server cache
  //     here for it to tune.
  //  2. Next's client Router Cache, as things stand. `staleTimes.dynamic`
  //     defaults to 0, "not cached", since Next 15 — see
  //     node_modules/next/dist/docs/01-app/03-api-reference/05-config/
  //     01-next-config-js/staleTimes.md — and this app sets no
  //     `experimental.staleTimes`, so dynamic segments are not held client-side
  //     and a Back already refetches. Measured rather than assumed: with these
  //     calls disabled, booking and pressing Back still showed the moved count.
  //
  // They are kept because they cost nothing and are the only thing between a
  // raised staleTimes — or a route that stops being dynamic — and a seat count
  // that lies on Back. publishEvent and unpublishEvent revalidate '/' already.
  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`)
  revalidatePath('/')
  redirect(`/bookings/${result.reference}`)
}
