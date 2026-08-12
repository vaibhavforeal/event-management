import { timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/env'
import { drainOutbox, enqueueOwedMessages } from '@/lib/notifications/service'
import { runReconciliationSweep } from '@/lib/payments/service'

/**
 * The scheduled door. Vercel Cron calls it with
 * `Authorization: Bearer $CRON_SECRET`, which is why this is the one GET
 * endpoint in an app whose other entry points are all POSTs.
 *
 * Three arms, in order:
 *   1. the notification sweep — decide what is owed and queue it
 *   2. the outbox drain — send what is queued
 *   3. the reconciliation sweep — Phase 3's, hand-run via `npm run reconcile`
 *      since it was written, because there was no deploy-target cron until
 *      this file existed
 *
 * Each arm is isolated: one throwing must not stop the others, or a database
 * hiccup in the sweep would also mean payments go unreconciled. Failures are
 * reported in the body rather than as a non-2xx, because the run as a whole
 * did happen and a red cron alert per transient error trains you to ignore it.
 */

/**
 * The drain sends up to DRAIN_LIMIT messages one at a time and the reconcile
 * arm makes a Razorpay round trip per stuck refund, so a busy tick is measured
 * in tens of seconds, not the platform default. 60 is the ceiling Vercel's
 * Hobby plan allows, so this value needs no plan to be raised for it. A tick
 * killed mid-drain is not lost work — the claimed rows keep their spent
 * attempt and the next tick picks them up — but it is a message arriving an
 * interval late for no reason.
 */
export const maxDuration = 60

/** Constant-time compare, so the secret cannot be recovered a byte at a time. */
function credentialMatches(header: string | null, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(secret)
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // length — but length is not the secret, and the guard is required.
  if (presented.length !== expected.length) return false
  return timingSafeEqual(presented, expected)
}

/** Runs one arm, turning a throw into a reportable result. */
async function arm<T>(name: string, run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run()
  } catch (error) {
    console.error(`[cron] ${name} failed`, error)
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = serverEnv().CRON_SECRET

  // An unset secret closes the door rather than opening it. A deploy that
  // forgot the variable should have a job that never runs, not a job anyone on
  // the internet can run. Checked separately from the comparison and not
  // folded into it as `secret ?? ''`, because timingSafeEqual of two empty
  // buffers is true — an empty expected secret would accept the header
  // `Authorization: Bearer ` from anybody.
  if (!secret || !credentialMatches(request.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Enqueue before draining, and awaited rather than raced, so a message
  // decided on this tick goes out on this tick rather than waiting a full
  // interval for the next one.
  const sweep = await arm('sweep', () => enqueueOwedMessages())
  const drain = await arm('drain', () => drainOutbox())
  const reconcile = await arm('reconcile', () => runReconciliationSweep())

  return Response.json({ sweep, drain, reconcile })
}
