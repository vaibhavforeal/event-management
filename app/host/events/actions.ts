'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { buildSlug } from '@/lib/events/slug'
import { istLocalToUtc } from '@/lib/events/datetime'
import { parseEventForm, validateForPublish } from '@/lib/events/validation'
import { getCurrentHostId } from '@/lib/events/queries'
import { rupeesToPaise } from '@/lib/money'

export interface EventFormState {
  error?: string
  fieldErrors?: Record<string, string>
  blockers?: string[]
  ok?: boolean
}

/**
 * Every write here goes through the RLS-scoped user client on purpose. Phase 0
 * granted `authenticated` insert/update/delete on events and ticket_types,
 * narrowed by current_host_id(). Reaching for the service role would bypass the
 * exact model those RLS tests prove.
 */

/**
 * A signed-in user has a profile but not necessarily a hosts row. Creating one
 * on first publish keeps host onboarding to zero extra screens.
 */
async function resolveOrCreateHost(supabase: SupabaseClient, user: User): Promise<string> {
  const { data: existing } = await supabase
    .from('hosts')
    .select('id')
    .eq('profile_id', user.id)
    .maybeSingle()

  if (existing) return existing.id

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, phone')
    .eq('id', user.id)
    .maybeSingle()

  const displayName = profile?.full_name?.trim() || profile?.phone || 'Host'

  const { data, error } = await supabase
    .from('hosts')
    .insert({ profile_id: user.id, display_name: displayName })
    .select('id')
    .single()

  if (error) throw new Error(`Could not set up your host profile: ${error.message}`)
  return data.id
}

export async function createEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect('/login')

  const parsed = parseEventForm(formData)
  if (!parsed.success) return { fieldErrors: parsed.fieldErrors }
  const input = parsed.data

  const hostId = await resolveOrCreateHost(supabase, auth.user)

  const { data: event, error } = await supabase
    .from('events')
    .insert({
      host_id: hostId,
      slug: buildSlug(input.title), // written once, never updated
      title: input.title,
      description: input.description ?? null,
      city: input.city,
      venue_name: input.venueName ?? null,
      venue_address: input.venueAddress ?? null,
      cover_image_url: input.coverImageUrl ?? null,
      starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
      ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
      requires_approval: input.requiresApproval,
      allows_cash: input.allowsCash,
      hide_venue_until_approved: input.hideVenueUntilApproved,
      status: 'draft',
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  const { error: ticketError } = await supabase.from('ticket_types').insert({
    event_id: event.id,
    name: 'General',
    price_paise: rupeesToPaise(input.priceRupees),
    quantity: input.seats,
  })

  if (ticketError) {
    // Roll back rather than strand an event with no inventory: publish would
    // reject it forever and the UI offers no way to add a ticket type.
    //
    // Not atomic. These are two statements, so a crash — or a lost connection —
    // between them strands the draft just the same. Real atomicity would need
    // both writes inside one Postgres function, which this phase deliberately
    // does not have.
    const { error: rollbackError } = await supabase.from('events').delete().eq('id', event.id)

    if (rollbackError) {
      // The rollback is the thing that prevents the unpublishable-forever state,
      // so its failure cannot be swallowed: name the row that was left behind so
      // it is recoverable by hand rather than invisible.
      return {
        error:
          `${ticketError.message}. The half-created event could not be removed either ` +
          `(${rollbackError.message}) — quote event id ${event.id} when asking for help.`,
      }
    }

    return { error: ticketError.message }
  }

  redirect(`/host/events/${event.id}/edit`)
}

export async function updateEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const hostId = await getCurrentHostId()
  if (!hostId) redirect('/login')

  const eventId = String(formData.get('eventId') ?? '')
  if (!eventId) return { error: 'Missing event id' }

  const parsed = parseEventForm(formData)
  if (!parsed.success) return { fieldErrors: parsed.fieldErrors }
  const input = parsed.data

  // Ownership is settled before anything is written, so neither write below can
  // reach a row the caller does not own. It also supplies the slug for
  // revalidation and the reserved count for the check that follows.
  const { data: existing, error: readError } = await supabase
    .from('events')
    .select('slug, ticket_types(reserved_count)')
    .eq('id', eventId)
    .eq('host_id', hostId)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!existing) return { error: 'That event is not yours to edit' }

  // Cutting capacity below the seats already taken is the one edit Postgres
  // refuses outright (ticket_types_no_oversell). Catching it here, before any
  // write, turns a constraint name into a sentence and leaves the event exactly
  // as it was.
  const reserved = (existing.ticket_types ?? []).reduce(
    (most, type) => Math.max(most, type.reserved_count),
    0,
  )
  if (input.seats < reserved) {
    return {
      blockers: [
        `${reserved} of those seats are already taken, so capacity cannot go down to ${input.seats}`,
      ],
    }
  }

  // Seats first, deliberately: this is the write that carries the constraint, so
  // doing it first means a rejection leaves the event untouched rather than
  // half-saved — a host who is told "failed" must not find the title changed.
  //
  // The mirror image is still possible. If this succeeds and the events update
  // below fails, the seats have moved and nothing else has. Genuine atomicity
  // needs both statements in one transaction, i.e. a Postgres function, and this
  // phase deliberately has none. Tolerable today because reserved_count stays 0
  // until bookings exist in Phase 3, so the constraint that makes this ordering
  // matter cannot yet fire.
  const { error: ticketError } = await supabase
    .from('ticket_types')
    .update({ price_paise: rupeesToPaise(input.priceRupees), quantity: input.seats })
    .eq('event_id', eventId)

  if (ticketError) {
    // Still reachable despite the check above: a booking may land in between.
    return { error: `Could not update seats: ${ticketError.message}` }
  }

  // Note the absence of `slug`. The link may already be in a WhatsApp group.
  const { data, error } = await supabase
    .from('events')
    .update({
      title: input.title,
      description: input.description ?? null,
      city: input.city,
      venue_name: input.venueName ?? null,
      venue_address: input.venueAddress ?? null,
      cover_image_url: input.coverImageUrl ?? null,
      starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
      ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
      requires_approval: input.requiresApproval,
      allows_cash: input.allowsCash,
      hide_venue_until_approved: input.hideVenueUntilApproved,
    })
    .eq('id', eventId)
    // Redundant against the read above, and kept anyway: this is the statement
    // that actually rewrites the row, and it should carry its own scope.
    .eq('host_id', hostId)
    .select('id')
    .maybeSingle()

  if (error) return { error: error.message }
  if (!data) return { error: 'That event is not yours to edit' }

  revalidatePath(`/e/${existing.slug}`)
  revalidatePath('/host')
  return { ok: true }
}

