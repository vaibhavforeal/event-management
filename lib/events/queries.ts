import 'server-only'
import { createClient } from '@/lib/supabase/server'

/**
 * Reads for the feed, the public event page and the host dashboard.
 *
 * RLS already hides other hosts' drafts, but it does NOT scope a host's own
 * list: `events_select_published` makes every published event readable by
 * everyone. So anything that means "mine" filters on host_id explicitly. Relying
 * on RLS alone here would show a host the entire platform's catalogue.
 */

const FEED_COLUMNS =
  'id, slug, title, cover_image_url, city, venue_name, starts_at, ticket_types(price_paise, quantity, reserved_count)'

export interface FeedEvent {
  id: string
  slug: string
  title: string
  cover_image_url: string | null
  city: string
  venue_name: string | null
  starts_at: string
  ticket_types: Array<{ price_paise: number; quantity: number; reserved_count: number }>
}

export async function getCurrentHostId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return null

  const { data } = await supabase
    .from('hosts')
    .select('id')
    .eq('profile_id', auth.user.id)
    .maybeSingle()

  return data?.id ?? null
}

/** Upcoming published events, soonest first. */
export async function listCityFeed(city?: string): Promise<FeedEvent[]> {
  const supabase = await createClient()

  let query = supabase
    .from('events')
    .select(FEED_COLUMNS)
    .eq('status', 'published')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(50)

  if (city) query = query.eq('city', city)

  const { data, error } = await query
  if (error) throw new Error(`Could not load the feed: ${error.message}`)
  return (data ?? []) as FeedEvent[]
}

export interface PublicEvent extends FeedEvent {
  description: string | null
  venue_address: string | null
  hide_venue_until_approved: boolean
  ends_at: string | null
  requires_approval: boolean
  allows_cash: boolean
  hosts: { display_name: string; bio: string | null; avatar_url: string | null } | null
}

/** The public event page. Returns null for drafts and unknown slugs alike. */
export async function getPublishedEventBySlug(slug: string): Promise<PublicEvent | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('events')
    .select(
      `${FEED_COLUMNS}, description, venue_address, hide_venue_until_approved, ends_at,
       requires_approval, allows_cash, hosts(display_name, bio, avatar_url)`,
    )
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle()

  if (error) throw new Error(`Could not load the event: ${error.message}`)
  return (data as PublicEvent | null) ?? null
}

export interface HostEvent {
  id: string
  slug: string
  title: string
  status: 'draft' | 'published' | 'cancelled' | 'completed'
  city: string
  starts_at: string
  cover_image_url: string | null
  published_at: string | null
  ticket_types: Array<{ price_paise: number; quantity: number; reserved_count: number }>
}

/** The host's own events, drafts included, newest first. */
export async function listHostEvents(): Promise<HostEvent[]> {
  const hostId = await getCurrentHostId()
  if (!hostId) return [] // signed in but has never created an event

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('events')
    .select(
      'id, slug, title, status, city, starts_at, cover_image_url, published_at, ticket_types(price_paise, quantity, reserved_count)',
    )
    .eq('host_id', hostId)
    .order('starts_at', { ascending: false })

  if (error) throw new Error(`Could not load your events: ${error.message}`)
  return (data ?? []) as HostEvent[]
}

export interface OwnedEvent extends HostEvent {
  description: string | null
  venue_name: string | null
  venue_address: string | null
  ends_at: string | null
  requires_approval: boolean
  allows_cash: boolean
  hide_venue_until_approved: boolean
}

/** One of the caller's own events, for the edit page. */
export async function getOwnedEvent(id: string): Promise<OwnedEvent | null> {
  const hostId = await getCurrentHostId()
  if (!hostId) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('events')
    .select(
      `id, slug, title, status, city, starts_at, cover_image_url, published_at,
       description, venue_name, venue_address, ends_at, requires_approval, allows_cash,
       hide_venue_until_approved, ticket_types(price_paise, quantity, reserved_count)`,
    )
    .eq('id', id)
    .eq('host_id', hostId) // not just RLS: a published event is readable by anyone
    .maybeSingle()

  if (error) throw new Error(`Could not load the event: ${error.message}`)
  return (data as OwnedEvent | null) ?? null
}
