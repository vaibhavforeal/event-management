import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/supabase/types'

/**
 * Every booking read, on the RLS-scoped client.
 *
 * Deliberately not in lib/bookings/service.ts. Reads are the half of this
 * feature that RLS still protects — bookings_select_own scopes an attendee to
 * their own rows, and the host policy scopes a host to their own events — so
 * they have no business sharing a module with the service-role writes. Keeping
 * them apart is what makes "which of these bypasses RLS?" answerable by which
 * file you are in.
 *
 * But RLS being the protection does NOT make it the scoping. Postgres ORs the
 * two SELECT policies on `bookings` (20260808000003:126-130), so "rows this
 * caller may see" is their own bookings UNION every booking on events they
 * host — a union that is right for authorisation and wrong as an answer to
 * either "my bookings" or "my guest list". Anything here that means "mine"
 * therefore filters explicitly and says so, exactly as lib/events/queries.ts
 * does for a host's own events. Same lesson, different table: the day someone
 * both hosts an event and books a ticket, an unfiltered read is not a narrower
 * list, it is a wrong one.
 */

const BOOKING_COLUMNS =
  'id, reference, quantity, status, created_at, total_paise, hold_expires_at, attendee_name, events(id, slug, title, starts_at, city, venue_name, refund_cutoff_hours), payments(provider_order_id, status)'

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
 *
 * Hands back the id along with the client because every caller needs it to
 * filter — see the module comment. One getUser() serves both, so establishing
 * who the caller is and scoping the query to them cannot drift apart or cost a
 * second round trip.
 *
 * `SupabaseClient<Database>` and not a bare `SupabaseClient`: the generic is
 * what createClient() carries, and dropping it turns every table name, column
 * and embed in this file into `any` — silently, with the queries still
 * compiling.
 */
async function signedInClient(): Promise<{
  supabase: SupabaseClient<Database>
  userId: string
} | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user ? { supabase, userId: data.user.id } : null
}

export interface MyBooking {
  id: string
  reference: string
  quantity: number
  status: string
  created_at: string
  total_paise: number
  hold_expires_at: string | null
  attendee_name: string | null
  events: {
    id: string
    slug: string
    title: string
    starts_at: string
    city: string
    venue_name: string | null
    refund_cutoff_hours: number
  } | null
  /**
   * Empty for free bookings, and empty for a host viewing someone else's
   * booking: payments_select_own scopes the embed to the attendee, and RLS
   * filters rather than refuses, so the host simply sees no rows. No branch
   * needed — everything that reads this treats [] as "no payment to show".
   */
  payments: { provider_order_id: string; status: string }[]
}

/**
 * Bookings the caller made themselves, newest first. Empty when signed out.
 *
 * The `attendee_id` filter is the whole meaning of "my", not a narrowing of
 * what RLS already did. bookings_select_for_host also matches here, so without
 * it a host who has booked anything gets their guests' bookings folded into
 * their own list — other people's names, seat counts and references, on a page
 * that says these are yours. Verified by the host-who-is-also-an-attendee test
 * in this module's suite: two rows without this line, one with it.
 */
export async function listMyBookings(): Promise<MyBooking[]> {
  const session = await signedInClient()
  if (!session) return []

  const { data, error } = await session.supabase
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .eq('attendee_id', session.userId)
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
 *
 * Deliberately NOT filtered to the caller's own bookings, unlike
 * listMyBookings. The host-side policy matching here is the point — a host
 * typing a code off a phone at the door has to find the guest's booking — so
 * this returns "a booking you are entitled to see", which is wider than its
 * name suggests and is why it must not be used to decide that something
 * belongs to the caller. Use listMyBookings for that.
 */
export async function getBookingByReference(reference: string): Promise<MyBooking | null> {
  const session = await signedInClient()
  if (!session) return null

  const { data, error } = await session.supabase
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
  tickets: { id: string; checked_in_at: string | null }[]
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
 *
 * The join to hosts is what makes "hosts it" mean hosting rather than merely
 * being on it. bookings_select_own matches a guest's own row on any event, so
 * filtering on event_id alone hands an ordinary attendee a one-row guest list
 * containing themselves, on an event they have nothing to do with — a page
 * that says "who is coming to your event" answering for someone else's. Same
 * OR of policies that leaks into listMyBookings, pointing the other way.
 * Verified: one row without this filter, zero with it.
 *
 * `!inner` on both hops because an outer embed filters nothing — it would
 * null the embedded object and keep the booking row, which is the silent-empty
 * shape all over again rather than a fix.
 *
 * The tickets embed is the opposite case, and deliberately plain: nothing
 * filters on it, and "keeps the row" is exactly right — a zero-ticket booking
 * must still appear on the guest list, with an empty array where its check-in
 * states would be. Only the hosts hop filters.
 */
export async function listEventAttendees(eventId: string): Promise<EventAttendee[]> {
  const session = await signedInClient()
  if (!session) return [] // signed out is definitionally not hosting it

  const { data, error } = await session.supabase
    .from('bookings')
    .select(
      'id, reference, attendee_name, quantity, status, created_at, profiles(phone), tickets(id, checked_in_at), events!inner(hosts!inner(profile_id))',
    )
    .eq('event_id', eventId)
    .eq('events.hosts.profile_id', session.userId)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Could not load the guest list: ${error.message}`)
  return (data ?? []) as unknown as EventAttendee[]
}
