'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { buildSlug } from '@/lib/events/slug'
import { istLocalToUtc } from '@/lib/events/datetime'
import {
  parseEventForm,
  readSubmittedValues as submittedValues,
  validateForPublish,
  type SubmittedEventValues,
} from '@/lib/events/validation'
import { findHost, getCurrentHost, getCurrentHostId } from '@/lib/events/queries'
import { mapEventRpcError } from '@/lib/events/rpc-errors'
import { loginPath } from '@/lib/auth/session'
import { rupeesToPaise } from '@/lib/money'
import type { Database } from '@/lib/supabase/types'

export interface EventFormState {
  error?: string
  fieldErrors?: Record<string, string>
  blockers?: string[]
  ok?: boolean
  /**
   * Exactly what the host typed, handed back on every rejection so the form can
   * refill itself. Built by lib/events/validation.ts from the same declaration
   * the parser reads, so a new field cannot reach the schema and miss the echo.
   */
  values?: SubmittedEventValues
}

/**
 * Every write here goes through the RLS-scoped user client on purpose. Phase 0
 * granted `authenticated` insert/update/delete on events and ticket_types,
 * narrowed by current_host_id(). Reaching for the service role would bypass the
 * exact model those RLS tests prove.
 */

/**
 * The name to publish under when the host has not supplied one.
 *
 * Never, under any circumstance, a phone number. `display_name` used to fall
 * back to `profiles.phone`, and nothing writes `profiles.full_name` — the
 * handle_new_user() trigger inserts id and phone and nothing else — so that
 * fallback fired for every host there has ever been. The result was the host's
 * WhatsApp number rendered under "Host" in the served HTML of the one page the
 * product exists to have forwarded into a group chat, with no screen anywhere
 * that could change it.
 *
 * The form now asks for a name, so this is the floor under a hand-crafted POST
 * that omits one, not the common path.
 */
const UNNAMED_HOST = 'Host'

/**
 * A signed-in user has a profile but not necessarily a hosts row. Creating one
 * on first save keeps host onboarding to zero extra screens.
 *
 * Also the one place a host's display name is written, so that renaming
 * yourself is the same code path whether it is your first event or your tenth.
 */
async function resolveOrCreateHost(
  supabase: SupabaseClient,
  user: User,
  displayName: string | undefined,
): Promise<string> {
  const existing = await findHost(supabase, user.id)

  if (existing) {
    if (displayName && displayName !== existing.display_name) {
      const { error } = await supabase
        .from('hosts')
        .update({ display_name: displayName })
        .eq('id', existing.id)

      if (error) throw new Error(`Could not update your name: ${error.message}`)
    }
    return existing.id
  }

  const { data, error } = await supabase
    .from('hosts')
    .insert({ profile_id: user.id, display_name: displayName ?? UNNAMED_HOST })
    .select('id')
    .single()

  if (error) throw new Error(`Could not set up your host profile: ${error.message}`)
  return data.id
}

/**
 * Every property of T, plus null.
 *
 * Postgres does not record whether a function argument may be null, and
 * `supabase gen types` has nothing else to read — so it emits every text and
 * timestamptz argument of the event-write functions as a bare `string`. Five of
 * the columns behind them are genuinely nullable (description, venue_name,
 * venue_address, cover_image_url, ends_at), and the client is Database-typed,
 * so passing the null the schema allows is a type error against the generated
 * shape. lib/supabase/types.ts is generated and committed, so the widening
 * belongs here rather than as a hand-edit that the next `gen types` erases.
 *
 * Mapped over the generated Args on purpose rather than hand-written, and every
 * key stays required. That is the entire reason these functions take a named
 * parameter per column instead of one jsonb payload: a field added to the form
 * and forgotten at the call site should fail to compile, not arrive as a silent
 * null. Written as `satisfies Nullable<Args> as Args` at the call site, so the
 * literal is still checked — for missing keys and for stray ones — and only the
 * nullability is waived.
 */
type Nullable<T> = { [K in keyof T]: T[K] | null }

type CreateEventArgs = Database['public']['Functions']['create_event_with_ticket_type']['Args']
type UpdateEventArgs = Database['public']['Functions']['update_event_with_ticket_type']['Args']

