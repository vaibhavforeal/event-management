import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
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

export interface Host {
  id: string
  /** What the public event page prints under "Host". Never a phone number. */
  display_name: string
}

/**
 * The hosts row for a profile, on a client the caller already holds.
 *
 * Exported because `resolveOrCreateHost` in the Server Actions needs the same
 * lookup and used to carry its own copy of it — two places for the
 * `profile_id` filter to be got wrong, and two places to change.
 */
export async function findHost(
  supabase: SupabaseClient,
  profileId: string,
): Promise<Host | null> {
  const { data } = await supabase
    .from('hosts')
    .select('id, display_name')
    .eq('profile_id', profileId)
    .maybeSingle()

  return (data as Host | null) ?? null
}

/** The caller's own hosts row. Null when signed out, or signed in but not a host. */
export async function getCurrentHost(): Promise<Host | null> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return null

  return findHost(supabase, auth.user.id)
}

export async function getCurrentHostId(): Promise<string | null> {
  return (await getCurrentHost())?.id ?? null
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

/**
 * Escapes a value so ILIKE matches it as a literal string.
 *
 * `?city=` is visitor-supplied and goes straight into a pattern, so without this
 * `?city=%` returns every city on the platform while looking like a working
 * filter. One backslash per special character, which is what SQL LIKE takes as
 * its default escape.
 *
 * Verified against this stack: escaped, `%`, `*`, `_ndore`, `%Indore%` and a
 * bare backslash all match nothing, while a city whose name really does contain
 * `%` or `_` is still found. An earlier round of this comment claimed the
 * opposite — that backslashes do not escape here — on the strength of a probe
 * written through a shell heredoc that ate one level of them, so the value
 * reaching the server was a bare `%` and matched everything, exactly as a broken
 * escape would. If you are about to change this, reproduce through the code path
 * that actually runs; a probe is not evidence until it does.
 *
 * Known limit: PostgREST rewrites `*` to `%` after this runs, so `Ind*re` is
 * escaped to `Ind\*re`, rewritten to `Ind\%re`, and matches a sibling city named
 * `Ind%re` instead of nothing. It substitutes one city for another rather than
 * widening to several — `?city=*` still matches nothing — and no real city name
 * contains an asterisk.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_*]/g, (character) => `\\${character}`)
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
 * How many event rows the chip row is willing to fold.
 *
 * PostgREST truncates every response at `max_rows` (supabase/config.toml), which
 * is 1000. Stated here rather than left implicit so the truncation is a decision
 * with a number attached instead of a surprise, and so raising the config
 * without revisiting this is not silently load-bearing.
 */
const CITY_SCAN_ROWS = 1000

/**
 * The longest `?city=` worth sending to the database.
 *
 * Mirrors `city: z.string().max(80)` in lib/events/validation.ts, which is what
 * bounds every stored value, so this truncates nothing that could have matched.
 * Keep the two together: raising the Zod cap without raising this would start
 * silently cutting legitimate city names out of the filter.
 *
 * Exported because the feed shows the visitor which city it filtered on, and
 * that label has to be the string actually queried rather than whatever was in
 * the URL.
 */
export const MAX_CITY_LENGTH = 80

/**
 * The cities that currently have something on, for the feed's filter row.
 *
 * Deliberately NOT derived from listCityFeed()'s result: that is capped at 50
 * rows nationally, so past fifty upcoming events a city would drop out of the
 * filter row entirely.
 *
 * This query has a cap of its own — see CITY_SCAN_ROWS — so at genuine scale the
 * chip row becomes an incomplete list of cities rather than a complete one. That
 * is survivable **only** because listCityFeed() no longer consults it: a city
 * missing from the chips is still reachable by URL and still returns its events.
 * An earlier version resolved the filter through this list and returned an empty
 * feed for any city past the cap, which was worse than the case-sensitive
 * matching it replaced. Do not reintroduce that coupling.
 *
 * Ordered by city so the truncation is deterministic — the same thousand rows
 * every time, rather than whatever the planner happened to return.
 *
 * PostgREST has no DISTINCT, so the fold happens here over one short column.
 * events_discovery_idx on (city, starts_at) where status = 'published' covers
 * this predicate, so it is an index-only scan; a real DISTINCT would need a view
 * or an RPC, i.e. a migration, which this does not warrant yet.
 */
export async function listFeedCities(): Promise<string[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('events')
    .select('city')
    .eq('status', 'published')
    .gte('starts_at', new Date().toISOString())
    .order('city', { ascending: true })
    .limit(CITY_SCAN_ROWS)

  if (error) throw new Error(`Could not load the cities: ${error.message}`)

  const byFolded = new Map<string, string[]>()
  for (const { city } of (data ?? []) as Array<{ city: string }>) {
    const folded = foldCityName(city)
    if (!folded) continue // a whitespace-only city is not a city
    const spellings = byFolded.get(folded)
    if (spellings) spellings.push(city)
    else byFolded.set(folded, [city])
  }

  return [...byFolded.values()].map(preferredSpelling).sort((a, b) => a.localeCompare(b))
}

/** Upcoming published events, soonest first. Matching on city ignores case. */
export async function listCityFeed(city?: string): Promise<FeedEvent[]> {
  const supabase = await createClient()

  let query = supabase
    .from('events')
    .select(FEED_COLUMNS)
    .eq('status', 'published')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(50)

  // Resolved against the database directly, never against listFeedCities(): the
  // visitor's city has to be found whether or not it made that list's own cap.
  // ILIKE keeps the match case-insensitive and O(1); escapeLikePattern is what
  // stops the visitor's string being read as a pattern.
  //
  // Truncated first, because escaping is what makes the length dangerous: it
  // triples every special character, so ~1,340 `%` in `?city=` built a request
  // line PostgREST rejects, and the feed — the app's main public route —
  // answered 500 "URI too long" where an empty state belongs. 80 is not a guess:
  // it is exactly what Zod caps `city` at on write, so nothing storable is cut,
  // and anything longer could not have matched a row anyway.
  if (city) query = query.ilike('city', escapeLikePattern(city.trim().slice(0, MAX_CITY_LENGTH)))

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
  // So the edit form can show the host the name their guests will read, rather
  // than asking them to trust that whatever is stored is the name they meant.
  hosts: { display_name: string } | null
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
       hide_venue_until_approved, hosts(display_name),
       ticket_types(price_paise, quantity, reserved_count)`,
    )
    .eq('id', id)
    .eq('host_id', hostId) // not just RLS: a published event is readable by anyone
    .maybeSingle()

  if (error) throw new Error(`Could not load the event: ${error.message}`)
  return (data as OwnedEvent | null) ?? null
}
