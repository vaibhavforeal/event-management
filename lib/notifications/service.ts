import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { notificationProvider } from '@/lib/notifications'
import { messagesOwed, type SweepBooking } from '@/lib/notifications/sweep'
import { serverEnv } from '@/lib/env'
// TemplateName lives in templates.ts — types.ts imports it but does not
// re-export it, so pulling it from there is a compile error.
import type { TemplateName } from '@/lib/notifications/templates'
import { NotificationError } from '@/lib/notifications/types'
import type { OutboundMessage, SendResult } from '@/lib/notifications/types'
import type { Database } from '@/lib/supabase/types'

/**
 * The only module that holds the service role for notifications, and the only
 * writer of message_log.
 *
 * It is inside the ESLint admin-import fence for two reasons. message_log has
 * no RLS policy at all — service-role only, exactly like fee_rules and
 * provider_webhook_events — and the sweep reads across every attendee and
 * host on an event, which is not a scope any signed-in caller has.
 *
 * Nothing here takes an id from a request, and nothing here is exported to a
 * page or an action. It is reached from a cron route only, so there is no
 * Caller to authorise — which is safe precisely because there is no argument
 * that could name someone else's booking.
 *
 * Two entry points, deliberately separate. enqueueOwedMessages decides and
 * records; drainOutbox sends what was recorded. Conflating them would put a
 * call to Meta back on whatever path triggered the decision, which is exactly
 * what the outbox exists to prevent.
 */

/** How many times a retryable failure is retried before the row is dead. */
export const MAX_ATTEMPTS = 5

/**
 * Rows considered per tick. Bounded so one tick cannot run unboundedly long.
 *
 * The sweep's working set is bookings on events that have not started yet, so
 * the bound is against near-term volume rather than against the whole table.
 * Oldest first, which is the right order while the set fits: a booking made
 * before the cap is reached is the one whose reminder is most nearly due. If
 * upcoming bookings ever exceed SWEEP_LIMIT the tail stops being read, and the
 * fix is a watermark rather than a bigger number.
 */
const SWEEP_LIMIT = 500
const DRAIN_LIMIT = 100

/**
 * The statuses the sweep can possibly owe a message for.
 *
 * The one filter in this reader where the SQL is the authority rather than an
 * optimisation. Dropping the created_at, starts_at or attempts filters is
 * safe, because the pure sweep re-decides all three — but NARROWING this list
 * is not, because a status missing from it is a row the sweep never sees and
 * so never gets to judge. Delete 'cancelled' and every attendee a host removes
 * is silently never told, with nothing anywhere failing. Add a status to
 * sweep.ts and it must be added here too, which is what the tests naming each
 * of these five are for.
 *
 * Typed as the enum and not as strings so that a value the database does not
 * have — a renamed status, a typo — is a compile error rather than a filter
 * that quietly matches nothing.
 */
const INTERESTING: Database['public']['Enums']['booking_status'][] = [
  'confirmed',
  'pending_approval',
  'awaiting_payment',
  'cancelled',
  'refunded',
]

