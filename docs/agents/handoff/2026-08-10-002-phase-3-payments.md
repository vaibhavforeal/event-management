# Handoff — Phase 3: Razorpay checkout, webhook truth, cutoff refunds

**Date:** 2026-08-10
**Branch at end of session:** `master` @ `781b51f` (merge `--no-ff` of `phase-3-payments`, kept and pushed)
**Suite:** 482 tests, 46 files, all green. Typecheck, lint, build, and a live `npm run reconcile` clean.

---

## Goal

Execute Phase 3 of the v1 build order: the paid checkout path. Spec at
[`2026-08-10-phase-3-payments-design.md`](../../specs/2026-08-10-phase-3-payments-design.md),
plan at [`2026-08-10-phase-3-payments.md`](../../plans/2026-08-10-phase-3-payments.md).
This session resumed after a machine shutdown killed the prior one mid-plan;
the plan was rewritten from fresh research, then executed subagent-driven:
thirteen tasks, a fresh implementer per task, a review after each (three fix
rounds across thirteen tasks), a whole-branch review at the end (verdict:
merge with two fixes, both landed and re-reviewed).

## Current state

**A paid event now completes the whole loop:** publish → WhatsApp link →
Pay ₹500 (Razorpay sheet over the booking page) → webhook confirms → per-seat
QR → door scan. Refunds follow the per-event cutoff on both cancel surfaces;
host removal always refunds in full. The webhook is the only writer of
payment truth; the browser only watches. Suite grew 377 → 482.

The local stack is **stopped** (backed up on stop). No dev server running.
`.env.local` carries **no Razorpay keys** — the free path boots and works
without them; `startPaidCheckout` refuses with one sentence until keys exist.

## What was accomplished

- `begin_paid_booking` (EH030–EH033) + `events.refund_cutoff_hours`; the
  event writers re-created with `p_refund_cutoff_hours` (drop-first — a new
  signature would otherwise overload); `refunds_one_per_payment` unique index.
- `lib/payments/`: pure `refund-policy` (host → full; attendee → full until
  cutoff, fail-closed) + `rpc-errors`; the `PaymentProvider` seam; a plain-fetch
  Razorpay adapter (basic auth, four endpoints, both HMAC schemes behind
  `timingSafeEqual`, wire contract verified against razorpay.com/docs);
  `service.ts` — the **third and last** admin importer (fence extended) —
  with `startPaidCheckout`, the webhook processor, `refundIfOwed`,
  `reconcileBooking`/`reconcileAfterCheckout`, and `runReconciliationSweep`.
- `app/api/webhooks/razorpay` (verify raw body → dedup → dispatch → stamp;
  500 = "retry me"), the paid path on `/e/[slug]`, the checkout home on
  `/bookings/[reference]` (sheet + countdown + status polling; first poll
  carries the checkout proof, verified against the **stored** order id),
  consequence sentences on both cancel surfaces, `npm run reconcile`.
- `cancelBooking(caller, bookingId, initiator: 'attendee' | 'host')` — the
  typed initiator replaced the prose reason; stored prose unchanged.

## Failed attempts and learnings

- **The plan's own reference code carried three real defects**, each caught
  by a reviewer and fixed in a loop: (1) `ensureRefund`'s read-then-insert
  could double-refund under concurrent redelivery — closed by the unique
  index + race-safe upsert + a `Promise.all` test; (2) `Script onLoad` never
  re-fires for a cached script, bricking the pay button on client-side
  remount — closed with `onReady` + seeding from `window.Razorpay`, reproduced
  live both ways; (3) the receipt dedup swallowed redeliveries of
  half-processed events (500-retry contract broken) and the outside-refund
  insert collided with the new unique index — closed in the final fix wave:
  null-`processed_at` receipts reprocess; unknown refund ids **claim** an
  existing pending row instead of inserting.
- **`cleanupEvent` does not delete payments/refunds rows** (`ON DELETE
  RESTRICT`), and `provider_payment_id`/`provider_refund_id`/`(provider,
  provider_order_id)` are globally unique while fixtures reuse ids — every
  payments test file needs refunds → payments → `cleanupEvent`, plus receipt
  deletion. Folding this into `cleanupEvent` would pay for itself.
- **`formatPaise(100_000)` prints `₹1,000`, not `₹1,000.00`** — the plan's
  sentences assumed decimals; tests assert reality.
- **Top-level await fails under `node --import=tsx` as CJS** — the ops script
  wraps in `async main()`. The `@/` alias resolves fine under tsx;
  `--conditions=react-server` neutralises `server-only`.
- **`foundry-agent.py` needs `PYTHONIOENCODING=utf-8`** on this machine or
  the research result dies printing Unicode (saved to memory too).

## Key decisions

- The mid-execution rulings (double-refund index, `onReady`, redelivery
  reprocess, claim-don't-insert) all enforce invariants the spec states —
  "at most one full refund per payment", "a retry is exactly what a
  half-processed event needs" — where the plan's sketch under-delivered them.
- The **sweep deliberately applies the by-the-clock rule** to lapsed holds:
  a timely capture whose webhook was dropped and whose attendee never
  reopened the page gets auto-refunded by the sweep. Money is never lost;
  the page-load reconcile heals the common case first. Recorded in
  `lib/payments/reconcile.test.ts`'s header comment — read it before "fixing".

## Deferred minors (triaged FINE TO DEFER by the whole-branch review)

Full list with file references in the review sections of git history; the
notable ones:

- The amount-mismatch stamp claims "for the sweep" but the sweep doesn't
  read `payments.error_code` — fix the comment or surface it in the sweep.
- `STATUS_LINE` says "Complete your payment" to a host viewing a guest's
  awaiting-payment booking, and to an attendee on a keys-missing server.
- A transient failure on the first (proof-carrying) poll loses the checkout
  proof; production heals via webhook, but a **no-tunnel local environment
  then auto-refunds an in-time capture at hold expiry** — retry the proof.
- Capture-after-cancel leaves `cancelled` + refund attached; the page copy
  doesn't mention the refund (spec-permitted, copy inconsistency).
- The refund claim path doesn't guard `amount_paise` — only matters the day
  `refunds_one_per_payment` is relaxed for partial refunds.
- Refusal-sentence parity between `bookEvent` and `startPaidCheckout` is by
  duplicated literals; a shared constant would make it mechanical.
- Narrow `startPaidCheckout`'s provider catch to `RazorpayConfigError` when
  next touching the file.

## Next steps

1. **The launch checklist, before any host onboards** (deliberately not CI):
   Razorpay test-mode keys in `.env.local` → the full sheet walk (pay → poll
   → QR flip, abandoned-sheet resume); the Playwright journey in test mode;
   one real ₹1 live transaction refunded through the host surface; configure
   the dashboard webhook (`<site>/api/webhooks/razorpay`, secret =
   `RAZORPAY_WEBHOOK_SECRET`, events: payment.captured, payment.failed,
   refund.processed, refund.failed). Add a periodic look for
   `payments.error_code = 'amount_mismatch'` and refunds stuck pending
   with null `provider_refund_id` older than a day.
2. **Fold the deferred minors** into the next small pass over `lib/payments/`.
3. **Phase 5 (approvals) is next in the v1 build order** — `request_booking`/
   `approve_booking` exist since Phase 0; the paid path's `pending_approval`
   handling in `confirm_booking` is already tolerated by the processor.
4. `npm run reconcile` is the only sweeper — cron joins the environment-setup
   note the day a second environment exists.
