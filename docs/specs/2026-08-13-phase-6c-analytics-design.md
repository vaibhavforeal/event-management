# Phase 6c — see the business

**Date:** 2026-08-13
**Status:** Designed through brainstorming, four user rulings recorded below.

Row 6 of the build order promises "you can pay hosts and see the business."
6a/6b delivered the paying. This slice is the seeing: the numbers the
operator reads to know whether the pilot is working, on the console they
already open.

## Scope

**In:** one admin-gated SQL aggregate function; a `lib/analytics/` module
(fail-closed read + pure rate math); a server-rendered numbers strip at the
top of `/admin`; tests to the house standard.

**Out, deliberately (user rulings):** host-facing numbers (their own later
slice); trends over time (a totals-plus-statements view says everything the
trend line would at pilot scale); CSV export; caching or rollup tables; any
new indexes. Fees stay ₹0 — the take-rate line exists so the number appears
the day that changes, with no code change here.

## The four rulings

1. **Audience: operator only.** Hosts keep their event list and payout
   statements; nothing new is shown to them.
2. **Metric groups: money, cash ratio, events & attendance.** Trends
   deferred.
3. **Placement: top of `/admin`.** One console, one load — and the
   settlement statements the liability number needs are already computed by
   that page.
4. **Computation: one SQL aggregate RPC** (approach A), rejected: TS-side
   aggregation (recreates the O(platform)/`max_rows` shape 6b removed) and
   rollup tables (machinery pilot volume does not justify).

## Metric definitions (the part that can silently lie)

All money in paise, all derived on read, nothing stored.

| Number | Definition | Why this definition |
|---|---|---|
| GMV | Σ `payments.amount_paise` where status ∈ (`captured`,`refunded`) | A refunded payment was captured first (a capture never un-refunds — `lib/payments/service.ts`). GMV records what passed through the platform. |
| Refunds returned | Σ `refunds.amount_paise` where status = `processed` | `pending`/`failed` refunds have not returned money yet. Net = GMV − this, shown alongside. |
| Take rate | Σ `bookings.commission_paise` on captured bookings ÷ GMV | ₹0/0% across the pilot, by design. |
| Owed to hosts | Σ unpaid statements' `netPaise` from `listSettleableEvents` | **Never a second SQL definition** — `settle()` is the only interpreter of owed money. The page already holds these rows. |
| Settled to date | Σ `payout.net_paise` of `paid` rows in the same page data | The frozen ledger fact, not a recomputation. |
| Cash ratio (count) | confirmed cash bookings ÷ all confirmed bookings | The ratio the v1 design doc says to watch, with its **~30% rethink-threshold** marked on the tile. |
| Cash ratio (value) + cash gross | Σ confirmed cash `subtotal_paise`; ratio against cash + online confirmed gross | A few large cash bookings can hide inside a count ratio. Cash is labelled the host's money, never ours. |
| Events | live = published and not ended; ended = published and `coalesce(ends_at, starts_at) < now()` | Two disjoint counts. "Ended" is 6a's settleable-universe definition, status-filtered per the EH077 ruling. |
| Fill rate | Σ confirmed `bookings.quantity` ÷ Σ `ticket_types.quantity`, published events | Fill of the current book. |
| Check-in rate | tickets with `checked_in_at` ÷ tickets issued, **ended** published events only | The no-show number the WhatsApp reminders exist to move. An ongoing event's unscanned tickets are not no-shows yet. |
| Waitlist depth | count bookings with status `waitlisted` | The waitlist is a booking status, not a table. |

**Scoping rule:** money facts (GMV, refunds, cash) are platform-wide
regardless of event status — money that moved, moved; a cancelled event's
captured payments still count. Fill and check-in are scoped to published
(and ended) events respectively.

## Design

**Migration `20260813000002_admin_business_snapshot.sql`.** One function,
`admin_business_snapshot()`, SECURITY DEFINER, `set search_path = public`,
`is_platform_admin()` gate as its first statement raising **EH071** (the
code already means "not a platform admin"; no new code needed). Returns a
single row of raw counts and paise sums — the table above's left column
minus the two settlement lines, which never enter SQL. House-style
revoke/grant tail (`revoke from public, anon; grant to authenticated,
service_role`). No new tables, no triggers.

**Module `lib/analytics/`.**
- `queries.ts` — `businessSnapshot()`: session client, calls the RPC, and a
  failed read **throws** (`Failed to read the business snapshot: …`). The
  admin page fails to render rather than showing wrong business numbers —
  the same ruling as every money read since 6a.
- `rates.ts` — pure functions from (snapshot row, the page's
  `SettleableEvent[]`) to display values: the ratios, the 30% cash flag,
  owed/settled sums. Zero denominators (no bookings yet, no capacity, no
  ended events) return explicit empty states, never `NaN`. Pure on purpose,
  following `lib/payouts/settlement.ts` — this is where unit tests and
  mutation checks bite.

**UI.** A numbers strip at the top of `app/admin/page.tsx` — server
component, no client JS. It receives the snapshot and the settlement rows
the page already loads; the strip renders tiles grouped money / cash /
events. The cash tile carries the threshold mark and flips its tone at
**count ratio ≥ 30%** (inclusive). Implementation consults the `dataviz`
skill for the stat-tile work (it covers KPI rows explicitly).

**Errors.** RPC failure → throw → the console's error boundary. A page
that cannot know the numbers says so; it does not guess.

## Testing

- **RPC-level** (`lib/analytics/snapshot-rpc.test.ts`): non-admin → EH071;
  anonymous → 42501 (grant pin, per the 6b
  pattern); numbers verified over seeded fixtures with known money — the
  `queries.test.ts` fixture recipes (captured / refunded / cash / forfeit /
  cancelled-event) already exist. The cancelled-event fixture doubles here:
  its captured payment must appear in GMV while its event stays out of the
  settleable lists.
- **Pure-rate unit tests**: empty platform (all zeros → empty states, no
  NaN), the 30% boundary (29.9% no flag, exactly 30% flags, 30.1% flags),
  value-vs-count ratio divergence.
- **Mutation mandate** (full-file, live, no `-t` filters): SQL mutants —
  drop the `refunded` arm from the GMV sum; drop the `processed` filter
  from refunds; drop the ended-only scope from check-ins. TS mutants —
  break a denominator guard; invert the 30% comparison. Each observed red.

## Known limitations, deliberate

- **A paid payout on a since-cancelled event drops out of the owed/settled
  sums** — the EH077 ruling filters cancelled events from
  `listSettleableEvents`, and the liability lines are sums over that list.
  Accepted: the pilot has no event-cancellation flow, so the case is
  hand-crafted only; the payouts table remains the durable record.
- **Take rate reads 0% for the whole pilot.** The line is real; the number
  is not yet.
- **No trends.** Totals only, recomputed on every load. Revisit when a
  month of pilot data makes a week-over-week line mean something.
- **Snapshot and settlement rows load in the same render but are not one
  transaction** — a booking landing between the two reads can make the
  strip and the list disagree by one booking for one reload. Accepted at
  pilot scale.

## Verification

1. Migration applies via `npx supabase migration up` and to a scratch DB.
2. Full suite green; new tests red against the named mutants, observed live.
3. Browser walk on `/admin` as `919999900001`: the strip renders over the
   walkthrough data; a non-admin still 404s; `/host/payouts` unchanged.
