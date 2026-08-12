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
 *   1. the reconciliation sweep — Phase 3's, hand-run via `npm run reconcile`
 *      since it was written, because there was no deploy-target cron until
 *      this file existed
 *   2. the notification sweep — decide what is owed and queue it
 *   3. the outbox drain — send what is queued
 *
 * The order is the data's, not the phases'. Reconcile runs first because it
 * WRITES the state the sweep then reads: a dropped Razorpay webhook leaves a
 * booking in `awaiting_payment` that reconcile flips to `confirmed`, and a
 * sweep that ran before it would see the stale row, owe nothing, and defer
 * that confirmation a full interval. Deferring is not free here — by the
 * schedule note below, the sweep's own gates mean an interval can decide
 * WHETHER a message is ever sent, not only when, so a booking reconciled
 * within an hour of its event start would lose the message rather than
 * receive it late. Sweep before drain for the same reason one step further
 * down: queue it, then send it, on the same tick.
 *
 * Each arm is isolated: one throwing must not stop the others, or a database
 * hiccup in reconcile would also mean nothing gets messaged. Failures are
 * reported in the body rather than as a non-2xx, because the run as a whole
 * did happen and a red cron alert per transient error trains you to ignore it.
 */

/**
 * ON THE SCHEDULE, which vercel.json cannot carry a comment about.
 *
 * `0 * * * *` — hourly, which requires Vercel Pro. The interval is not a
 * tuning knob, because the sweep's own gates make a missed tick permanent
 * rather than late:
 *
 *   1. sweep.ts refuses any booking whose event `hasStarted`, and
 *   2. service.ts only reads rows with `events.starts_at > now`.
 *
 * A booking therefore has to be SEEN by a tick that falls between the booking
 * and the event start. If the whole of that life fits between two ticks,
 * nothing is ever owed for it and no later tick can recover it — the row is
 * excluded by both gates from then on, forever. Booked at 10:00 for an event
 * at 19:00 the same evening, on a daily 08:30 tick: no confirmation, no
 * reminder, no cancellation notice, nothing. Not late — never. That is why an
 * hourly tick is worth a paid plan: it shrinks the hole from a day to an hour.
 *
 * It does NOT close it. An event starting inside the hour after the booking is
 * still missed, and the honest statement of what this route guarantees is
 * "every booking with at least an hour of daylight before its event". Widening
 * that means a shorter interval, or a sweep that stops excluding started
 * events and decides per template — not a bigger constant here.
 *
 * `dedupe_key` still guarantees exactly-once for everything that IS decided.
 * What it does not do is make the schedule a question of only WHEN: the gates
 * above mean the interval decides WHETHER, for the bookings that fall through.
 *
 * If this ever moves back to Hobby, note that Hobby's minimum interval is once
 * per day and a more frequent expression does not get throttled, it FAILS THE
 * DEPLOYMENT with "Hobby accounts are limited to daily cron jobs. This cron
 * expression would run more than once per day." So a downgrade costs the
 * deploy first and the same-day bookings second; the daily replacement is
 * `0 3 * * *` (03:00 UTC, 08:30 IST — Hobby precision is ±59 min, so really
 * 08:30–09:29, kept inside waking hours because the tick is also when messages
 * go out).
 *
 * ON THROUGHPUT. The drain moves at most DRAIN_LIMIT (100) messages per tick,
 * so hourly is ~2,400 a day against ~100 on a daily schedule. The response
 * body is the instrument: `drain.attempted === 100` means the drain saturated
 * and a backlog is building, and `sweep.scanned === 500` means SWEEP_LIMIT
 * truncated the read — whose dropped tail is the NEWEST bookings, which then
 * age past the gates above and are lost rather than deferred.
 */

/**
 * ON DURATION, and why there is deliberately no `maxDuration` export.
 *
 * Under Fluid compute — the default for projects created since April 2025 —
 * the function duration default is 300s on every plan; Pro's maximum is 800s
 * and Hobby's is also 300s. So Pro does have headroom to raise, and this file
 * still declines to use it, because the budget is not what binds: the drain
 * sends up to DRAIN_LIMIT messages one at a time and reconcile makes a
 * Razorpay round trip per stuck refund, and 300s covers roughly 750 sequential
 * sends against a DRAIN_LIMIT of 100. The wall is nowhere near, and a number
 * written here would be one more thing to go stale — 60 already did, having
 * been the PRE-Fluid Hobby maximum, so an export of it would have cut the
 * budget to a fifth while its comment claimed to protect it.
 *
 * If DRAIN_LIMIT is ever raised past a few hundred, revisit this: that is the
 * change that makes duration bind, and on Pro the fix is an export, not a
 * plan. A tick killed at the wall still degrades gracefully — a claimed row
 * keeps its spent attempt and is selectable on the next tick — so the cost is
 * an hour's lateness, not loss.
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

  // Awaited in sequence rather than raced: each arm reads what the one before
  // it wrote, so a message this tick makes true is also decided and sent on
  // this tick rather than waiting a full interval for the next one.
  const reconcile = await arm('reconcile', () => runReconciliationSweep())
  const sweep = await arm('sweep', () => enqueueOwedMessages())
  const drain = await arm('drain', () => drainOutbox())

  return Response.json({ sweep, drain, reconcile })
}
