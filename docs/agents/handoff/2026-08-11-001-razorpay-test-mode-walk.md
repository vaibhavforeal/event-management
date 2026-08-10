# Handoff — The Razorpay test-mode walk: the paid loop against the real API

**Date:** 2026-08-11
**Branch at end of session:** `master` @ `153af4c`, pushed; no repo code changed after that commit
**Suite:** unchanged since the merge (482 tests, 46 files, green at `781b51f`)

---

## Goal

Run the first item on Phase 3's launch checklist: the test-mode walk — prove
the paid loop (publish → Pay ₹500 → Razorpay sheet → confirmation → QR)
against the **real** Razorpay test API, which no CI test can do because the
provider is the mocked seam everywhere in the suite. Continues
[`2026-08-10-002`](2026-08-10-002-phase-3-payments.md), same evening.

## Current state

**The paid loop is proven end-to-end against real Razorpay test mode.** A
published ₹500 event was booked, paid through the live Test Mode sheet (card
`4111…1111` → mock bank → Success), and the booking page flipped to the QR
view in seconds — webhookless, via the first-poll checkout-signature
reconcile, exactly the path built for laptops. Database truth confirmed:
booking `confirmed`, payment `captured` with real ids
(`order_TOALbQUJkv80ja` / `pay_TOAQEJUZGeF7An`), one ticket issued. The
host-removal refund path also ran for real: seat freed, booking `refunded`,
refund row created — and the provider call was refused by a **Razorpay
test-account quirk, not a bug** (below). That row sits `pending` with a null
`provider_refund_id`, which is precisely the sweep-retry shape.

Everything is stopped: dev server killed (including the orphaned `next dev`
child), stack down with backup. Nothing is blocked on code; the pending
refund is blocked on the Razorpay dashboard (a human, two clicks).

## What was accomplished

- Repaired `.env.local`: the keys had been pasted under Razorpay's dashboard
  names (`key_id`/`key_secret`); renamed to `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`,
  added a local placeholder `RAZORPAY_WEBHOOK_SECRET` (all three must exist
  for `razorpayProvider()`; the webhook secret is unused locally since
  webhooks cannot reach a laptop). Verified the key is `rzp_test_` before
  touching anything that could move money.
- Diagnosed and fixed a "JWT issued at future" 500 on every page — Docker/WSL
  VM clock drift from the day's hard shutdown, not an app bug.
- The full browser walk (Playwright-driven): host form (cutoff field live) →
  publish → paid event page (Pay ₹500 bar + policy sentence) → checkout home
  (countdown, enabled pay button) → real Test Mode sheet (prefill worked) →
  mock bank Success → "You're going", Ticket 1 of 1.
- Guest-list removal: "Removing refunds ₹500 in full." shown before the tap;
  removal freed the seat, flipped the booking to `refunded`, created the
  refund row, and handled the provider refusal exactly as designed (pending
  row, logged, sweep retried it on demand).
- Root-caused the refund 400 with direct API probes plus issue-tracker
  research; recorded the quirk in the agent memory alongside the clock-drift
  fix.

## Files changed

No repo files changed. `master` is untouched since `153af4c`.

| File (outside git) | What it now does |
|---|---|
| `.env.local` (untracked) | Carries the three `RAZORPAY_*` vars under their correct names; test-mode key; placeholder webhook secret pending the real dashboard value at deploy time |

## Files in flight

- `btw Which UI language is better for.txt` — the user's own untracked
  scratch file in the repo root; deliberately left alone.
- **Dev DB test data, deliberately kept as evidence:** event `acfe6977-…`
  ("Razorpay Walkthrough Supper", slug `razorpay-walkthrough-supper-pfgctj`,
  published, ₹500, starts 2026-08-11 19:30 IST); booking `9FEQ9S9Y`
  (`refunded`); its captured payment; refund row `c210048c-…` (`pending`,
  null provider id — the sweep's target). The event is public on the local
  feed until it starts; delete it after the refund settles if it bothers.

## Failed attempts

- **Appending to `.env.local` with `printf >>` corrupted the key secret**:
  the file had no trailing newline, so the appended `RAZORPAY_WEBHOOK_SECRET`
  line glued onto the secret's line. Detected by name-only inspection and
  split back apart with sed — but check for a trailing newline before ever
  appending to that file.
- **Grepping for `RAZORPAY` found nothing** at first because the user's paste
  used the dashboard's field names — when env vars "aren't there", list the
  file's variable names (values stripped) before concluding anything.
- **`9999999999` is rejected by the checkout sheet** as an invalid mobile;
  a plausible number (`9123456780`) passes.
- **The refund 400 briefly looked like an adapter bug.** Probes proved
  otherwise: even an empty body 400s, while the payment reads
  `captured: true, amount_refunded: 0`. It is the balance quirk below.

## Key decisions

- **Placeholder webhook secret locally** rather than skipping the var:
  `razorpayProvider()` requires all three, verification only runs on inbound
  webhooks, and none can arrive locally. The real value must come from the
  dashboard webhook config at deploy time — the placeholder must never be
  copied to a deploy environment.
- **Booked as the host's own user** instead of minting a second attendee:
  nothing forbids it, and this walk validates the money path, not the social
  graph. The two-user flow was already exercised in Phase 2b's walk.
- **Left the walk data in the dev DB** (previous walks cleaned up): the
  pending refund row is a live fixture for the next step — settling it
  through `npm run reconcile` is itself launch-checklist verification.

## What a fresh agent would otherwise rediscover

- **Razorpay TEST-mode refunds fail with `BAD_REQUEST_ERROR: "invalid
  request sent"` when the test balance is ₹0** — fresh accounts; captured
  test payments don't credit the balance until simulated settlement.
  Confirmed against razorpay-node issues #438/#454. Fix: add test
  balance/refund credits in the dashboard (or wait for test settlement),
  then `npm run reconcile`.
- **"JWT issued at future" after a hard shutdown = WSL VM clock drift.**
  `wsl.exe -d docker-desktop hwclock -s` fixes it in seconds, no restarts.
- Stopping the backgrounded `npm run dev` still orphans the `next dev` child
  (known since Phase 1); it was killed by PID this session.
- Both quirks are also in the agent memory
  (`event-hoster-dev-environment.md`), so future sessions see them at start.

## Next steps

1. **Settle the pending refund**: Razorpay dashboard (test mode) → add test
   balance / refund credits → `npm run db:start` → `npm run reconcile` →
   verify refund `c210048c-…` gains a `rfnd_` id and `refunds retried: 1`;
   the later `refund.processed` webhook equivalent is covered by the claim
   path if it ever arrives. Blocked on the dashboard (human).
2. **Optionally script this walk** as the Playwright test-mode journey the
   spec's checklist names, now that every selector and step is known
   (this handoff + the session transcript are the storyboard).
3. **The ₹1 live transaction and the dashboard webhook config** remain
   blocked on a deploy target existing; do not run live mode before the
   test refund above has settled cleanly.
4. **Phase 5 (approvals)** is the next build-order phase; nothing from this
   walk blocks it.
