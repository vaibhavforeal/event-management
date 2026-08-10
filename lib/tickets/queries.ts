import 'server-only'
import { createClient } from '@/lib/supabase/server'

/**
 * Every ticket read, on the RLS-scoped client — the mirror of
 * lib/bookings/queries.ts one table down, and under the same warning from that
 * module's header: RLS here is the protection, not the scoping.
 * tickets_select_own and tickets_select_for_host OR together, so "tickets on
 * this booking" is already scoped to a booking the caller may see — the
 * bookingId filter is what makes the answer THIS booking's tickets, and the
 * caller's entitlement to the booking was settled by whoever loaded it
 * (getBookingByReference, which deliberately resolves for the host too).
 */

export interface BookingTicket {
  id: string
  code: string
  checked_in_at: string | null
}

/** Tickets on one booking, oldest first — the order the door admits them in. */
export async function listBookingTickets(bookingId: string): Promise<BookingTicket[]> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  // Signed out reads nothing. tickets has no anon SELECT grant, so without
  // this the query would throw 42501 rather than return zero rows — same
  // grant-versus-policy distinction lib/bookings/queries.ts documents.
  if (!auth.user) return []

  const { data, error } = await supabase
    .from('tickets')
    .select('id, code, checked_in_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true })
    // Tickets issued in one booking share a created_at; the id tiebreak keeps
    // "Ticket 1 of 3" pointing at the same ticket on every render.
    .order('id', { ascending: true })

  if (error) throw new Error(`Could not load the tickets: ${error.message}`)
  return (data ?? []) as BookingTicket[]
}
