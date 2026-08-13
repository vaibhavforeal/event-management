# Handoff — Phase 6a (the settlement loop), specced, planned, shipped

**Date:** 2026-08-13
**Branch at end of session:** `master` @ `8411568`, pushed to origin
**Suite:** 904 tests / 75 files, green (was 819/71 at session start)
**Phase branch kept locally:** `phase-6a-settlement` (19 commits over `9aa171c`)

---

## Goal

Pick up where [`2026-08-12-001`](2026-08-12-001-waitlist-and-notifications.md)
left off and start **Phase 6** — the next build-order row (payout ledger,
host dashboard, admin console). In brainstorming that row was sliced: this
session's aim became **Phase 6a, the settlement loop** — after an event
ends, the operator sees what each host is owed, pays by UPI, records the
transfer; the host sees the same statement. Analytics ("see the business")
and turning fees on were explicitly deferred.

Execution was subagent-driven end to end: a fresh implementer per task, a
task review after each, a whole-branch review at the end, with a
mutation-testing mandate in every brief.

## Current state

**Phase 6a is merged and pushed.** Nothing is blocked on code.

The settlement loop works and was walked in a real browser, all seven
steps: non-admin 404, admin sees ended events, record payment with UTR,
amounts frozen on reload, host mirror shows the same net and UTR with no
instrument detail, drift banner with the right delta after a late refund,
not-ended refusal (EH073). All 18 migrations apply to a scratch database.

**Fees are still ₹0 everywhere.** The ledger sums `bookings.commission_paise`
and is proven (with non-zero fixtures) to be correct the day that stops
being zero. Turning fees on is gated on the CA sign-off, not on code.

**There is no admin UI for granting admin.** `platform_admins` is seeded by
hand against the service role. The dev database currently has one admin:
the profile of test number `919999900001`.

The Supabase stack was left **running**. The WhatsApp go-live sequence from
the previous handoff is untouched and still blocked on a person.

## What was accomplished

- **Wrote `docs/specs/2026-08-12-phase-6a-settlement-design.md`** through
  brainstorming with four user rulings (slice, fees, admin auth model,
  freeze-on-paid), then **`docs/plans/2026-08-12-phase-6a-settlement.md`**
  (8 tasks, exact code, per-task mutation lists).
- **Executed all 8 tasks** subagent-driven and merged `8411568`: `hasEnded`,
  the pure `settle()` calculator, `platform_admins` + `is_platform_admin()`
  in RLS, the payout writer (`record_payout`, freeze trigger,
  `admin_host_payout_target`, `host_settlement_rows`), the session-client
  reads, `/admin`, `/host/payouts`, and whole-phase verification.
- **Two mid-execution human rulings**, both recorded in spec and plan: a
  refund row disqualifies *any* counted booking whatever its status (the
  Task 2 review found `applyRefundEvent` writes the refund row before
  flipping payment status, so confirmed+captured+refunded is reachable and
  would over-pay); and `listSettleableEvents` keeps its database-answered
  admin gate (the plan's "no if in this file" design was unsatisfiable —
  events are world-readable on purpose).
- **A final-review fix wave** landed fail-closed error handling on the money
  reads (`bookingRowsFor` throws rather than reading a failed refunds query
  as "no refunds", which over-pays), with a mutation-verified test after
  the first attempt's skip was rejected on re-review.
- **Root-caused the suite flake** the previous handoff said to watch for:
  a real TOCTOU in `processWebhookEvent`. Second sighting, now recorded in
  the spec's 6b section and in agent memory.

## Files changed

Two migrations, a new `lib/payouts/` module, two screens, ~2,475 insertions.
`git log 9aa171c..8411568` has the detail; this is the map.

