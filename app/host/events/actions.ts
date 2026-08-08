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
    await supabase.from('events').delete().eq('id', event.id)
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
    .eq('host_id', hostId)
    .select('id, slug')
    .maybeSingle()

  if (error) return { error: error.message }
  if (!data) return { error: 'That event is not yours to edit' }

  const { error: ticketError } = await supabase
    .from('ticket_types')
    .update({ price_paise: rupeesToPaise(input.priceRupees), quantity: input.seats })
    .eq('event_id', eventId)

  if (ticketError) {
    // The no-oversell CHECK rejects a quantity below what is already reserved.
    return { error: `Could not update seats: ${ticketError.message}` }
  }

  revalidatePath(`/e/${data.slug}`)
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

  const { data: event, error: readError } = await supabase
    .from('events')
    .select('id, slug, title, city, venue_name, starts_at, ticket_types(quantity)')
    .eq('id', eventId)
    .eq('host_id', hostId)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!event) return { error: 'That event is not yours to publish' }

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
