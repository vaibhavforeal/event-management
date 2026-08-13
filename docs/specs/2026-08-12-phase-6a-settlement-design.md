# Phase 6a — The settlement loop: the money reaches the host

**Date:** 2026-08-12
**Status:** approved in brainstorming; plan pending
**Builds on:** [`2026-08-08-event-platform-v1-design.md`](2026-08-08-event-platform-v1-design.md) (build order row 6),
[`2026-08-10-phase-3-payments-design.md`](2026-08-10-phase-3-payments-design.md),
[`2026-08-11-phase-5a-approvals-cash-design.md`](2026-08-11-phase-5a-approvals-cash-design.md),
[`2026-08-11-phase-5b-waitlist-design.md`](2026-08-11-phase-5b-waitlist-design.md)

## Goal

Money that attendees have paid is sitting in a Razorpay account and no
part of the product says whose it is. This phase answers that: after an
event ends, the operator sees exactly what each host is owed, pays it by
UPI, and records the transfer; the host sees the same statement from
their side. That is the whole of build-order row 6's "you can pay hosts",
and it is what stands between the pilot and its first real settlement.

## Scope

In: a `platform_admins` table and the `is_platform_admin()` predicate; a
pure settlement calculator over an event's bookings, payments and
refunds; `forfeited_paise` on `payouts` and a freeze-on-paid trigger; two
admin-gated `SECURITY DEFINER` functions (`record_payout`,
`admin_host_payout_target`); an `/admin` console listing ended events
with their computed numbers and a drift flag; a `/host/payouts` statement
page.

Out, deliberately: **turning fees on** — `commission_paise` stays 0 across
every booking path, and the ledger is built to be correct on the day it
stops being 0 (see "Decisions"); business analytics of any kind — GMV,
take rate, cohort views, the "see the business" half of row 6, which is a
later slice; automated payouts or Razorpay Route; host KYC workflow
(`hosts.kyc_status` stays reference data a human reads); any change to
checkout, webhooks, refunds or reconciliation; and the 5b carry-forward
list, which shares a phase number with this work and nothing else.

## What already exists

The foundations were laid in Phase 0 and have never been touched since.
Read this before concluding anything is missing.

- **`payouts`** (`20260808000001_core_schema.sql:327`) — `host_id`,
  `event_id`, `gross_paise`, `commission_paise`, `net_paise`,
  `payout_status`, `utr_reference`, `notes`, `paid_at`. A
  `payouts_one_per_event` unique constraint, so recomputation updates
  rather than duplicates, and a `payouts_net_is_consistent` CHECK
  asserting `net = gross - commission`. RLS is on with one policy,
  `payouts_select_own`, scoped by `current_host_id()`. `authenticated`
  has `select` and nothing else: writes must go through a definer
  function or the service role.
- **`fee_rules`** — the full table, service-role only, and **zero rows
  are written by anything**.
- **`hosts.commission_bps`** — default 1000, never read.
- **`lib/pricing/`** — `calculatePrice`, `estimateGatewayCost`,
  `netPlatformMargin`, all pure and exhaustively tested, and with **no
  production callers at all**. Every booking path passes the SQL
  functions' `default 0` for both fees.
- **`payout_status`** — `pending | paid | on_hold`, unused.
- **`refunds`** — one row per payment (`20260811000003`), status
  `pending | processed | failed`.

Three absences shape the design more than any of the above:

1. **There is no admin concept anywhere in the codebase.** No role, no
   claim, no allowlist, no `/admin` route. It is designed here from zero,
   and it is the only thing guarding real money.
2. **Nothing ever sets `events.status = 'completed'`.** The enum value is
   dead and `app/host/page.tsx:12` says so.
3. **A `cancelled` booking can be holding captured money.**
   `refundDecision` returns `'none'` when an attendee cancels past the
   event's `refund_cutoff_hours`, and `refundIfOwed`
   (`lib/payments/service.ts:508`) then returns before creating a refund
   or flipping the status. The payment stays `captured`. Nothing in the
   product says whose that money is.

## Decisions taken in brainstorming

