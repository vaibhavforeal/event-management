import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * Every booking read, on the RLS-scoped client.
 *
 * Deliberately not in lib/bookings/service.ts. Reads are the half of this
 * feature that RLS still protects — bookings_select_own scopes an attendee to
 * their own rows, and the host policy scopes a host to their own events — so
 * they have no business sharing a module with the service-role writes. Keeping
 * them apart is what makes "which of these bypasses RLS?" answerable by which
 * file you are in.
 */

const BOOKING_COLUMNS =
  'id, reference, quantity, status, created_at, events(slug, title, starts_at, city, venue_name)'

/**
 * The RLS-scoped client, but only if somebody is actually signed in.
 *
 * Every read in this file touches `bookings`, and `bookings` is granted to
 * `authenticated` alone (20260808000003:212) — `anon` has no SELECT on it at
 * all. That is a GRANT, not a policy, and the two fail differently: RLS filters
 * a signed-in caller down to zero rows, while a missing grant makes PostgREST
 * answer 42501 "permission denied for table bookings". So a signed-out read
 * does not come back empty, it throws — measured, not assumed, and it is what
 * the signed-out test in this module's suite caught.
 *
 * Untreated that turns every signed-out visit to a bookings page into a 500
 * where an empty state or a sign-in prompt belongs. Hence the check here, and
 * the null return that each caller turns into its own idea of "nothing".
 *
 * Deliberately an auth check and NOT a rescue of 42501 further down. Catching
 * the error code would swallow the same denial when it happens to a signed-in
 * user — i.e. when a grant has actually been misconfigured — and hand back an
 * empty guest list instead of failing. A host being shown "nobody is coming"
 * for a sold-out event is the exact silent-empty failure this module is
 * written against; a real misconfiguration must still throw loudly.
 *
 * getUser() and not getSession(): it validates the JWT with the auth server
 * rather than trusting whatever the cookie says, which is the difference
 * between a check and a formality.
 */
async function signedInClient(): Promise<SupabaseClient | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user ? supabase : null
}

export interface MyBooking {
  id: string
  reference: string
  quantity: number
  status: string
  created_at: string
  events: {
    slug: string
    title: string
    starts_at: string
    city: string
    venue_name: string | null
  } | null
}

/** The signed-in attendee's bookings, newest first. Empty when signed out. */
export async function listMyBookings(): Promise<MyBooking[]> {
  const supabase = await signedInClient()
  if (!supabase) return []

  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Could not load your bookings: ${error.message}`)
  return (data ?? []) as unknown as MyBooking[]
}

/**
 * One booking by its reference.
 *
 * Scoped by RLS alone, which is the point: the reference is eight characters a
 * host reads aloud at a door, so it will be overheard. It identifies a booking;
 * it does not authorise seeing one.
 *
 * Null when signed out, which is the same answer a stranger gets: holding the
 * reference is not what makes a booking yours to read.
 */
export async function getBookingByReference(reference: string): Promise<MyBooking | null> {
  const supabase = await signedInClient()
  if (!supabase) return null

  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .eq('reference', reference)
    .maybeSingle()

  if (error) throw new Error(`Could not load that booking: ${error.message}`)
  return (data as unknown as MyBooking | null) ?? null
}

export interface EventAttendee {
  id: string
  reference: string
  attendee_name: string | null
  quantity: number
  status: string
  created_at: string
  profiles: { phone: string } | null
}

/**
 * Who is coming to one event, and how to reach them. Empty unless the caller
 * hosts it.
 *
 * Name and phone come from different places and neither is an accident.
 *
 * The name is `bookings.attendee_name` — what the attendee typed when booking.
 * `profiles.full_name` is null for every user who has ever existed, because the
 * signup trigger writes `id` and `phone` and nothing else, so there is no other
 * name to read. A booking-time name is also the right one for a door list: it
 * does not change retroactively when someone edits their profile a month later.
 *
 * The phone is embedded from `profiles`, and only resolves because
 * `profiles_select_for_host` exists. Before that policy this embed returned
 * `null` on every row with no error, because RLS filters rather than refuses —
 * which is the failure mode this whole query is written against.
 */
export async function listEventAttendees(eventId: string): Promise<EventAttendee[]> {
  const supabase = await signedInClient()
  if (!supabase) return [] // signed out is definitionally not hosting it

  const { data, error } = await supabase
    .from('bookings')
    .select('id, reference, attendee_name, quantity, status, created_at, profiles(phone)')
    .eq('event_id', eventId)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Could not load the guest list: ${error.message}`)
  return (data ?? []) as unknown as EventAttendee[]
}
