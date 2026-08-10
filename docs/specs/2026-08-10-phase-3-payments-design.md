# Phase 3 — Payments: Razorpay checkout, webhooks, refunds

**Date:** 2026-08-10
**Status:** approved in brainstorming, awaiting implementation plan
**Builds on:** [`2026-08-08-event-platform-v1-design.md`](2026-08-08-event-platform-v1-design.md) (build order row 3),
[`2026-08-09-phase-2a-bookings-design.md`](2026-08-09-phase-2a-bookings-design.md),
[`2026-08-09-phase-2b-qr-scanner-design.md`](2026-08-09-phase-2b-qr-scanner-design.md)

## Goal

A paid, no-approval event goes publish → WhatsApp link → pay → per-seat QR →
door scan, using the same loop free events already have. Money is real from
this phase on: Razorpay in, refunds out, and a webhook — never the attendee's
browser — as the source of truth for whether payment happened.

## Scope

In: the paid checkout path beside `book_free_tickets`, the Razorpay adapter
behind a `PaymentProvider` interface, the webhook route, refunds on both
existing cancel surfaces governed by a per-event cutoff, and reconciliation
for dropped webhooks.

Out, deliberately: cash at the door (`payment_mode = 'cash'` stays refused),
approval flows, waitlists, notifications, payout automation (the ledger
records; settlement stays manual), and any attendee fee or host commission —
both stay wired at ₹0, so turning them on later is data, not schema.

## What already exists

Phase 0 built almost all of the persistence this phase needs, unused until now:

- `payments` — one row per Razorpay order (`unique (provider,
  provider_order_id)`), `provider_payment_id text unique` as the replay
  no-op, `raw_payload jsonb`, `payment_status` enum
  `created/authorized/captured/failed/refunded`.
- `provider_webhook_events` — raw receipts, `unique (provider,
  provider_event_id)`, written before any business logic runs.
- `refunds` — `provider_refund_id text unique`, `refund_status`
  `pending/processed/failed`.
- `payouts` — the settlement ledger; untouched this phase.
- `reserve_tickets` (row-locked inventory, 10-minute hold,
  `awaiting_payment`), `confirm_booking` (issues coded tickets; refuses
  anything not `awaiting_payment`/`pending_approval`), `cancel_booking`,
  `release_expired_holds` — all `SECURITY DEFINER`, service-role only.
- Env slots `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` /
  `RAZORPAY_WEBHOOK_SECRET`, optional in `lib/env.ts`.
- The 50-simultaneous-bookings concurrency test the v1 doc requires before
  this phase ships, green since Phase 2a.

## Decisions taken in brainstorming

**One active booking per attendee per event stays, paid included.** The
partial unique index protects two things at once for paid events: it stops a
buyer holding several 10-minute inventory holds on a 12-seat room, and it
keeps "one person, one booking" true at the door. The cost — a confirmed
buyer wanting one more seat is refused a second order and must cancel
(refund) and rebook, or have a friend book — is recorded as a known
limitation. Rejected: scoping the index to free bookings (loses the
hold-stacking protection exactly where inventory is scarce) and add-on orders
(a real feature with partial-refund accounting attached; nothing about this
choice forecloses it later).

**Refunds follow a per-event cutoff the host sets.** Full refund on attendee
self-cancel until `refund_cutoff_hours` before `starts_at`; after that the
attendee may still cancel — the host wants the seat freed and the no-show
signalled — but no money moves. Rejected: always-full-refund (a 12-seat
supper club eats day-of dropouts) and no-self-refund (makes the cancel button
a trap).