| File | What it now does |
|---|---|
| `lib/events/datetime.ts` | Gains `hasEnded` — fails closed *opposite* to `hasStarted`: unreadable time means don't pay. Do not merge them |
| `lib/payouts/settlement.ts` | **The feature.** Pure `settle()` — the only interpreter of the counting rules — plus `joinPaymentFacts` for callers that may read payments |
| `lib/payouts/queries.ts` | Session-client reads: `listSettleableEvents` (admin, DB-answered gate, derived drift), `listHostStatements` (via `host_settlement_rows`), `hostPayoutTarget`. `bookingRowsFor` throws on any failed read |
| `lib/payouts/service.ts` | `recordPayout` wrapper; EH070–EH075 mapped to operator sentences |
| `lib/payouts/admin.ts` | `requirePlatformAdmin()` → `notFound()`; the console 404s, never 403s |
| `supabase/migrations/20260812000002_platform_admins.sql` | `platform_admins` (invisible to every browser client), `is_platform_admin()`, five admin read policies — `to authenticated` is load-bearing |
| `supabase/migrations/20260812000003_payout_settlement.sql` | `forfeited_paise`, the freeze trigger (EH070, fires for service role too), `record_payout`, `admin_host_payout_target` (the way past the column grant), `host_settlement_rows` (money facts, no instrument detail) |
| `app/admin/` | The console: statements, drift banner (paid rows only), record/hold form. Amounts never come from the form — recomputed server-side at submit |
| `app/host/payouts/page.tsx` | The host statement: frozen number when paid, recomputed when owed, cash labelled as never-ours |
| `tests/helpers/db.ts` | `seedPlatformAdmin`, `seedCapturedBooking` (booking RPCs refuse started events, so settlement fixtures write rows directly), `SeedOptions.startsAt/endsAt`, and a `cleanupEvent` that finally deletes in FK order instead of leaking |
| `docs/specs/…6a-settlement-design.md` | Amended twice during execution; carries the "Carried into Phase 6b" list |
| `docs/plans/…6a-settlement.md` | Amended for both rulings and a pre-flight JSX fix |

## Files in flight

- **`btw Which UI language is better for.txt`** — the user's untracked
  scratch file, deliberately left alone as in every prior session.
- **`phase-6a-settlement` kept locally, unpushed** — matching convention;
  all seven phase branches are local-only.
- **The dev database was reset during verification** (`db:reset`, no
  `seed.sql` exists), which **wiped the walkthrough data** the previous
  handoffs preserved — `VYRB4SHQ`, `9FEQ9S9Y`, the three walkthrough
  events and their payments are gone. The walk seeded replacements and
  left them deliberately: `walk-ended-supper` (settled, `UTRWALK0001`,
  with a standing ₹700 drift as a living fixture) and
  `walk-future-supper`, host owned by test number `919999900002`.
- **`platform_admins` has one dev row** (profile of `919999900001`).
- **The Supabase stack is running.** `npm run db:stop` frees it.

## Failed attempts

Mostly mine, again. The plan was wrong in ways only execution found.

- **The plan's `settle()` took bookings + payments + refunds — hosts can
  never call that.** `payments` is RLS-denied to hosts by design
  ("aggregate money through payouts instead"). Caught in plan self-review;
  the join became a query concern and `host_settlement_rows` was born.
- **The plan's admin read policies had no `TO` clause**, so anonymous feed
  reads would have evaluated `is_platform_admin()` — needing EXECUTE and
  erroring without it. The pre-existing anon test is the regression guard.
- **The plan's design for `listSettleableEvents` was unsatisfiable**: "no
  authorisation in this file" and "non-admin gets `[]`" cannot both hold
  when events are world-readable. The implementer patched it; the review
  caught the contradiction; the human ruled; spec, plan and comments now
  agree.
- **My brief dropped two spec-mandated calculator cases** (all-cash,
  all-forfeits) in transcription. They were exactly the cases proving the
  accumulators accumulate.
- **New unfailable-test shapes**, beyond last session's sixteen:
  accumulators tested with one item (`+=`→`=` green across 22 tests),
  fixtures with two independent reasons to pass, and — the insidious one —
  **`-t`-filtered mutation runs manufacturing false kills** (the unmutated
  code failed identically under the filter). One task report's mutation
  transcript turned out to be *reconstructed*; the reviewer re-ran it live.
  Full-file runs only; all recorded in the agent memory.
- **Task 4's brief had mutation 2's rationale backwards** (`NULL >= now()`
  does not raise). The implementer corrected it and the mutant still died,
  via a different test. Reviewers confirmed rather than assumed.
- **The Task 4 dispatch died twice on network errors**, the second time
  mid-mutation with work uncommitted. Resuming the same agent worked —
  and my "the migration file is clean" check was wrong, because I grepped
  lines the applied mutation didn't touch. The agent diffed against a
  pristine copy instead. Trust the agent's verification over a spot-grep.
- **The `opus` subagent model alias broke mid-session** after the session
  model changed (resolves to a model this deployment lacks). `fable` and
  `sonnet` dispatches work.
- **A Bash heredoc appending spec text died on SQL quotes** — the same
  large-document lesson as last session, different trap. Write + Edit
  appends, not heredocs, for content with mixed quoting.

## Key decisions

- **Row 6 sliced to 6a = the settlement loop.** Analytics deferred;
  "you can pay hosts" is the provable core. (User ruling.)
