import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

// Integration tests run against the local Supabase stack (`npm run db:start`).
config({ path: '.env.local', quiet: true })
// `.env` as well, and after `.env.local` so that file still wins — dotenv does
// not overwrite a variable that is already set. Both are needed because
// serverEnv() validates the whole server schema at once, so production code
// under test (lib/supabase/admin.ts, reached from lib/bookings/service.ts)
// throws on a missing SEND_SMS_HOOK_SECRET even though it wants only the
// service-role key. That secret lives in `.env` rather than `.env.local`
// because supabase/config.toml substitutes it too.
config({ path: '.env', quiet: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  throw new Error(
    'Integration tests need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.\n' +
      'Run `npm run db:start` and copy the printed values.',
  )
}

/** Service-role client. Bypasses RLS — appropriate for test setup only. */
export function adminClient(): SupabaseClient {
  return createClient(url!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Anonymous client, for asserting that RLS actually denies things. */
export function anonClient(): SupabaseClient {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY missing from .env.local')
  return createClient(url!, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Mints a local access token for a given user.
 *
 * RLS tests need to act as an arbitrary seeded user, and there is no OTP we can
 * type for a randomly generated phone number. Signing a JWT with the local
 * (well-known, dev-only) secret is the standard way to do this. Never applicable
 * outside local development.
 */
export function accessTokenFor(userId: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) throw new Error('SUPABASE_JWT_SECRET missing from .env.local')

  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    iss: 'supabase-demo',
    iat: now,
    exp: now + 3600,
  }

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require('node:crypto') as typeof import('node:crypto')
  const signature = base64url(createHmac('sha256', secret).update(signingInput).digest())

  return `${signingInput}.${signature}`
}

/** Client acting as a specific signed-in user. Subject to RLS. */
export function userClient(userId: string): SupabaseClient {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY missing from .env.local')

  return createClient(url!, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${accessTokenFor(userId)}` },
    },
  })
}

let phoneCounter = 0

/** Creates an auth user; the on_auth_user_created trigger makes the profile. */
export async function createTestUser(db: SupabaseClient): Promise<string> {
  // Unique per call within a run, and namespaced away from real Indian numbers.
  phoneCounter += 1
  const phone = `+1555${String(Date.now() % 1_000_000).padStart(6, '0')}${String(phoneCounter).padStart(3, '0')}`

  const { data, error } = await db.auth.admin.createUser({
    phone,
    phone_confirm: true,
  })
  if (error) throw new Error(`createTestUser failed: ${error.message}`)
  return data.user!.id
}

/** Creates a user who is a platform admin. Cascades away with the auth user. */
export async function seedPlatformAdmin(db: SupabaseClient): Promise<string> {
  const profileId = await createTestUser(db)
  const { error } = await db
    .from('platform_admins')
    .insert({ profile_id: profileId, note: 'test' })
  if (error) throw new Error(`seedPlatformAdmin failed: ${error.message}`)
  return profileId
}

export interface SeededEvent {
  hostProfileId: string
  hostId: string
  eventId: string
  ticketTypeId: string
  attendeeId: string
}

export interface SeedOptions {
  quantity?: number
  pricePaise?: number
  requiresApproval?: boolean
  allowsCash?: boolean
  status?: 'draft' | 'published'
  maxPerOrder?: number
  hasWaitlist?: boolean
  /** Defaults to seven days out. Pass a past instant to seed a settleable event. */
  startsAt?: string
  /** Nullable in the schema, and left null by default — exactly like a real event that never set one. */
  endsAt?: string | null
}

/** Seeds one host, one published event and one ticket type, plus an attendee. */
export async function seedEvent(
  db: SupabaseClient,
  options: SeedOptions = {},
): Promise<SeededEvent> {
  const {
    quantity = 10,
    pricePaise = 50_000,
    requiresApproval = false,
    allowsCash = false,
    status = 'published',
    maxPerOrder = 10,
    hasWaitlist = false,
    startsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    endsAt = null,
  } = options

  const hostProfileId = await createTestUser(db)
  const attendeeId = await createTestUser(db)

  const { data: host, error: hostError } = await db
    .from('hosts')
    .insert({ profile_id: hostProfileId, display_name: 'Test Host' })
    .select()
    .single()
  if (hostError) throw new Error(`seed host failed: ${hostError.message}`)

  const slug = `test-event-${crypto.randomUUID().slice(0, 8)}`
  const { data: event, error: eventError } = await db
    .from('events')
    .insert({
      host_id: host.id,
      slug,
      title: 'Test Supper Club',
      city: 'Indore',
      starts_at: startsAt,
      ends_at: endsAt,
      status,
      requires_approval: requiresApproval,
      allows_cash: allowsCash,
      has_waitlist: hasWaitlist,
      published_at: status === 'published' ? new Date().toISOString() : null,
    })
    .select()
    .single()
  if (eventError) throw new Error(`seed event failed: ${eventError.message}`)

  const { data: ticketType, error: ttError } = await db
    .from('ticket_types')
    .insert({
      event_id: event.id,
      name: 'General',
      price_paise: pricePaise,
      quantity,
      max_per_order: maxPerOrder,
    })
    .select()
    .single()
  if (ttError) throw new Error(`seed ticket type failed: ${ttError.message}`)

  return {
    hostProfileId,
    hostId: host.id,
    eventId: event.id,
    ticketTypeId: ticketType.id,
    attendeeId,
  }
}

let bookingCounter = 0

export interface SeededBooking {
  bookingId: string
  paymentId: string | null
}

/**
 * A booking in a terminal money state, written straight in.
 *
 * Not built from the booking RPCs on purpose: `begin_paid_booking` and
 * `book_free_tickets` both refuse an event that has already started (EH032,
 * EH013) — and every settleable event has by definition started. A settlement
 * fixture therefore cannot come from the booking path at all.
 *
 * Pass a distinct `attendeeId` per booking on the same event: the one-active-
 * booking-per-attendee index will otherwise reject the second.
 */
export async function seedCapturedBooking(
  db: SupabaseClient,
  seed: SeededEvent,
  options: {
    status?: string
    paymentMode?: 'online' | 'cash'
    subtotalPaise?: number
    commissionPaise?: number
    captured?: boolean
    refunded?: boolean
    attendeeId?: string
  } = {},
): Promise<SeededBooking> {
  const {
    status = 'confirmed',
    paymentMode = 'online',
    subtotalPaise = 50_000,
    commissionPaise = 0,
    captured = true,
    refunded = false,
    attendeeId = seed.attendeeId,
  } = options

  bookingCounter += 1
  const reference = `TST${String(Date.now() % 100_000).padStart(5, '0')}${String(bookingCounter).padStart(3, '0')}`

  const { data: booking, error } = await db
    .from('bookings')
    .insert({
      reference,
      event_id: seed.eventId,
      ticket_type_id: seed.ticketTypeId,
      attendee_id: attendeeId,
      quantity: 1,
      status,
      payment_mode: paymentMode,
      subtotal_paise: subtotalPaise,
      convenience_fee_paise: 0,
      total_paise: subtotalPaise,
      commission_paise: commissionPaise,
    })
    .select()
    .single()
  if (error) throw new Error(`seedCapturedBooking: ${error.message}`)
  if (!captured) return { bookingId: booking.id, paymentId: null }

  const { data: payment, error: paymentError } = await db
    .from('payments')
    .insert({
      booking_id: booking.id,
      provider: 'razorpay',
      provider_order_id: `order_${reference}`,
      provider_payment_id: `pay_${reference}`,
      amount_paise: subtotalPaise,
      status: 'captured',
    })
    .select()
    .single()
  if (paymentError) throw new Error(`seedCapturedBooking payment: ${paymentError.message}`)

  if (refunded) {
    const { error: refundError } = await db.from('refunds').insert({
      payment_id: payment.id,
      provider_refund_id: `rfnd_${reference}`,
      amount_paise: subtotalPaise,
      status: 'processed',
    })
    if (refundError) throw new Error(`seedCapturedBooking refund: ${refundError.message}`)
  }

  return { bookingId: booking.id, paymentId: payment.id }
}

/** Removes a seeded event and everything hanging off it. */
export async function cleanupEvent(db: SupabaseClient, seed: SeededEvent): Promise<void> {
  // Order matters and used not to. payouts, payments and refunds are all
  // `on delete restrict` against the rows below them, and none of these
  // deletes checks its error — so before this, any seed carrying a payment
  // failed to delete and leaked its event, host and auth users in silence.
  await db.from('payouts').delete().eq('event_id', seed.eventId)

  const { data: bookings } = await db.from('bookings').select('id').eq('event_id', seed.eventId)
  const bookingIds = (bookings ?? []).map((row) => row.id)
  if (bookingIds.length > 0) {
    const { data: payments } = await db.from('payments').select('id').in('booking_id', bookingIds)
    const paymentIds = (payments ?? []).map((row) => row.id)
    if (paymentIds.length > 0) {
      await db.from('refunds').delete().in('payment_id', paymentIds)
      await db.from('payments').delete().in('id', paymentIds)
    }
  }

  await db.from('bookings').delete().eq('event_id', seed.eventId)
  await db.from('events').delete().eq('id', seed.eventId)
  await db.from('hosts').delete().eq('id', seed.hostId)
  await db.auth.admin.deleteUser(seed.hostProfileId).catch(() => {})
  await db.auth.admin.deleteUser(seed.attendeeId).catch(() => {})
}
