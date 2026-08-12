import 'server-only'
import { hasEnded } from '@/lib/events/datetime'
import { joinPaymentFacts, settle, type SettlementBooking, type Statement } from '@/lib/payouts/settlement'
import { createClient } from '@/lib/supabase/server'

/**
 * Reads for the settlement loop, through the ordinary session client.
 *
 * Nothing here reaches for the service role. The money rows — bookings,
 * payments, refunds, payouts — are guarded by the admin policies added in
 * 20260812000002, so RLS decides what comes back for everything that matters.
 * One thing RLS cannot decide: published events are world-readable by design
 * (the feed depends on it), so "which events ended" is a question anyone may
 * ask. listSettleableEvents therefore asks the database is_platform_admin()
 * and returns nothing to a non-admin — a gate answered by the database, held
 * in front of a list that would otherwise be meaningless zero-statement
 * shells. Amended after the Task 5 review: the original design fact ("no if
 * in this file") assumed RLS hid events, and it deliberately does not.
 */

export interface PayoutRow {
  id: string
  event_id: string
  status: 'pending' | 'paid' | 'on_hold'
  gross_paise: number
  commission_paise: number
  net_paise: number
  forfeited_paise: number
  utr_reference: string | null
  notes: string | null
  paid_at: string | null
}

export interface SettleableEvent {
  eventId: string
  title: string
  slug: string
  startsAt: string
  endsAt: string | null
  hostId: string
  hostName: string
  hostKycStatus: string
  statement: Statement
  payout: PayoutRow | null
  /**
   * Recomputed net minus the settled row's net. Null when nothing is settled.
   * Derived on every read and never stored — a drift column could only go
   * stale, and this is the same call the page already makes.
   */
  driftPaise: number | null
}

export interface HostStatement {
  eventId: string
  title: string
  slug: string
  startsAt: string
  endsAt: string | null
  statement: Statement
  payout: PayoutRow | null
}

const PAYOUT_COLUMNS =
  'id, event_id, status, gross_paise, commission_paise, net_paise, forfeited_paise, utr_reference, notes, paid_at'

/** Whether the caller may settle. Reported by the database, not inferred here. */
export async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('is_platform_admin')
  if (error) return false
  return data === true
}

export async function listSettleableEvents(now: Date = new Date()): Promise<SettleableEvent[]> {
  const supabase = await createClient()

  // Check admin status first. The admin policies on bookings/payments/payouts rely
  // on is_platform_admin(), so a non-admin gets no rows from those tables. But
  // events themselves are world-readable (published ones), so we'd return events
  // with empty statements without this check. The comment below about "RLS is the
  // guard" means the database enforces access to bookings/payments, not that we
  // skip the function-level authorization.
  const isAdmin = await isPlatformAdmin()
  if (!isAdmin) return []

  // starts_at < now is a necessary condition for hasEnded — events_end_after_start
  // guarantees ends_at > starts_at — so this narrows in SQL and hasEnded decides.
  // Doing the whole thing in SQL would need the coalesce duplicated there.
  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, slug, starts_at, ends_at, host_id, hosts(display_name, kyc_status)')
    .lt('starts_at', now.toISOString())
    .order('starts_at', { ascending: false })
  if (error || !events) return []

  const ended = events.filter((event) => hasEnded(event.starts_at, event.ends_at, now))
  if (ended.length === 0) return []

  const eventIds = ended.map((event) => event.id)
  const bookings = await bookingRowsFor(supabase, eventIds)
  const payouts = await payoutRowsFor(supabase, eventIds)

  return ended.map((event) => {
    const statement = settle(bookings.get(event.id) ?? [])
    const payout = payouts.get(event.id) ?? null
    return {
      eventId: event.id,
      title: event.title,
      slug: event.slug,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      hostId: event.host_id,
      hostName: event.hosts?.display_name ?? 'Unknown host',
      hostKycStatus: event.hosts?.kyc_status ?? 'pending',
      statement,
      payout,
      driftPaise: payout ? statement.netPaise - payout.net_paise : null,
    }
  })
}

/** Bookings for many events, with their money facts joined. Admin path only. Exported for unit-testing. */
export async function bookingRowsFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  eventIds: string[],
): Promise<Map<string, SettlementBooking[]>> {
  // A failed read must not read as "no refunds" — that direction over-pays.
  // Throw on any query error so the statement page fails to render rather than
  // silently understating what is owed.
  const { data: bookings, error: bookingsError } = await supabase
    .from('bookings')
    .select('id, event_id, status, payment_mode, subtotal_paise, commission_paise')
    .in('event_id', eventIds)
  if (bookingsError) throw new Error(`Failed to read bookings: ${bookingsError.message}`)
  if (!bookings || bookings.length === 0) return new Map()

  const bookingIds = bookings.map((booking) => booking.id)
  const { data: payments, error: paymentsError } = await supabase
    .from('payments')
    .select('id, booking_id, status')
    .in('booking_id', bookingIds)
  if (paymentsError) throw new Error(`Failed to read payments: ${paymentsError.message}`)

  const paymentIds = (payments ?? []).map((payment) => payment.id)
  const { data: refunds, error: refundsError } = paymentIds.length
    ? await supabase.from('refunds').select('payment_id').in('payment_id', paymentIds)
    : { data: [], error: null }
  if (refundsError) throw new Error(`Failed to read refunds: ${refundsError.message}`)

  const joined = joinPaymentFacts(bookings, payments ?? [], refunds ?? [])
  const byEvent = new Map<string, SettlementBooking[]>()
  joined.forEach((row, index) => {
    const eventId = bookings[index].event_id
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), row])
  })
  return byEvent
}

async function payoutRowsFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  eventIds: string[],
): Promise<Map<string, PayoutRow>> {
  const { data } = await supabase.from('payouts').select(PAYOUT_COLUMNS).in('event_id', eventIds)
  return new Map((data ?? []).map((row) => [row.event_id as string, row as unknown as PayoutRow]))
}

/** The destination for a transfer. Admin only; refuses through the database. */
export async function hostPayoutTarget(
  hostId: string,
): Promise<{ upi_id: string | null; bank_account_ref: string | null } | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_host_payout_target', { p_host_id: hostId })
  if (error || !data || data.length === 0) return null
  return data[0]
}

/**
 * The host's own statements.
 *
 * The per-booking money facts come from host_settlement_rows() because a host
 * may not read `payments` — rls_policies.sql:157 — so the same settle() runs
 * over rows that carry no instrument detail at all.
 */
export async function listHostStatements(now: Date = new Date()): Promise<HostStatement[]> {
  const supabase = await createClient()

  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, slug, starts_at, ends_at')
    .lt('starts_at', now.toISOString())
    .order('starts_at', { ascending: false })
  if (error || !events) return []

  const ended = events.filter((event) => hasEnded(event.starts_at, event.ends_at, now))
  if (ended.length === 0) return []

  const payouts = await payoutRowsFor(supabase, ended.map((event) => event.id))

  const statements: HostStatement[] = []
  for (const event of ended) {
    const { data: rows, error } = await supabase.rpc('host_settlement_rows', { p_event_id: event.id })
    // RPC raises EH076 if the caller doesn't own this event and isn't admin.
    // Skip events we're not authorized to see.
    if (error || !rows) continue
    statements.push({
      eventId: event.id,
      title: event.title,
      slug: event.slug,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      statement: settle(rows as SettlementBooking[]),
      payout: payouts.get(event.id) ?? null,
    })
  }
  return statements
}