- **The ledger sums the booking rows; fees stay ₹0.** `commission_paise`
  is read from `bookings.commission_paise`, never from a constant, a rate
  or `hosts.commission_bps`. The ledger is therefore correct at 0 and
  correct the day fees turn on, with no rewrite. Rejected: wiring
  `lib/pricing` into `reserve_tickets`, `approve_booking`,
  `promote_from_waitlist` and `book_free_tickets` now — it recreates four
  SQL functions 5b had just rewritten and takes real money before the CA
  sign-off the v1 design lists as an open item. Also rejected: computing
  commission at settlement from `hosts.commission_bps`, which
  retroactively reprices past events whenever a rate changes and makes
  `bookings.commission_paise` a dead column contradicting its own schema
  comment.
- **Forfeited money is the host's, counted separately.**
  `refund_cutoff_hours` is a per-event field the host sets, so a
  past-cutoff cancellation is the host's own policy earning out, and
  under merchant-of-record we collected it on their behalf. It enters
  `gross_paise` and is *also* recorded in `forfeited_paise` as a memo, so
  a statement can explain its own number. The known cost: if the seat was
  resold, the host is paid for it twice — which is what a no-refund
  policy means everywhere. Rejected: the platform silently keeping it
  under a rule no host agreed to, and refunding always, which would
  discard the no-show protection the cutoff exists to provide and rewrite
  a Phase 3 decision from inside Phase 6.
- **An event is settleable when `coalesce(ends_at, starts_at)` is
  readable and strictly in the past.** Derived, not stored. The only
  invariant enforced is that an event that has not ended cannot be
  settled; beyond that the operator chooses when to pay, which is what
  manual pilot settlement means. Rejected: making `completed` real via
  the hourly cron — it duplicates a derivable fact, drifts the moment a
  host edits the event time, and adds a writer to the event state machine
  inside a phase that is otherwise read-only over events. Also rejected:
  no guard at all, which lets `payouts_one_per_event` lock in a number
  for an event that has not happened.
- **`ends_at` is nullable, and the coalesce is not cosmetic.**
  `events_end_after_start` reads `ends_at is null or ends_at > starts_at`,
  so an event may legitimately carry no end time — and a rule written
  against `ends_at` alone would leave every such host permanently
  unpayable, silently. The fallback to `starts_at` is what makes them
  settleable at all.
- **`hasEnded` is a new predicate and must not reuse `hasStarted`.**
  `lib/events/datetime.ts:90` fails *closed toward started*: an
  unreadable time returns `true`, because there the safe direction is a
  missing Book button. Settlement inverts that — an unreadable or absent
  time must return `false`, because the money direction of "closed" is
  refusing to pay, not paying early. Same principle, opposite sign, which
  is precisely why it is a separate function rather than a call to the
  existing one.
- **Authorisation is a `platform_admins` table and an
  `is_platform_admin()` predicate used inside RLS.** It mirrors the
  existing `current_host_id()` / `owns_event()` helpers, keeps the admin
  console on the ordinary session client, and puts enforcement in the
  database. **Nothing joins the service-role fence**, which stays at four
  files. Rejected: a fifth fenced module with a TypeScript gate (moves
  enforcement out of the database into an `if`), and an env-var phone
  allowlist (needs a redeploy to rotate, and leaves the database unable
  to tell an admin from anyone else).
- **Freeze on paid; surface the drift.** Once `status = 'paid'` the
  amounts and the UTR are immutable, because they record what actually
  left a bank account. Recomputation still runs and the console shows the
  delta. Rejected: recomputing freely, which loses the record of what was
  actually sent — the one thing a settlement ledger exists to keep. Also
  rejected, for now: an adjustment row carrying the delta forward, which
  is the correct double-entry answer but is forbidden by
  `payouts_one_per_event` and introduces carry-forward balances into a
  phase meant to be the minimal loop.
- **The console writes only `paid` or `on_hold`; `pending` stays
  unused.** During manual settlement you read a number, send UPI, then
  record it — there is no moment where a row exists but no money has
  moved. Stated here rather than left as a second unexplained dead enum
  value.