**Host-initiated cancellation always refunds in full**, no matter the clock.
The host is choosing to give the seat back, and it makes "the host removed me
day-of and kept my money" impossible by construction. Rejected: binding the
cutoff symmetrically (a trust hole the pilot's WhatsApp groups would find)
and a per-cancel refund toggle (a money decision in a one-tap UI).

**No fees in Phase 3.** The attendee pays exactly the ticket price;
`convenience_fee_paise` and `commission_paise` continue to store 0. The v1
doc's economics eventually want the attendee fee; the pilot optimises for
hosts saying yes.

**Razorpay Standard Checkout, modal-in-page.** The sheet opens over our
booking page — the right UX on the WhatsApp → phone-browser path the product
lives on, and the surface the v1 doc priced. Rejected: Payment Links (the
attendee leaves the app, and in-app browsers lose the return deep-link;
Phase 5's approval flow can add links on the same core later) and
trusting the checkout success redirect to confirm (a second writer on the
confirm path; the v1 doc decrees the webhook as the only source of truth).

**The webhook confirms; the browser only watches.** The client's success
handler starts polling; it never writes. One processor, fed by the webhook
route and by reconciliation, does every write, and the unique constraints —
not application memory — make replays no-ops.

## Schema delta

One column:

```sql
alter table events add column refund_cutoff_hours integer not null default 24
  check (refund_cutoff_hours >= 0);
```

`0` means "refundable until start". Everything else this phase touches
already exists.

One new function, `begin_paid_booking(p_ticket_type_id, p_attendee_id,
p_quantity, p_attendee_name)` — the mirror of `book_free_tickets`'s guard
block (published, not started, no approval required, quantity within
`max_per_order`) with the price guard inverted (`price_paise > 0`, online
mode only) — which stops at `reserve_tickets`: booking `awaiting_payment`,
hold ticking, **no confirm**. Same posture as every inventory write:
`SECURITY DEFINER` with `set search_path = public` — not `extensions`, which
only `confirm_booking` needs for `gen_random_bytes` ticket codes, and this
function never confirms — `EXECUTE` revoked from
`public`/`anon`/`authenticated`, granted to `service_role`. Refusals get
`EH03x` codes in the `EH010`–`EH022` tradition.

## Money flow

The happy path:

1. Event page form posts to `startPaidCheckout` (server action):
   `begin_paid_booking` takes the hold → the service creates a Razorpay
   Order over REST (`amount = total_paise`) → inserts the `payments` row
   (`created`, `provider_order_id`). If order creation or the insert fails,
   the hold is cancelled immediately and the attendee sees one sentence.
2. Redirect to `/bookings/[reference]`, the checkout home: pay button,
   Razorpay sheet (`checkout.js` via `next/script`), countdown to hold
   expiry. The timer closes the sheet at expiry.
3. Razorpay's `payment.captured` webhook lands: verify signature → dedup
   into `provider_webhook_events` → record capture on the `payments` row →
   `confirm_booking` issues the tickets — the same function, the same
   tickets, the same QRs as the free path.
4. The booking page, which has been polling a small status action since the
   sheet reported success, re-renders into the QR view it already has. The
   sheet's success handler passes its `{order_id, payment_id, signature}` to
   the first poll; the action verifies that checkout signature
   (`verifyCheckoutSignature`) and, if valid, calls `reconcileBooking` once —
   so confirmation does not wait for webhook latency, yet the write is still
   made from Razorpay's API answer, never from the client's claim. Subsequent
   polls are plain DB reads.

An abandoned checkout resumes from the same URL inside the hold window; after
expiry the hold lapses (`expired`), inventory returns, nothing was captured.

**One `payments` row per order, last write wins.** Razorpay allows several
failed attempts and then a success against one order; `unique (provider,
provider_order_id)` means the row records the order's outcome.
`payment.failed` updates the error fields; every raw payload, including
superseded failures, lives forever in `provider_webhook_events`. One row per
attempt would fight a constraint Phase 0 chose deliberately.

**Capture after the hold expired (or after a cancel): auto-refund.** The
attendee dawdles past ten minutes in the sheet and pays anyway; the seat may
be resold. `confirm_booking` refuses — so the processor records the capture
and creates a full refund. Money never sits against a seat that does not
exist. The client-side timer makes this rare; the auto-refund makes it
harmless.

**Amount check before confirm.** The processor confirms only when the
captured amount equals the booking's `total_paise`. The order amount is
server-set, so a mismatch should be unreachable — it records the payment,
skips confirm, stamps an error for the sweep, and admits nobody. `EH021`'s
"believed unreachable, one predicate" precedent.

**Booking endings for paid bookings:** cancelled with refund → `refunded`;
cancelled past cutoff (no money back) → `cancelled`; checkout abandoned →
`expired`.

## Refunds

Both cancel surfaces — the attendee's own cancel and the host's
remove-from-guest-list — keep their one front door,
`lib/bookings/service.cancelBooking`. It gains a typed initiator (today the
prose reasons `'cancelled by attendee'` / `'cancelled by host'` carry that
fact informally) and, after the seat is freed, hands money to
`lib/payments/service.refundIfOwed`:

- looks for a captured payment on the booking; none → done (free bookings
  and abandoned checkouts cost nothing extra),
- applies `refundDecision({initiator, startsAt, cutoffHours, now})` — a pure
  function in `lib/payments/refund-policy.ts`, the whole cutoff rule in one
  tested place: host → `full`; attendee before cutoff → `full`; attendee
  after → `none`,
- checks `refunds` for an existing row (at most one full refund per payment,
  `provider_refund_id` unique behind it), inserts `pending`, calls the
  provider. If the Razorpay call fails the row stays `pending` without a
  `provider_refund_id` and the sweep retries; the seat is already freed
  either way.

`refund.processed` / `refund.failed` webhooks move the row's status; the
booking flips to `refunded` when the refund is created, not when Razorpay
settles it — the attendee's seat decision is final at cancel time.

The cancel UI states consequences before the tap: inside the cutoff "you'll
be refunded ₹500", outside it "past the refund window — no refund". The
public event page and the booking page carry the policy in one sentence
("Free cancellation until 24 h before start").

## Application modules

| File | Responsibility |
|---|---|
| `lib/payments/provider.ts` | The `PaymentProvider` interface: `createOrder`, `listOrderPayments`, `createRefund`, `verifyWebhookSignature`, `verifyCheckoutSignature`. The seam the v1 doc designed for vendor change, and the mocked seam in every integration test. |
| `lib/payments/razorpay.ts` | The adapter: plain `fetch`, HTTP basic auth, four endpoints — no SDK dependency (the `qrcode` runtime-weight lesson). Signatures are HMAC-SHA256 compared with `crypto.timingSafeEqual`; Razorpay's scheme is its own, **not** `standardwebhooks` (that package serves the Supabase SMS hook and stays there). |
| `lib/payments/service.ts` | `startPaidCheckout`, `processWebhookEvent`, `reconcileBooking`, `refundIfOwed`. The **third and last** file permitted to import `lib/supabase/admin.ts`; the eslint fence names all three. Identity is a `Caller` throughout. |
| `lib/payments/refund-policy.ts` | Pure. The cutoff rule, IST-aware via `lib/events/datetime.ts`. |
| `lib/payments/rpc-errors.ts` | `EH03x` → door-quality sentences, `lib/checkin/rpc-errors.ts`'s shape. |
| `app/api/webhooks/razorpay/route.ts` | POST only. Raw body → signature verify (bad → 401) → dedup insert keyed by `x-razorpay-event-id` (duplicate → 200 immediately) → dispatch `payment.captured` / `payment.failed` / `refund.processed` / `refund.failed` → stamp `processed_at` or `error`. Processing failures return 500 on purpose: Razorpay retries on non-2xx, and a retry is exactly what a half-processed event needs. |
| `app/e/[slug]/…` | The booking form learns the paid path: price shown, posts to `startPaidCheckout`, plus the refund-policy sentence. |
| `app/bookings/[reference]/…` | The checkout home: pay button + sheet + countdown while `awaiting_payment`; a status-polling client component after sheet success; the existing QR view once confirmed. Renders nothing new when the booking is free-confirmed — the page's current shape is the end state. |
| `app/host/events/…` (form) | `refund_cutoff_hours` field, default 24. |
| `eslint.config.mjs` | The admin-import fence grows to name `lib/payments/service.ts`. |

Env: the three `RAZORPAY_*` vars stay optional — a free-only checkout must
boot without a Razorpay account — and `startPaidCheckout` fails loudly when
they are missing. The key id is not a secret and reaches the checkout client
component as a prop from the server component.

## Reconciliation

One processor, two feeders. `reconcileBooking(bookingId)` fetches the
order's payments from Razorpay and pushes them through the same functions the
webhook route uses; the unique constraints make double-application a no-op.

- **Where the attendee is looking:** the booking page server component calls
  it whenever it renders an `awaiting_payment` booking that has a `payments`
  row — a dropped webhook heals exactly where someone is staring at
  "payment pending".
- **Where nobody is looking:** an ops script (`npm run reconcile`) sweeps
  `awaiting_payment` bookings past their hold and `refunds` stuck `pending`
  with no `provider_refund_id`. No pg_cron and no deploy-target cron yet;
  that joins the environment-setup note the day a second environment exists.

A useful side effect: local dev and the physical-phone test can complete a
paid booking **without a webhook tunnel** — the page-load reconcile does the
same work the webhook would have.

## Testing

- **Pure units:** `refund-policy` (cutoff boundaries in IST, the
  initiator×clock matrix), signature verification against fixture vectors
  (valid, tampered body, wrong secret), `rpc-errors` sentences.
- **Integration, local stack** (the suite's existing shape):
  `begin_paid_booking` guards by SQLSTATE (free event refused, unpublished,
  started, approval-required, cash); processor idempotency — the same
  `payment.captured` payload applied twice yields one confirm and one set of
  tickets; capture-after-expiry yields a `refunds` row and an unconfirmed
  booking; the cancel matrix (attendee inside/outside cutoff, host any time)
  yields the right `refunded`/`cancelled` endings and at most one refund.
  The provider is the mocked seam — `provider.ts` earns its existence here.
- **Webhook route, action-test style** (service mocked): bad signature →
  401 and nothing written; duplicate `x-razorpay-event-id` → 200 without
  reprocessing; processing throw → 500 with `error` stamped.
- **Fixtures:** captured Razorpay payloads replayed including duplicates and
  out-of-order delivery (a `payment.failed` arriving after the capture must
  not regress the `payments` row), per the v1 doc.
- **Deliberately manual, on the launch checklist not in CI:** the Playwright
  journey against Razorpay test mode, and one real ₹1 transaction in live
  mode before any host onboards. Webhooks cannot reach a laptop; the
  reconcile path covers the local loop.

## Known limitations, deliberate

- **One active booking per attendee per event, paid included.** A confirmed
  buyer wanting one more seat is refused a second order; the workarounds are
  cancel-and-rebook (now with refund mechanics) or a friend booking.
  Relaxing this later is a migration on one partial index.
- **No partial refunds.** `full` or `none`; the `refunds` schema already
  supports amounts below the payment for the day that changes.
- **`refunded` means "refund created", not "settled".** Razorpay settlement
  lag is visible in `refunds.status`, not on the booking.
- **One order per booking's lifetime.** A failed attempt retries against the
  same order inside the hold; a lapsed hold means a fresh booking, not a
  revived one.
- **No un-check-in, still** — carried from Phase 2b.
