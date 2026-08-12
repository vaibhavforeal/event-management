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
 * ON THE SCHEDULE, which vercel.json cannot carry a comment about.
 *
 * `0 3 * * *` — once a day, 08:30 IST. Daily is not a preference: Vercel's
 * Hobby plan permits a minimum interval of once per day, and a more frequent
 * expression does not get throttled, it FAILS THE DEPLOYMENT with "Hobby
 * accounts are limited to daily cron jobs. This cron expression would run more
 * than once per day." An hourly `0 * * * *` here does not mean late messages;
 * it means nothing ships.
 *
 * On Pro the minimum interval is once per minute and this one string can go
 * back to `0 * * * *`, which gives the 24-hour reminder a tight 23–24 hour
 * window. On Hobby the reminder instead lands somewhere between 0 and 24 hours
 * ahead depending where the event falls, and a confirmation for a booking made
 * just after a tick waits until the next morning. `dedupe_key` makes it
 * exactly-once on either schedule, so what changes is when, never whether.
 *
 * Hobby scheduling precision is per-hour, ±59 minutes, so 08:30 IST is really
 * somewhere in 08:30–09:29. That is why the hour is 03:00 UTC and not, say,
 * 23:00 UTC: the slop has to stay inside waking hours in the one timezone this
 * product serves, because the tick is also when the messages actually go out.
 */

/**
 * ON DURATION, and why there is deliberately no `maxDuration` export.
 *
 * Under Fluid compute — the default for projects created since April 2025 —
 * Hobby's function duration is 300s both by default and at maximum, so there
 * is nothing here to raise: an export could only equal that ceiling or lower
 * it. (60s was the pre-Fluid Hobby maximum; writing it here would have CUT the
 * budget to a fifth while claiming to protect it.) A number would also be one
 * more thing to go stale, and a wrong one in this file is expensive, because a
 * deployment that fails on config is the one failure this route cannot report.
 *
 * The budget matters because a tick is not cheap: the drain sends up to
 * DRAIN_LIMIT messages one at a time and reconcile makes a Razorpay round trip
 * per stuck refund. 300s covers roughly 750 sequential sends, so DRAIN_LIMIT
 * (100) is not close to the wall. And a tick killed anyway degrades gracefully
 * — a claimed row keeps its spent attempt and is selectable on the next tick,
 * so the cost is lateness, not loss.
 */

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