- **The settlement math is a pure TypeScript module, not SQL.** Phase 4's
  `sweep.ts` is the precedent and the v1 design's testing section is the
  reason: "fee math and capacity math are where silent money bugs live."

## Schema delta

One migration. No existing column changes type or meaning.

```sql
create table platform_admins (
  profile_id  uuid primary key references profiles (id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now()
);
alter table platform_admins enable row level security;
-- No policies, deliberately: RLS is on and nothing is granted, so the table is
-- invisible to anon and authenticated — exactly as fee_rules and
-- provider_webhook_events are. Seeded by hand against the service role.

create or replace function is_platform_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from platform_admins where profile_id = auth.uid()); $$;

alter table payouts
  add column forfeited_paise bigint not null default 0
    check (forfeited_paise >= 0);
```

`forfeited_paise` is a memo: it is a *subset* of `gross_paise`, not an
addend, so `payouts_net_is_consistent` is untouched and keeps meaning
what it always meant.

**The freeze is a trigger, not an application check.**
`payouts_frozen_when_paid`, `before update on payouts for each row`,
raises when `old.status = 'paid'` and any of `gross_paise`,
`commission_paise`, `net_paise`, `forfeited_paise`, `utr_reference`,
`status` or `paid_at` differs. `notes` stays editable — annotating a
settled row is how an out-of-band correction gets recorded.

**Three `SECURITY DEFINER` functions, each gated on `is_platform_admin()`
or `owns_event()` in its first statement:**

- `record_payout(p_event_id, p_gross_paise, p_commission_paise,
  p_forfeited_paise, p_status payout_status, p_utr_reference, p_notes)`
  — derives `host_id` from the event, refuses an event whose
  `coalesce(ends_at, starts_at)` is not in the past, computes `net`, and
  upserts on the `payouts_one_per_event` conflict target. `paid_at` is
  set when the status is `paid`.
- `admin_host_payout_target(p_host_id)` — returns `upi_id` and
  `bank_account_ref`.
- `host_settlement_rows(p_event_id)` — host-or-admin gated via
  `owns_event()` / `is_platform_admin()`, returns per-booking money
  facts with no instrument detail; exists because hosts may not read
  `payments`.

That second function exists for a reason worth naming, because it is not
obvious and would otherwise be discovered halfway through implementation:
**`upi_id` and `bank_account_ref` are withheld by a column grant**
(`20260808000003_rls_policies.sql:218`), not by a policy. RLS filters
rows, not columns. An admin on the ordinary session client is still
`authenticated`, so no policy — however permissive — can reach those two
columns. Widening the grant would hand every host's bank details to every
signed-in visitor, since `hosts` is deliberately world-readable so event
pages can name their host. A definer function is the only route that
neither leaks the columns nor adds a fifth file to the service-role
fence.

**Read policies gain `or is_platform_admin()`** on `events`, `bookings`,
`payments`, `refunds` and `payouts`. Writes are unchanged: everything
still goes through definer functions.

## The settlement math

`lib/payouts/settlement.ts` is pure: given an event's booking rows, their
payments and those payments' refunds, it returns the statement. No I/O,
no clock of its own beyond the `ends_at` it is handed. This is the
feature; everything else is a screen around it.

Which bookings count:

| Booking state | Into gross? | Why |
|---|---|---|
| `confirmed`, online, payment `captured`, no refund row | **yes** | the ordinary case |
| `confirmed` but carrying a refund row | **no** | see below — added after the Task 2 review |
| `cancelled`, payment `captured`, no refund row | **yes**, and into `forfeited_paise` | past the cutoff, so the money stayed; it is the host's |
| `confirmed`, cash | **no** | the host already holds the cash; commission on cash is 0 by construction |
| `refunded` | **no** | the money went back |
| `refunded`, `refunds.status = 'failed'` | **no** | fail toward not paying — an underpayment is correctable, an overpayment is a conversation |
| `pending_approval`, `awaiting_payment`, `expired`, `waitlisted` | **no** | no money ever moved |

