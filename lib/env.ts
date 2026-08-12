import { z } from 'zod'

/**
 * Environment access, split by trust boundary.
 *
 * `clientEnv` holds only NEXT_PUBLIC_* values, which Next inlines into the
 * browser bundle. `serverEnv()` holds secrets and throws if called anywhere
 * a bundle could reach.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.url(),
})

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Shared secret Supabase Auth signs the send_sms hook with. Format:
  // "v1,whsec_<base64>". Must match [auth.hook.send_sms].secrets.
  SEND_SMS_HOOK_SECRET: z.string().min(1),
  TICKET_SIGNING_SECRET: z.string().min(32),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(['log', 'meta', 'aisensy']).default('log'),
  WHATSAPP_API_KEY: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  // Bookings created before this instant are invisible to the notification
  // sweep. Without it the first run messages every attendee about every event
  // this product has ever run. ISO 8601; z.iso.datetime() rejects a date-only
  // value, which would otherwise be read as midnight UTC and silently shift
  // the cutoff by up to a day.
  NOTIFICATIONS_LAUNCH_AT: z.iso.datetime().default('2026-08-12T00:00:00Z'),
  // Shared secret Vercel Cron presents as `Authorization: Bearer <secret>`.
  // Optional so local development and tests run without it; the route refuses
  // every request when it is absent, which is the safe direction.
  CRON_SECRET: z.string().optional(),
})

function fail(scope: string, error: z.ZodError): never {
  const issues = error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  throw new Error(
    `Invalid ${scope} environment.\n${issues}\n\nCopy .env.example to .env.local and fill in the missing values.`,
  )
}

// Must be a static object literal, not a loop: Next replaces each
// `process.env.NEXT_PUBLIC_*` reference at build time by exact text match.
const clientParsed = clientSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
})

if (!clientParsed.success) fail('client', clientParsed.error)

export const clientEnv = clientParsed.data

export type ServerEnv = z.infer<typeof serverSchema>

let cachedServerEnv: ServerEnv | undefined

/**
 * Server-only secrets. Lazy so that importing this module from a client
 * component does not blow up on missing secrets — it throws only if a
 * secret is actually read somewhere it should not be.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called in the browser. This would leak secrets.')
  }
  if (!cachedServerEnv) {
    const parsed = serverSchema.safeParse(process.env)
    if (!parsed.success) fail('server', parsed.error)
    cachedServerEnv = parsed.data
  }
  return cachedServerEnv
}
