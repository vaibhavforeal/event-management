# Handoff — Phase 6 closed: 6b hardening (two waves) and 6c analytics

**Date:** 2026-08-14 (session ran 2026-08-13 ~18:00 → past midnight)
**Branch at end of session:** `master` @ `b50c516`, pushed to origin
**Suite:** 938 tests / 78 files, green (was 904/75 at session start)
**Phase branches kept locally:** `phase-6b-settlement-hardening`, `phase-6c-analytics`

---

## Goal

Pick up from [`2026-08-13-001`](2026-08-13-001-phase-6a-settlement.md) and
work the next steps in order. That grew, with the user's explicit "continue
6b" and "Phase 6" rulings, into: **finish row 6 of the build order
entirely** — the 6b hardening backlog the 6a reviews had named, then the
deferred "see the business" half as Phase 6c.

## Current state

**Phase 6 is done and pushed.** Three merges landed on master today:
`2541c3b` (early 6b: fail-closed reads, per-host/per-event scoping),
`86fe687` (6b remainder: EH077, SQL guards, test debt, TS/SQL unification,
the TOCTOU fix), `b50c516` (6c: the admin analytics strip). Nothing is
blocked on code.

**The spec's "Carried into Phase 6b" list is fully closed** with dated
Landed notes in `docs/specs/2026-08-12-phase-6a-settlement-design.md`. The
old recurring webhook flake is **fixed, not tolerated** — a future flake in
`webhook-processor.test.ts` is a regression of the fix, not the known
noise; the agent memory was flipped to say so.

**One verification box is unchecked:** nobody has *looked* at the strip.
Everything is test-proven; the two-minute browser walk is next step 1.

The Supabase stack is running with all 20 migrations applied via
`npx supabase migration up` — **never `db:reset` this session**, so the
walkthrough fixtures (`walk-ended-supper` with `UTRWALK0001` and its ₹700
standing drift, `walk-future-supper`) survived. Fees still ₹0 (CA-blocked);
WhatsApp go-live unchanged (WABA-blocked, person).

## What was accomplished

- **Early 6b** (planned inline, implemented directly, fresh-eyes review):
  `payoutRowsFor` throws on failed reads; `listHostStatements` gated by
  `getCurrentHostId()` + `host_id` filter (admins no longer see everyone's
  events on `/host/payouts`; the RPC-loop skip became a throw via exported
  `hostStatementRowsFor`); `bookingRowsFor` runs per event, ending the
  cross-event `max_rows` truncation. Five mutations observed red live.
- **6b remainder**, after three AskUserQuestion rulings (published-only
  settlement; all hardening items; include the TOCTOU fix): migration
  `20260813000001` (EH077, `payouts_forfeit_within_gross`, pointer-column
  freeze, explicit delete revoke), the four named test-debt items paid,
  `joinPaymentFacts` unified to SQL's any-captured semantics, and the
  webhook TOCTOU closed TS-side. Eight mutations observed red live,
  including SQL mutants applied via psql in the container.