**A refund disqualifies a booking whatever its status.** The first draft of
this table let a refund disqualify only a `cancelled` booking, on the
reasoning that a refunded booking is already excluded by status. The Task 2
review found the gap: `applyRefundEvent` (`lib/payments/service.ts:565`)
inserts the refund row *before* flipping `payments.status`, so if that second
write throws, a processed refund sits against a still-`captured` payment on a
still-`confirmed` booking until Razorpay redelivers. Settlement inside that
window would pay out money that had already gone back to the attendee. The
guard costs nothing at the pilot's ₹0 and moves the way the rest of this
module argues: an underpayment is a correction, an overpayment is a
conversation.

Refunds are all-or-nothing — `refund-policy.ts` types the decision as
`'full' | 'none'` and there is no partial path — so excluding a
`refunded` booking is exact, not an approximation. If partial refunds are
ever introduced, this table is the thing that breaks, and it should break
loudly.

The arithmetic:

- `gross_paise` = Σ `subtotal_paise` over the counting set. Face value —
  the host's money.
- `commission_paise` = Σ `bookings.commission_paise` over the **same**
  set. Zero today for every row.
- `net_paise` = `gross_paise - commission_paise`.
- `forfeited_paise` = Σ `subtotal_paise` over the cancelled-and-kept rows
  alone.
- **Convenience fees never enter a payout.** They are platform revenue,
  paid by the attendee on top of face value, and a host statement that
  mentioned them would be describing money that was never theirs.
- **Cash is displayed, not stored.** The calculator returns a cash total
  so a statement reconciles against what the host collected at the door,
  but no column holds it: it is derivable from bookings forever, and a
  stored copy could only ever disagree.

## The flows

**Settling an event.** The operator opens `/admin`, which lists events
that have ended. Each row carries its computed statement, its
`payouts` row if one exists, and a drift flag. The operator reads the
net, pays by UPI — `admin_host_payout_target` supplies the destination —
and records the transfer with its UTR. `record_payout` writes `paid`.

**Holding an event.** Same list, same numbers, but the host's KYC is
`pending` or something is disputed. `record_payout` writes `on_hold` with
a note. The row is not frozen; a later `record_payout` can settle it.

**Drift.** The console recomputes every listed event on every load and
compares against the frozen row. A `paid` row whose recomputation differs
is flagged with the delta. Nothing is stored — a drift column could only
go stale, and the recomputation is the same call the page already makes.

**The host reading a statement.** `/host/payouts` shows, per event: what
they were paid and its UTR, or — for an ended event with no payout row —
what they are owed. Cash collected at the door is shown alongside and
labelled as money that never passed through the platform.

## Screens

- **`/admin`** — the ended-events list described above. A non-admin gets
  **404, not 403**: the existence of the console is not something an
  unauthorised visitor needs confirmed.
- **`/host/payouts`** — the statement list, reachable from `/host`.

Both are server components reading through the ordinary session client.
Neither is reachable without a session; both derive their authorisation
from the database rather than from a check they perform themselves.

## Application modules

| Module | Responsibility |
|---|---|
| `lib/events/datetime.ts` | Gains `hasEnded(startsAt, endsAt, now)` — beside `hasStarted`, and failing closed in the opposite direction. |
| `lib/payouts/settlement.ts` | **Pure.** The table and the arithmetic above. No imports beyond `lib/money`. |
| `lib/payouts/queries.ts` | Session-client reads: settleable events, an event's booking/payment/refund rows, a host's statements. |
| `lib/payouts/service.ts` | The two RPC wrappers. **Not** service-role — it calls definer functions as the signed-in admin, so it does not join the eslint fence. |
| `lib/payouts/admin.ts` | `requirePlatformAdmin()` for the route segment: `notFound()` when the predicate is false. |
| `app/admin/` | The console and its Server Actions. |
| `app/host/payouts/` | The host statement page. |

## Testing

Every new assertion is mutation-tested before it is believed. The
standing lesson from the previous session — sixteen tests that could not
fail, across two phases — applies with more force here than anywhere,
because a settlement test that cannot fail is a wrong payment nobody
catches.

- **The pure calculator**: one test per row of the counting table, plus
  an event with no bookings, an all-cash event, an event that is entirely
  forfeits, and the `refunds.status = 'failed'` case. These are unit
  tests over literal rows — no database.