export async function enqueueOwedMessages(
  options: { now?: Date } = {},
): Promise<{ scanned: number; enqueued: number }> {
  const db = createAdminClient()
  const now = options.now ?? new Date()
  const launchAt = new Date(serverEnv().NOTIFICATIONS_LAUNCH_AT)

  // events!inner so the filter on the event's start time applies to the join
  // rather than nulling the embed and keeping the row — the same trap
  // lib/bookings/queries.ts documents at length for its host scoping.
  const { data, error } = await db
    .from('bookings')
    .select(
      `id, reference, status, cancellation_reason, approved_at,
       total_paise, attendee_name, created_at, hold_expires_at,
       profiles!inner(phone),
       events!inner(title, starts_at, venue_name, city, requires_approval,
                    has_waitlist, hosts!inner(display_name, profiles!inner(phone)))`,
    )
    .in('status', INTERESTING)
    .gte('created_at', launchAt.toISOString())
    .gt('events.starts_at', now.toISOString())
    .order('created_at', { ascending: true })
    .limit(SWEEP_LIMIT)

  if (error) throw new Error(`the notification sweep could not read bookings: ${error.message}`)

  const rows: SweepBooking[] = (data ?? []).map((row) => {
    const r = row as unknown as {
      id: string; reference: string; status: string; cancellation_reason: string | null
      approved_at: string | null; total_paise: number
      attendee_name: string | null; created_at: string; hold_expires_at: string | null
      profiles: { phone: string }
      events: {
        title: string; starts_at: string; venue_name: string | null; city: string
        requires_approval: boolean; has_waitlist: boolean
        hosts: { display_name: string; profiles: { phone: string } }
      }
    }
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      cancellation_reason: r.cancellation_reason,
      approved_at: r.approved_at,
      total_paise: r.total_paise,
      attendee_name: r.attendee_name,
      attendee_phone: r.profiles.phone,
      created_at: r.created_at,
      hold_expires_at: r.hold_expires_at,
      event: {
        title: r.events.title,
        starts_at: r.events.starts_at,
        venue_name: r.events.venue_name,
        city: r.events.city,
        requires_approval: r.events.requires_approval,
        has_waitlist: r.events.has_waitlist,
        host_phone: r.events.hosts.profiles.phone,
        host_display_name: r.events.hosts.display_name,
      },
    }
  })

  // Rows go in as read. The sweep already fails closed on a date it cannot
  // parse and skips a row whose phone will not normalise, logging the booking
  // id; pre-validating here would only decide the same thing twice, and in the
  // one place that cannot be unit-tested in milliseconds.
  const owed = messagesOwed(rows, { now, launchAt })
  if (owed.length === 0) return { scanned: rows.length, enqueued: 0 }

  // One statement rather than one per message. At SWEEP_LIMIT, with up to two
  // messages owed per confirmed booking, the row-at-a-time version was a
  // thousand sequential HTTP round trips a tick.
  //
  // ignoreDuplicates is ON CONFLICT (dedupe_key) DO NOTHING, and RETURNING
  // then names only the rows actually inserted — so `enqueued` counts new
  // decisions rather than messages considered, and the count is what makes a
  // second tick's zero meaningful. A conflict is not an error to handle: it is
  // the unique dedupe_key doing its job, saying this message was already
  // decided on an earlier tick.
  const { data: inserted, error: insertError } = await db
    .from('message_log')
    .upsert(
      owed.map((message) => ({
        dedupe_key: message.dedupeKey,
        recipient_phone: message.to,
        template: message.template,
        variables: message.variables,
        booking_id: message.bookingId ?? null,
        status: 'queued',
      })),
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    )
    .select('id')

  if (insertError) {
    throw new Error(`the notification sweep could not enqueue ${owed.length} messages: ${insertError.message}`)
  }

  return { scanned: rows.length, enqueued: inserted?.length ?? 0 }
}

/**
 * Sends what was recorded.
 *
 * The counters describe outcomes that were RECORDED, not sends that were made:
 * `attempted` counts rows this drain claimed, and the other three count rows
 * whose result made it back into the table. They are equal in the ordinary
 * case, and `attempted > sent + failed + dead` is the one signal that a write
 * was lost after a message had already gone out.
 */