- **Phase 6c end-to-end by the book**: brainstorming (4 rulings) → spec
  (`docs/specs/2026-08-13-phase-6c-analytics-design.md`) → plan
  (`docs/plans/2026-08-13-phase-6c-analytics.md`) → **subagent-driven
  execution** (5 tasks, fresh implementer + task review each, final
  whole-branch review, one fix wave). The strip on `/admin`: GMV/net,
  take rate, owed/settled (summed from the page's `settle()` statements),
  the 30%-cash watch tile, events/waitlist, fill/check-in. Nine more
  mutants killed live across build + fix wave.

## Files changed

The map; `git log 894e8de..b50c516` and the two 6b merges have the detail.

| File | What it now does |
|---|---|
| `lib/payouts/queries.ts` | All reads fail closed; both lists filter `status='published'`; host list scoped by `host_id`; `bookingRowsFor` per-event; exports `payoutRowsFor`, `hostStatementRowsFor` for unit tests |
| `lib/payouts/settlement.ts` | `joinPaymentFacts` now carries `host_settlement_rows()`'s exact semantics — any captured payment, any captured payment with a refund |
| `lib/payouts/service.ts` | EH077 mapped to the published-only sentence |
| `lib/payments/service.ts` | `applyPayment` treats `confirm_booking`'s check_violation as a lost race (`isLostConfirmRace`): re-read, return on confirmed, fall through to refund — the old 500-and-retry window is closed |
| `supabase/migrations/20260813000001_settlement_hardening.sql` | Forfeit CHECK, pointer freeze, EH077 in `record_payout`, delete posture stated |
| `supabase/migrations/20260813000002_admin_business_snapshot.sql` | The one analytics aggregate: EH071-gated, 14 columns, `p_event_ids` test seam |
| `lib/analytics/rates.ts` | Pure rate math; fractions-or-null (never NaN); `payoutTotals` sums owed/settled from statements; `CASH_RATIO_THRESHOLD` 0.3 inclusive |
| `lib/analytics/queries.ts` | `businessSnapshot()` — fail-closed read of the RPC |
| `app/admin/business-strip.tsx` | The six tiles; cash label floors so "30%" never renders unflagged |
| `app/admin/page.tsx` | Loads the snapshot and renders the strip above the settlement list, one `listSettleableEvents` load feeding both |
| `lib/supabase/types.ts` | Gained the `admin_business_snapshot` RPC types |
| `lib/supabase/rls.test.ts` | `platform_admins` invisibility pinned to `42501` per layer |
| `lib/payouts/*.test.ts`, `lib/analytics/*.test.ts`, `lib/payments/webhook-processor.test.ts` | The new nets: EH072/EH077/anon-42501/admin-branch/pointer-freeze/CHECK tests; snapshot fixture math; the amplified concurrent-batch race test (probabilistic, documented in-test) |
| `docs/specs/2026-08-12-…-settlement-design.md` | 6b list closed with dated Landed notes + two triage rulings |
| `docs/specs/2026-08-13-phase-6c-analytics-design.md`, `docs/plans/2026-08-13-phase-6c-analytics.md` | The 6c contract and its executed plan |

## Files in flight

- **`btw Which UI language is better for.txt`** — the user's untracked
  scratch file, left alone as always.
- **`lib/supabase/database.types.ts`, untracked** — an unreferenced
  `supabase gen types` dump a 6c task subagent left behind. It duplicates
  the hand-maintained `types.ts` and could mislead a future import. The
  controller's delete was denied by the permission gate; **the user should
  delete it**.
- **Two phase branches kept local, unpushed** — convention (nine local
  phase branches now).
- **The Supabase stack is running**; `npm run db:stop` frees it. Docker was
  DOWN at session start (machine had rebooted) — started via PowerShell per
  memory; the supabase containers auto-restarted with the daemon.

## Failed attempts

The expensive-to-rediscover ones, mostly mine:

- **The TOCTOU mutant survived six solo runs** of the plan's sequential
  amplified race test — the window only opens under DB contention that a
  solo file run doesn't generate. The kill came from restructuring the test
  into a concurrent batch: five expired bookings on ONE ticket type, all
  ten deliveries in a single `Promise.all`, so every
  `release_expired_holds` fights over the same rows and SKIP LOCKED leaves
  stale reads everywhere. Mutant died run 5/6, observed live. If you need
  to re-verify: solo sequential pairs will NOT reproduce it.
- **My first draft of that test reused the fixtures' fixed provider ids**
  (`pay_test_1`/`rfnd_test_1`) across rounds — both are table-wide UNIQUE
  and it would have exploded on round two. Caught only by reading
  `tests/helpers/payments.ts` before writing the plan.
- **I nearly narrowed `applyPayment`'s refund tail to expired/cancelled
  only.** That "tidier" shape turns a benign capture-replay on an
  already-refunded booking into an eternal 500-retry loop (throw → retry →
  throw). The catch-all tail into idempotent `ensureRefund` is
  load-bearing; there is now a comment saying so.
- **A delete-blocking trigger on paid payouts was designed and rejected:**
  `cleanupEvent` legitimately deletes paid fixtures via service role, and
  the freeze trigger prevents un-paying them first, so the trigger would
  strand every test teardown. The shipped posture is the explicit revoke +
  documented service-role allowance.
- **Platform-wide snapshot assertions would flake** — the suite runs files
  in parallel against one database, so absolute totals are moving targets.
  Hence the `p_event_ids` seam (spec-amended): tests scope to their own
  events for exact numbers; the unscoped test asserts monotone bounds only.
- **The `sonnet` subagent alias broke mid-session** (deployment lost
  `claude-sonnet-4-5`) *after* several sonnet reviews had already
  succeeded. `fable` and `haiku` dispatches work; `opus` was already broken
  per the 6a handoff. Expect aliases to rot mid-session.
- **Writes to `AppData\Local\Temp` are blocked** by the user's
  write-scope-guard hook — mutant SQL files went to a repo-local
  `.mutants/` dir instead (deleted before committing).
- **The 6c final review caught a mutation-blind spot the plan missed**: the
  checked-in subquery's ended-only scope had no fixture that could kill its
  removal. Fixed with a fourth (checked-in, live-event) ticket. Its sibling
  remains: **the commission `exists` predicate is untestable while every
  fixture but one carries ₹0 commission** — dormant until fees exist,
  recorded in memory.

## Key decisions

- **EH077: only a published event settles** (user ruling). Both lists
  filter in TS; `record_payout` refuses in SQL between EH072 and EH073.
  Why: bookings only attach to published events but `unpublishEvent` lets a
  draft hold captured money, and the forfeit rule would pay a host forfeits
  for an event they cancelled themselves. Money on cancelled/unpublished
  events settles by refunds. Revisit only when a real cancellation flow
  (with refund sweep) exists.
- **TOCTOU fixed TS-side, not with a new SQL function.** `confirm_booking`
  already takes FOR UPDATE and is race-safe in-tx; the race was purely the
  TS check-then-call across transactions. Treating the refusal as the lock
  reporting the outcome is a ~20-line change; a combined
  expire-decide-confirm SQL function was rejected as touching Phase 3's
  whole flow for the same result.
- **`joinPaymentFacts` unified to SQL's semantics** (any captured, any
  captured-with-refund) rather than SQL to TS's first-captured — SQL was
  deployed and its shape matches the "any refund disqualifies" ruling.