- **The fees-on rehearsal**: a fixture carrying non-zero
  `bookings.commission_paise` proving the ledger already computes
  commission correctly. The claim that fees turn on without touching this
  module is thereby tested, not asserted.
- **RLS**, extending `lib/supabase/rls.test.ts`: a host cannot read
  another host's payouts; an admin can read across hosts; a signed-in
  non-admin cannot see `platform_admins` at all, matching the existing
  assertion for `fee_rules` and `provider_webhook_events`.
- **The definer gates**: `record_payout` and `admin_host_payout_target`
  each raise for a non-admin caller. Tested by calling them as a
  signed-in ordinary user, not by inspecting their source.
- **The freeze**: updating a `paid` row's amounts raises **at the
  database**. The test writes through the service role, so it proves the
  trigger and not an application check.
- **The ended guard**: `record_payout` refuses an event still in the
  future; accepts one whose `ends_at` is null but whose `starts_at` has
  passed; and `hasEnded` returns `false` for an unreadable time, which is
  the opposite of what `hasStarted` returns for the same input. That
  contrast is worth an explicit test — it is the kind of thing a later
  reader "fixes" by delegating to `hasStarted`.
- **Screens**: an anonymous visitor to `/admin` is redirected to login
  by `requireUser()`; a signed-in non-admin gets 404 — the non-disclosure
  applies to authenticated non-admins, not to the signed-out. A host's
  `/host/payouts` shows their own statements and no others.

## Known limitations, deliberate

- **Commission is ₹0, so every net equals its gross.** The ledger is
  real; the take rate is not yet. This is the pilot's stated posture and
  is gated on a CA sign-off, not on code.
- **`pending` and `completed` remain dead enum values.** `pending`
  because manual settlement never passes through it; `completed` because
  settleability is derived from `ends_at`.
- **A drifted `paid` row is corrected out of band.** The product shows
  the delta and records a note; it does not carry a balance forward.
  Adjustment rows are the honest fix and need `payouts_one_per_event` to
  go.
- **A resold forfeit pays the host twice.** Accepted with the forfeit
  decision. It is visible in `forfeited_paise` if it ever needs auditing.
- **An event with no `ends_at` reads as settleable from its start
  time**, so a long event could in principle be settled while it is still
  running. Settlement is a manual operator action against a visible date,
  so the exposure is a human reading a row wrong rather than a system
  paying early. The alternative — an arbitrary "assume events last N
  hours" constant — would be a fiction in the schema.
- **The first admin is seeded by hand**, against the service role. There
  is no invite flow and no UI for granting admin, which is correct for a
  one-operator pilot and would not be for two.
- **`hosts.kyc_status` gates nothing.** `record_payout` will settle to an
  unverified host; the console shows the status and the operator decides.
  Enforcing it in SQL would be a policy the pilot has not written yet.
- **No pagination on either list.** PostgREST's `max_rows = 1000` is the
  ceiling, and a pilot that exceeds 1000 ended events has better problems
  — but this is the same silent-tail failure 5b recorded for the waitlist
  query, and it is written down here for the same reason.

## Carried into Phase 6b

Shipped knowingly. Each came out of the task reviews or the whole-phase
verification, was triaged as non-blocking, and is written down here so the
next phase inherits a list rather than a surprise. The manual walk itself —
all seven steps, in a real browser against the local stack — found nothing
new: the non-admin 404, the settle, the reload, the host's mirror, the
drift banner and the EH073 refusal all behaved exactly as designed.

**`listHostStatements` reads the whole platform to find one host's
events.** It lists every ended event on the platform, then calls
`host_settlement_rows()` once per event and discards the EH076 refusals
for the ones the caller does not own. Correct — the RPC is the authority
and refuses what is not theirs — but the work is O(all ended events), one
RPC round-trip each, on every load of `/host/payouts`. The fix is a
`host_id` filter on the events query, with the RPC kept as the gate.
**Landed 2026-08-13 (early 6b):** `getCurrentHostId()` gates the list and
the events query filters on `host_id`. Two consequences: an admin visiting
`/host/payouts` no longer sees every host's events (they see their own, or
nothing if they host nothing); and with only the caller's own events left
in the loop, an RPC failure now throws instead of being skipped — the skip
had become a silently dropped statement of the caller's own money.