export async function publishEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const hostId = await getCurrentHostId()
  if (!hostId) redirect('/login')

  const eventId = String(formData.get('eventId') ?? '')
  // Without this the empty string reaches Postgres and comes back as
  // `invalid input syntax for type uuid: ""`, which means nothing to a host.
  if (!eventId) return { error: 'Missing event id' }

  const { data: event, error: readError } = await supabase
    .from('events')
    .select('id, slug, title, city, venue_name, starts_at, status, ticket_types(quantity)')
    .eq('id', eventId)
    .eq('host_id', hostId)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!event) return { error: 'That event is not yours to publish' }

  // Only a draft becomes published. Without this, publishing a cancelled event
  // would quietly put a called-off supper club back in the feed, and publishing
  // a live one would restamp published_at and reorder it.
  if (event.status !== 'draft') {
    return {
      error:
        event.status === 'published'
          ? 'This event is already published'
          : `A ${event.status} event cannot be published`,
    }
  }

  const blockers = validateForPublish({
    title: event.title,
    city: event.city,
    venue_name: event.venue_name,
    starts_at: event.starts_at,
    ticketTypes: event.ticket_types,
  })

  if (blockers.length > 0) return { blockers: blockers.map((b) => b.message) }

  const { error } = await supabase
    .from('events')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', eventId)
    .eq('host_id', hostId)

  if (error) return { error: error.message }

  revalidatePath('/')
  revalidatePath('/host')
  revalidatePath(`/e/${event.slug}`)
  return { ok: true }
}

export async function unpublishEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const hostId = await getCurrentHostId()
  if (!hostId) redirect('/login')

  const eventId = String(formData.get('eventId') ?? '')
  if (!eventId) return { error: 'Missing event id' }

  const { data, error } = await supabase
    .from('events')
    .update({ status: 'draft' })
    .eq('id', eventId)
    .eq('host_id', hostId)
    .select('slug')
    .maybeSingle()

  if (error) return { error: error.message }
  if (!data) return { error: 'That event is not yours' }

  revalidatePath('/')
  revalidatePath('/host')
  revalidatePath(`/e/${data.slug}`)
  return { ok: true }
}
