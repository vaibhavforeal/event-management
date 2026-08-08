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

/**
 * Groups spellings of one city.
 *
 * `city` is free text the host types into a form. Nothing normalises it on the
 * way in, so one place arrives as "Bengaluru", "bengaluru" and "BENGALURU" —
 * which, matched exactly, is three cities with three partial feeds. Everything
 * that compares or groups a city name goes through here so the rule lives in
 * one place.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the latter is locale-sensitive
 * and would fold Turkish dotted/dotless I differently depending on where the
 * server happens to be, which is exactly the kind of thing that works locally
 * and not in production. Trimmed too — Zod trims on write, but a direct
 * database write can leave whitespace either side.
 */
export function foldCityName(city: string): string {
  return city.trim().toLowerCase()
}

export interface FeedCity {
  /** The spelling the chip shows and `?city=` carries. */
  name: string
  /** Every stored spelling that folds to it, for an exact-equality filter. */
  variants: string[]
}

/**
 * Which spelling of a city to show.
 *
 * Not "whichever sorted first", which puts BENGALURU above Bengaluru on the
 * strength of a capital B. Most-used wins, because that is the spelling hosts
 * and visitors already recognise; ties go to a deliberately capitalised form
 * over a shouted or lower-case one; lexicographic breaks the rest so the chip
 * row is stable between renders instead of depending on row order.
 *
 * Deliberately does NOT title-case. The chip shows a spelling a host actually
 * typed; inventing one mangles names this product will meet, and a rule written
 * for Latin has nothing useful to say about a city typed in Kannada or Devanagari.
 */
function preferredSpelling(spellings: string[]): string {
  const counts = new Map<string, number>()
  for (const spelling of spellings) {
    counts.set(spelling, (counts.get(spelling) ?? 0) + 1)
  }

  const ranked = [...counts.entries()].sort(
    ([a, aCount], [b, bCount]) =>
      bCount - aCount || looksDeliberatelyCased(b) - looksDeliberatelyCased(a) || a.localeCompare(b),
  )
  return ranked[0][0]
}

/** 1 for a spelling with mixed case, 0 for all-lower or all-upper. */
function looksDeliberatelyCased(city: string): number {
  return city !== city.toLowerCase() && city !== city.toUpperCase() ? 1 : 0
}

/**
 * The cities that currently have something on, for the feed's filter row.
 *
 * Its own query rather than something derived from listCityFeed()'s result, and
 * that is the whole point. The feed is capped at 50 rows nationally, so once
 * the platform has more upcoming events than that, a city whose next event
 * falls outside the window would silently stop appearing in the filter and
 * become reachable only by hand-editing the URL. Nothing errors; the city just
 * stops getting traffic. The cap belongs to the feed, not to navigation.
 *
 * PostgREST has no DISTINCT, so the fold happens here over one short column.
 * events_discovery_idx on (city, starts_at) where status = 'published' covers
 * this predicate exactly, so it is an index-only scan; a real DISTINCT would
 * need a view or an RPC, i.e. a migration, which this does not warrant yet.
 */
export async function listFeedCities(): Promise<FeedCity[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('events')
    .select('city')
    .eq('status', 'published')
    .gte('starts_at', new Date().toISOString())

  if (error) throw new Error(`Could not load the cities: ${error.message}`)

  const byFolded = new Map<string, string[]>()
  for (const { city } of (data ?? []) as Array<{ city: string }>) {
    const folded = foldCityName(city)
    if (!folded) continue // a whitespace-only city is not a city
    const spellings = byFolded.get(folded)
    if (spellings) spellings.push(city)
    else byFolded.set(folded, [city])
  }

  return [...byFolded.values()]
    .map((spellings) => ({
      name: preferredSpelling(spellings),
      variants: [...new Set(spellings)],
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Upcoming published events, soonest first. Matching on city ignores case. */
export async function listCityFeed(city?: string): Promise<FeedEvent[]> {
  let variants: string[] | undefined

  if (city) {
    // Every stored spelling of the requested city, matched with exact equality.
    //
    // `.ilike()` is the obvious way to be case-insensitive and it is the wrong
    // one here. PostgREST reads both % and * in the pattern as wildcards, and —
    // checked against the local stack rather than assumed — a backslash does
    // NOT escape them back to literals. `?city=%` is a URL any visitor can
    // type, and it would quietly match every city on the platform while looking
    // like a working filter. `.in()` has no pattern surface at all.
    const folded = foldCityName(city)
    variants = (await listFeedCities()).find((known) => foldCityName(known.name) === folded)?.variants
    // Nothing published in that city under any spelling. Returning here saves a
    // query whose answer we already know; `.in()` on an empty list is also safe.
    if (!variants) return []
  }

  const supabase = await createClient()

  let query = supabase
    .from('events')
    .select(FEED_COLUMNS)
    .eq('status', 'published')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(50)

  if (variants) query = query.in('city', variants)

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
  // The edit page keys the publish panel on this so a successful save remounts
  // it with clean state. The events_set_updated_at trigger moves it on every
  // write, so it changes exactly when the panel's cached response goes stale.
  updated_at: string
}

/** One of the caller's own events, for the edit page. */
export async function getOwnedEvent(id: string): Promise<OwnedEvent | null> {
  const hostId = await getCurrentHostId()
  if (!hostId) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('events')
    .select(
      `id, slug, title, status, city, starts_at, cover_image_url, published_at, updated_at,
       description, venue_name, venue_address, ends_at, requires_approval, allows_cash,
       hide_venue_until_approved, ticket_types(price_paise, quantity, reserved_count)`,
    )
    .eq('id', id)
    .eq('host_id', hostId) // not just RLS: a published event is readable by anyone
    .maybeSingle()

  if (error) throw new Error(`Could not load the event: ${error.message}`)
  return (data as OwnedEvent | null) ?? null
}
