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
      starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      status,
      requires_approval: requiresApproval,
      allows_cash: allowsCash,
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

/** Removes a seeded event and everything hanging off it. */
export async function cleanupEvent(db: SupabaseClient, seed: SeededEvent): Promise<void> {
  await db.from('bookings').delete().eq('event_id', seed.eventId)
  await db.from('events').delete().eq('id', seed.eventId)
  await db.from('hosts').delete().eq('id', seed.hostId)
  await db.auth.admin.deleteUser(seed.hostProfileId).catch(() => {})
  await db.auth.admin.deleteUser(seed.attendeeId).catch(() => {})
}