**Nothing checks `forfeited_paise <= gross_paise`.** `settle()` cannot
produce such a statement — forfeits are a subset of counted gross — but
`record_payout` accepts the two numbers independently and the `payouts`
table carries no CHECK tying them together, so a hand-crafted admin call
could record a payout whose forfeit exceeds its gross. The net CHECK has a
sibling missing.

**The freeze on a paid row guards the money and not the pointers.** The
trigger refuses changes to the amounts and the status of a `paid` payout,
but `host_id` and `event_id` stay mutable, and DELETE is stopped only by
the absence of any policy or grant — service-role sessions can still
re-point or remove a settled row. The freeze should name the pointer
columns and a no-DELETE policy should say so explicitly.

**Test debt, named.** The payout-RPC test called "refuses an anonymous
caller" runs as a signed-in non-admin, so EH071's true anonymous case is
unexercised under that name; EH072 (no such event) has no test at all;
the `is_platform_admin` branch of `host_settlement_rows`'s gate — an
admin reading another host's rows — is untested; and `platform_admins`'s
invisibility is pinned only in aggregate, not per layer (the absent
SELECT policy and the revoked grants are two defences, tested as one).

**TS and SQL disagree on a booking with two captured payments.**
`joinPaymentFacts` takes the *first* captured payment per booking and asks
whether *that one* has a refund; `host_settlement_rows()` asks whether
*any* captured payment exists and whether *any* refund exists against the
booking's payments. The payments flow is built never to produce a second
captured payment on one booking, so the disagreement is unreachable today
— but the two surfaces would count that pathological row differently, and
the arithmetic module should not have two definitions of one fact.

**The suite carries one pre-existing flake, in Phase 3's module.**
`lib/payments/webhook-processor.test.ts` › "the same capture racing
itself under two fresh event ids" failed the full run and 1 of 4 re-runs
(`could not confirm booking …: cannot confirm a booking with status
expired`). The window is real: two concurrent deliveries, one reads
`awaiting_payment` before the other's expiry commits, and its
`confirm_booking` then refuses. In production the failed delivery answers
non-2xx and the provider's retry self-heals it. Not this phase's code —
`lib/payments` is untouched on this branch — but 6b inherits the flake.

**The money sub-queries in `bookingRowsFor` fetch across ALL ended events
in single `.in()` calls, so PostgREST's `max_rows = 1000` truncates at
roughly 20–50 events' worth of bookings** — far earlier than the
1000-ended-events posture the limitations section states. Truncation
understates statements (phantom drift); the 6b fix for
`listHostStatements`' O(platform) shape should cover this sibling.
**Landed 2026-08-13 (early 6b):** `bookingRowsFor` runs its three-query
chain once per event, so every response is bounded by one event's rows and
the limitations section's 1000-per-event posture holds again.

**Neither list filters `events.status`, so ended drafts (and cancelled
events) render ₹0 statement rows on both pages, and `record_payout` would
freeze a ₹0 paid row for a draft;** and an admin visiting `/host/payouts`
sees every host's events labelled "Owed to you". Clutter and wrong copy,
not a leak; needs a decision about cancelled-event settlement in 6b.
**Partially landed 2026-08-13 (early 6b):** the admin-copy clause is gone
with the `host_id` filter above. The draft/cancelled ₹0-row question stays
open on the cancelled-event-settlement ruling.

**`payoutRowsFor` still swallows its read error** — the sibling of the
`bookingRowsFor` fix the final review landed. A failed `payouts` read
renders a settled event as unsettled, so the operator sees a form instead
of a frozen row. Harmless in the write path — `record_payout`'s upsert
meets the freeze trigger and EH070 refuses — but the page lies until the
next successful read. Same three-line fix, same direction: a failed read
must not read as "no payout".
**Landed 2026-08-13 (early 6b):** throws like its sibling, exported for
unit-testing like its sibling, stub-tested and mutation-verified the same
way.