- **The ledger sums `bookings.commission_paise`; fees stay ₹0.** Correct at
  zero, correct when fees turn on, no rewrite — and that claim is a test
  with non-zero fixtures, not prose. Rejected: wiring `lib/pricing` into
  four SQL functions now (recreates what 5b just rewrote, and takes money
  before CA sign-off); settlement-time rates (retroactive repricing).
- **Forfeited money is the host's, memo'd in `forfeited_paise`.** Their
  cutoff, their policy earning out; a statement can explain its number.
  Rejected: platform keeping it silently; refunding always.
- **Settleable = `coalesce(ends_at, starts_at)` strictly past.** Derived,
  never stored; `ends_at` is nullable and the coalesce is what keeps
  no-end-time hosts payable. Rejected: making `completed` real via cron.
- **`platform_admins` + `is_platform_admin()` in RLS**; the console runs on
  the session client and the service-role fence stays at four files.
  Rejected: a fifth fenced module; an env-var allowlist.
- **Freeze on paid (database trigger), drift derived on every read.** A
  settled row records what left the bank; recomputation shows the delta;
  correction is out of band, in `notes`, which stays editable.
- **A refund row disqualifies any counted booking, whatever its status.**
  (Mid-execution ruling; closes a reachable over-pay window in
  `applyRefundEvent`'s write ordering.)
- **Money reads fail toward not paying.** A failed refunds read must never
  read as "no refunds" — that direction over-pays. Throw instead.
- **Merged locally to master, branch kept** — per convention. (User choice.)

## What a fresh agent would otherwise rediscover

- **Granting admin is a manual SQL insert** against the service role:
  `insert into platform_admins (profile_id) values ('<uuid>');`. No UI, no
  invite flow — correct for a one-operator pilot.
- **`hosts.upi_id` / `bank_account_ref` are withheld by a COLUMN GRANT, not
  a policy.** RLS filters rows, not columns, so no admin policy can reach
  them — `admin_host_payout_target` (SECURITY DEFINER) is the only route
  that neither leaks the columns to every visitor nor widens the fence.
- **TypeScript `settle()` is the only interpreter of the counting rules.**
  SQL `host_settlement_rows` reports facts (`has_captured_payment`,
  `has_refund` — the latter with deliberately NO filter on
  `refunds.status`). If a second interpreter appears, they will eventually
  disagree about somebody's payment.
- **Error codes EH070–EH076 are taken** (payouts block).
- **The recurring suite flake is root-caused**: TOCTOU in
  `processWebhookEvent` (`lib/payments/service.ts:~393`), self-heals in
  production via provider retry. In memory and the spec's 6b list. Do not
  re-diagnose it.
- **`db:reset` destroys dev data and there is no `seed.sql`** — that is how
  the walkthrough bookings from three prior handoffs vanished this session.
- **Local login test numbers:** `919999900001/2/3`, OTP `123456`
  (`supabase/config.toml`).
- **The spec's "Carried into Phase 6b" section is the authoritative
  deferred list** — every review minor was triaged there and the final
  reviewer ruled all of them correctly deferred. Highlights: `bookingRowsFor`
  hits PostgREST `max_rows=1000` across ~20–50 events' bookings (phantom
  drift when it truncates); `payoutRowsFor` still swallows its read error;
  neither list filters `events.status` (ended drafts render ₹0 rows);
  `listHostStatements` is O(platform), not O(host).

## Next steps

1. **Early 6b, first pick:** the two fail-open/scale siblings the final
   review named — propagate `payoutRowsFor`'s error, and scope
   `bookingRowsFor`/`listHostStatements` per host or per event so the
   `max_rows` ceiling and the O(platform) walk go away together.
2. **Decide cancelled-event settlement** (6b): today an ended cancelled
   event renders a ₹0 row and `record_payout` would freeze it; the 6b
   section holds the open question.
3. **Phase 6 remainder** — analytics ("see the business") — or **Phase 7**
   (PWA, offline check-in) as the next build-order row. Fees-on remains its
   own slice, **blocked on the CA sign-off** (a person).
4. **The WhatsApp go-live sequence is unchanged** from
   [`2026-08-12-001`](2026-08-12-001-waitlist-and-notifications.md) steps
   1–4: WABA (India/INR, irreversible), eight templates under `en`, Vercel
   Pro, then env vars in the load-bearing order. Still blocked on a person.
5. **Consider a `seed.sql`** so `db:reset` stops being destructive to dev
   walkthrough data — this session is the second time that cost something.
6. **Optional housekeeping:** `npm run db:stop`; C: was at 96%.