export async function drainOutbox(
  options: { limit?: number } = {},
): Promise<{ attempted: number; sent: number; failed: number; dead: number }> {
  const db = createAdminClient()
  const provider = notificationProvider()
  const counts = { attempted: 0, sent: 0, failed: 0, dead: 0 }

  const { data, error } = await db
    .from('message_log')
    .select('id, dedupe_key, recipient_phone, template, variables, booking_id, attempts')
    .in('status', ['queued', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('updated_at', { ascending: true })
    .limit(options.limit ?? DRAIN_LIMIT)

  if (error) throw new Error(`the outbox could not be read: ${error.message}`)

  for (const row of data ?? []) {
    // Claim it before sending. The UPDATE is conditional on the row still
    // being pending, so of two drains running at once exactly one gets a
    // matching row back and the other skips it — which is what stops the same
    // message going out twice. `sending` is not in the status vocabulary on
    // purpose: bumping attempts up-front is the claim, and it also means a
    // process that dies mid-send has spent an attempt rather than looping
    // forever.
    const { data: claimed, error: claimError } = await db
      .from('message_log')
      .update({ attempts: row.attempts + 1 })
      .eq('id', row.id)
      .eq('attempts', row.attempts)
      .in('status', ['queued', 'failed'])
      .select('id')
      .maybeSingle()

    if (claimError) {
      console.error('[notifications] could not claim a message', claimError)
      continue
    }
    if (!claimed) continue // another drain has it

    counts.attempted += 1

    const message: OutboundMessage = {
      to: row.recipient_phone,
      template: row.template as TemplateName,
      // Read back, never re-derived. A booking that changed shape between the
      // decision and the send does not get to rewrite the sentence somebody
      // was owed.
      variables: (row.variables ?? {}) as Record<string, string>,
      dedupeKey: row.dedupe_key,
      bookingId: row.booking_id ?? undefined,
    }

    let result: SendResult
    try {
      result = await provider.send(message)
    } catch (cause) {
      // A throwing provider costs this row, not the batch.
      //
      // Nothing in the NotificationProvider interface forbids a throw, and the
      // DEFAULT provider does not avoid one: LogNotificationProvider calls
      // renderTemplate straight through, and renderTemplate throws on a
      // variable the stored row does not carry. That row is not exotic — it is
      // the ordinary consequence of freezing variables at enqueue time and
      // then adding a placeholder to a template, so rows queued yesterday no
      // longer cover it. Unguarded, that single row aborts every tick forever,
      // and total silence is the worst failure this system has; sweep.ts says
      // exactly this of a number it cannot dial, and Task 1 wrapped
      // templateComponents for the same reason.
      //
      // A NotificationError has classified itself, so it is believed. Anything
      // else is a provider breaking its contract rather than an outage, and a
      // deterministic crash retried five times ends dead anyway — so it dies
      // now, with its message recorded, where somebody can read it.
      result = {
        status: 'failed',
        retryable: cause instanceof NotificationError ? cause.retryable : false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
      console.error(
        `[notifications] the provider threw sending ${row.dedupe_key} (booking ${row.booking_id}, message ${row.id})`,
        cause,
      )
    }

    const attempts = row.attempts + 1

    if (result.status === 'sent' || result.status === 'skipped_duplicate') {
      const { error: writeError } = await db
        .from('message_log')
        .update({
          status: 'sent',
          provider: provider.name,
          provider_message_id: result.providerMessageId ?? null,
          error: null,
        })
        .eq('id', row.id)

      // The message went out and we could not say so. The row is still
      // pending with its attempt spent, so the NEXT drain sends it again — a
      // duplicate WhatsApp message produced by the one path this whole module
      // exists to close. It is loud here because it is invisible everywhere
      // else, and it is deliberately counted nowhere: `attempted` staying
      // ahead of sent + failed + dead is the only signal a caller gets that an
      // outcome was lost, and counting it as sent would erase that.
      if (writeError) {
        console.error(
          `[notifications] SENT ${row.dedupe_key} (booking ${row.booking_id}, message ${row.id}) but could not record it; the next drain will send it again`,
          writeError,
        )
        continue
      }

      counts.sent += 1
      continue
    }

    // A permanent failure dies now rather than spending four more ticks
    // rediscovering that a template name is still wrong. Compared against
    // `false` and not read as a boolean: an absent flag is no opinion — the
    // log provider sets none, and an adapter that could not classify its own
    // error sets none — and `!retryable` would read that as permanent and burn
    // the message on one unclassified blip.
    const dead = result.retryable === false || attempts >= MAX_ATTEMPTS

    const { error: writeError } = await db
      .from('message_log')
      .update({
        status: dead ? 'dead' : 'failed',
        provider: provider.name,
        error: result.error ?? 'unknown error',
      })
      .eq('id', row.id)

    // Mirror of the lost `sent` write, and worse in one way: a lost `dead`
    // write leaves the row pending, so it retries until MAX_ATTEMPTS with no
    // record anywhere of why it kept failing.
    if (writeError) {
      console.error(
        `[notifications] could not record the failure of ${row.dedupe_key} (booking ${row.booking_id}, message ${row.id}); it keeps its attempt and will be tried again`,
        writeError,
      )
      continue
    }

    if (dead) counts.dead += 1
    else counts.failed += 1
  }

  return counts
}