- **6c rulings (user):** operator only; money + cash ratio + events &
  attendance (trends deferred); top of `/admin`; one SQL aggregate RPC —
  TS-side aggregation rejected (recreates the O(platform)/max_rows shape 6b
  removed), rollups rejected (pilot volume).
- **Owed/settled never get a SQL definition.** They are summed in TS from
  the statements the page already computes — `settle()` stays the only
  interpreter of owed money. A paid row contributes its FROZEN net.
- **Cash flag fires at count ratio ≥ 30% inclusive**, and the label floors
  so a 29.5% share can't read "30%" unflagged.
- **Two review findings triaged as deliberate, in the spec — don't
  re-litigate:** availability-vs-fail-closed (partial rendering IS the
  fail-open bug; blast radius unchanged from 6a's knowing trade), and the
  race test being a probabilistic net (verified live, documented in-test).

## What a fresh agent would otherwise rediscover

- **Error codes: EH078+ are free.** EH001–EH077 taken; EH077 = published-only
  settlement.
- **`admin_business_snapshot(p_event_ids default null)`** — the array is a
  TEST seam; production always passes nothing. Every column reference in it
  must stay table-qualified (OUT params shadow column names; plpgsql errors
  on ambiguity).
- **The webhook flake memory is inverted now**: a `webhook-processor.test.ts`
  failure means the 6b fix regressed. Re-verify the mutant; never quarantine.
- **`npx supabase migration up` applies pending migrations without wiping
  dev data** — this is why the walk fixtures still exist. `db:reset`
  remains destructive and there is still no `seed.sql`.
- **SQL mutants are applied with**
  `docker exec -i supabase_db_Event_Hoster psql -U postgres -d postgres < file.sql`
  and restored by re-running the real migration file (the constraint
  `already exists` error on re-run is expected noise).
- **Mutation runs are full-file, observed live, never `-t`-filtered** — the
  memory on manufactured false kills still stands; this session added the
  "probabilistic mutants need contention, run until red, record honestly"
  corollary.
- **Subagent-driven execution artifacts** live under `.superpowers/sdd/`
  per plan (git-ignored); this plan's workspace was deleted after the
  clean final review, per the skill.
- Local login test numbers `919999900001/2/3`, OTP `123456`; dev server
  port **3100** (`npm run dev`); admin is the profile of `…9001`.

## Next steps

1. **The browser walk (two minutes):** `npm run dev` → `/admin` as
   `919999900001` — the strip renders over the walk data (settled
   `walk-ended-supper` feeds "settled", its ₹700 drift still shows in the
   list below); `919999900003` still 404s; `/host/payouts` as
   `919999900002` unchanged.
2. **Delete `lib/supabase/database.types.ts`** (untracked subagent
   leftover; controller was permission-blocked).
3. **Phase 7 — PWA, offline check-in, TWA wrapper** — is the next
   build-order row. Start with brainstorming per convention; the v1 design
   doc's §3 (signed ticket cache, local HMAC verify, IndexedDB queue,
   last-write-wins) is the seed material.
4. **When fees turn on** (CA-blocked, a person): seed non-zero-commission
   fixtures so the snapshot's commission `exists` predicate becomes
   mutation-testable; the take-rate tile then shows a real number with no
   code change.
5. **WhatsApp go-live** unchanged from
   [`2026-08-12-001`](2026-08-12-001-waitlist-and-notifications.md) steps
   1–4 — blocked on a person (WABA, templates, Vercel Pro, env order).
6. **Housekeeping:** `npm run db:stop` when not working; C: is ~96% full;
   consider a `seed.sql` before the next `db:reset` bites someone.