export async function createEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect(await loginPath())

  const parsed = parseEventForm(formData)
  if (!parsed.success) return { fieldErrors: parsed.fieldErrors, values: submittedValues(formData) }
  const input = parsed.data

  const hostId = await resolveOrCreateHost(supabase, auth.user, input.hostDisplayName)

  const { data: event, error } = await supabase.rpc('create_event_with_ticket_type', {
    p_host_id: hostId,
    p_slug: buildSlug(input.title), // written once, never updated
    p_title: input.title,
    p_description: input.description ?? null,
    p_city: input.city,
    p_venue_name: input.venueName ?? null,
    p_venue_address: input.venueAddress ?? null,
    p_cover_image_url: input.coverImageUrl ?? null,
    p_starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
    p_ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
    p_requires_approval: input.requiresApproval,
    p_allows_cash: input.allowsCash,
    p_hide_venue_until_approved: input.hideVenueUntilApproved,
    p_price_paise: rupeesToPaise(input.priceRupees),
    p_quantity: input.seats,
    p_refund_cutoff_hours: input.refundCutoffHours,
  } satisfies Nullable<CreateEventArgs> as CreateEventArgs)

  // One call, one transaction. The event and its ticket type land together or
  // not at all, which is why there is no compensating delete here any more --
  // and no branch for that delete having failed, which used to be the only
  // thing standing between a host and an event that could never be published.
  if (error) return { ...mapEventRpcError(error, input.seats), values: submittedValues(formData) }

  redirect(`/host/events/${event.id}/edit`)
}

export async function updateEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  // The whole row rather than just the id: `display_name` comes back with it,
  // so seeing whether the host renamed themselves costs no extra query.
  const host = await getCurrentHost()
  if (!host) redirect(await loginPath())
  const hostId = host.id

  const eventId = String(formData.get('eventId') ?? '')
  if (!eventId) return { error: 'Missing event id', values: submittedValues(formData) }

  const parsed = parseEventForm(formData)
  if (!parsed.success) return { fieldErrors: parsed.fieldErrors, values: submittedValues(formData) }
  const input = parsed.data

  // One call, one transaction. Ownership, the oversell check, the seats write
  // and the event write all happen under it -- so the check that refuses a
  // capacity cut is still true when the write lands, rather than merely true
  // when it was read. See supabase/migrations/20260809000001.
  //
  // Note the absence of a slug argument. The link may already be in a WhatsApp
  // group, so the function never writes one.
  const { data: event, error } = await supabase.rpc('update_event_with_ticket_type', {
    p_event_id: eventId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_city: input.city,
    p_venue_name: input.venueName ?? null,
    p_venue_address: input.venueAddress ?? null,
    p_cover_image_url: input.coverImageUrl ?? null,
    p_starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
    p_ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
    p_requires_approval: input.requiresApproval,
    p_allows_cash: input.allowsCash,
    p_hide_venue_until_approved: input.hideVenueUntilApproved,
    p_price_paise: rupeesToPaise(input.priceRupees),
    p_quantity: input.seats,
    p_refund_cutoff_hours: input.refundCutoffHours,
  } satisfies Nullable<UpdateEventArgs> as UpdateEventArgs)

  // Especially on the oversell path: the host may have just typed the venue
  // that clears a publish blocker, and this refusal must not take it away.
  if (error) return { ...mapEventRpcError(error, input.seats), values: submittedValues(formData) }

  // Last, and on its own row rather than the event's: renaming yourself changes
  // every event page you have, so it must not ride along with an edit that was
  // refused. By here the event save has already stood, which is why a failure
  // says so rather than pretending nothing was written.
  if (input.hostDisplayName && input.hostDisplayName !== host.display_name) {
    const { error: renameError } = await supabase
      .from('hosts')
      .update({ display_name: input.hostDisplayName })
      .eq('id', hostId)

    if (renameError) {
      return {
        error: `The event was saved, but your name was not: ${renameError.message}`,
        values: submittedValues(formData),
      }
    }
  }

  revalidatePath(`/e/${event.slug}`)
  revalidatePath('/host')
  return { ok: true }
}

export async function publishEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const hostId = await getCurrentHostId()
  if (!hostId) redirect(await loginPath())

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
  if (!hostId) redirect(await loginPath())

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
