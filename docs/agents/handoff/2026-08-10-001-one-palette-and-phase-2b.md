# Handoff — One light-only palette, and Phase 2b: QR tickets and the door scanner

**Date:** 2026-08-10
**Branch at end of session:** `master` @ `fd2d061`, pushed to `origin`
**Suite:** 376 tests, 35 files, all green. Typecheck, lint and build clean.

---

## Goal

Work through [`2026-08-09-002`](2026-08-09-002-atomic-writes-and-phase-2a-bookings.md)'s
next-steps list. Items were picked interactively, smallest first: the booking
404 page and the `revalidatePath` guards, then "dark mode" (item 5), then
Phase 2b (item 1). Item 2 — the one-active-booking rule for paid orders — was
deliberately not taken and is still open.

## Current state

Everything is merged, pushed and green. Nothing is blocked. The local Supabase
stack is **stopped** (with backup); no dev server is running; the phone's adb
tunnel was removed.

**Phase 2b is complete and phone-verified.** The full free-event loop now
works: publish → WhatsApp link → book → per-seat signed QR on the booking page
→ host scans at the door (or taps the guest list) → green with a name, amber
with a time on a rescan. The physical Android camera path was verified on a
real handset (Chrome via `adb reverse`), and the write it produced was
confirmed in the database: exactly one ticket checked in, `checked_in_by` the
host's profile, `checked_in_offline` false.

**Branches:** `phase-2b-qr-scanner` is kept and pushed, joining
`phase-0-foundations` and `phase-1-events` as the phase record. 2b merged
`--no-ff` as `fd2d061`.

**What does not exist yet:** paid bookings, approvals, cash, waitlists,
notifications, offline check-in (Phase 7 by the v1 build order), un-check-in
(deliberate, recorded in the spec).

## What was accomplished

**The two small handoff items.** `/bookings/[reference]` got its own
`not-found.tsx` (a mistyped reference is the expected case), and both cancel
actions stopped taking paths from form fields: `isEventSlug()` now shape-checks
the slug and a UUID pattern the eventId before either reaches
`revalidatePath`. The failing test caught the real thing:
`revalidatePath("/host/events/../../../login/attendees")`.

**One palette, light only.** The app had three colour systems — pinned hex on
`/e/[slug]`, zinc/neutral utilities on the signed-in pages, `dark:` variants on
login alone — and under `prefers-color-scheme: dark` the middle group broke
(share-link input at ~1.1:1, secondary text at ~2.5:1, measured by a Codex
audit of every colour surface). Resolved by promoting the event page's paper
palette to six `@theme` tokens in `globals.css`, converting all 17
colour-bearing files onto them, deleting the dark media query, and declaring
`color-scheme: only light` (also the opt-out from Chrome-on-Android
auto-darkening, and the first `color-scheme` this app ever declared — native
date/number controls were an OS lottery before). Verified in the browser:
zero `prefers-color-scheme` rules survive in any stylesheet.

**Phase 2b, spec to merge.** Brainstormed (three decisions below), spec at
`docs/specs/2026-08-09-phase-2b-qr-scanner-design.md`, plan at
`docs/plans/2026-08-10-phase-2b-qr-scanner.md`, then executed subagent-driven:
eight commits, a fresh implementer per task, a review after each (all clean —
zero fix rounds across nine tasks), a whole-branch review at the end (verdict:
ready to merge, nothing above Minor). 44 new tests, 332 → 376.

## Files changed

Only the files a reader needs a map for. `git log` has the rest.

| File | What it now does |
|---|---|
| `app/globals.css` | The palette: `paper/ink/muted/line/accent/raised` tokens, `color-scheme: only light`, and the header explaining why light-only is a decision. Every colour in the app resolves through this file |
| `supabase/migrations/20260811000001_ticket_checkin.sql` | `check_in_ticket` + `check_in_next_ticket`: atomic test-and-set, `already_checked_in` as a returned outcome with the original time, `EH020`–`EH022`, service-role only |
| `lib/checkin/` | Mirrors `lib/bookings/`: `service.ts` (the **second and last** file allowed to import `admin.ts`), pure `authorize.ts` (`mayCheckIn`), `rpc-errors.ts` |
| `lib/tickets/queries.ts` | RLS ticket reads; `listBookingTickets` ordered `created_at, id` — the same order `check_in_next_ticket` admits in |
| `lib/tickets/qr.ts` | `ticketQrPayload` + `ticketQrSvg` (server-only; the `qrcode` package is the phase's one new dependency) |
| `lib/events/slug.ts` | Gains `isEventSlug()` — an allowlist of exactly what `buildSlug` emits, for values interpolated into paths |
| `app/bookings/[reference]/page.tsx`, `not-found.tsx` | One QR per ticket with labels and code tails; the 404 that does not confirm whether a guessed reference is real |
| `app/host/events/[id]/scan/` | The scanner: page derives the per-event key behind the ownership check; `scanner.tsx` (BarcodeDetector loop, verdict cards); `scan-state.ts` (the tested reducer — one QR, one flight, one verdict); `actions.ts` (`checkInByCode`) |
| `app/host/events/[id]/attendees/` | Guest list rows show "n of q in" with a Check in +1 button; `checkInAttendee` action beside the cancel |
| `eslint.config.mjs` | The admin-import fence now names two files; probe watched failing during Task 3 |
| `lib/env.ts` | `TICKET_SIGNING_SECRET` is **required** now (`.min(32)`, no longer optional) |

## Files in flight

**Nothing.** Tree clean, `master` pushed, no stashes. `.env.local` (untracked,
gitignored) gained a generated `TICKET_SIGNING_SECRET` — every fresh checkout
and any future deploy target needs one or every server page throws at env
validation. The SDD workspace under `.superpowers/sdd/` was deleted after the
final review, per its instructions.

## Failed attempts

**The `codex-rescue` subagent dies on dispatch** — its definition pins
`claude-sonnet-4-5`, which this Foundry deployment does not have. The error
arrives only after launch, costing a dispatch. Fix: pass an explicit `model`
override when dispatching it. (Generalises last session's note about
`model: "sonnet"`.)

**A scratch script outside the repo cannot resolve the repo's packages.**
`npx tsx C:\...\jobs\...\make-qr.mts` failed on `Cannot find package 'dotenv'`
— Node resolves from the script's location, not cwd. Copy scratch scripts into
the repo root, run, delete.

**A Task 8 implementer died mid-flight on a connection error.** The
SDD report-file convention is what made this cheap: `SendMessage` to the same
agent id with "continue from where you stopped, check `git status` first"
resumed it losslessly. The report file is the persistent memory; trust it over
re-dispatching.

**`adb` is not on PATH** on this machine. It lives at
`C:\Users\vaibh\AppData\Local\Android\Sdk\platform-tools\adb.exe`. The phone
shows the authorization prompt only after the first `adb devices`.

**The plan invented a test helper that did not exist** (`asUser`). The
controller caught it at dispatch time and mapped it onto the repo's real
mechanism (`tests/helpers/session.ts`'s `signInAs`); the implementer adapted
cleanly. When writing plans against this repo: the session mock installs as an
import side effect and the module under test needs a top-level `await import`.

**Task 5's report misidentified the seeded host as fixed-OTP.** It was a
`+1555…` user; Task 6 repointed that host's phone to `919999900003` (dev DB
only) to finish browser verification. Cross-task claims about dev data are
claims.

**`supabase db psql` does not exist** in this CLI version. `supabase db query`
is the working form (returns JSON).

## Key decisions

**Light-only is forced, not defaulted.** Rejected: shipping a dark palette
(none has been designed; the halfway state measured worse than none) and
tokens-with-dark-later-only (chosen middle would have left the OS preference
active with nothing to act on). If dark is ever wanted it is one media-query
block in `globals.css` plus removing `only light` — every colour resolves
through the tokens now.

**All QRs on the booking page.** Rejected: per-ticket bearer links (a new
unauthenticated URL surface for a convenience the pilot has not asked for) and
one-QR-per-booking (fights the schema's one-ticket-per-person design). Groups
forward screenshots, which is how this product already moves everything.

**Native `BarcodeDetector`, zero decoder dependency.** Rejected: bundling jsQR
(~45 KB decoded per camera frame on mid-range Androids) and the dual pipeline.
Hosts without it (iOS Safari, Firefox, desktop) get a plain fallback message
and the guest-list tap — which every host needs anyway for the guest with no
QR.

**Local HMAC verify + server write.** Rejected: server-does-everything (every
garbage QR costs a round trip on venue signal, and Phase 7 offline needs the
local verify anyway). The server never trusts the client verdict — the 128-bit
code lookup is the authority; `p_event_id` is matched in the SQL `WHERE` so a
code from another event is `EH020` even from its own host.

**"Already checked in" is an outcome, not an error** — a door sees it hourly,
and the amber card needs the original time. Refusals (`EH020`–`EH022`) raise;
duplicates return.

**No un-check-in**, recorded in the spec's known-limitations: a mistap shows
amber with the mistap's own timestamp, which a 12-seat supper club host will
recognise. Undo is a real feature with an audit-trail question attached.

## What a fresh agent would otherwise rediscover

- **Phone testing recipe:** enable USB debugging, `adb reverse tcp:3100
  tcp:3100` (full adb path above), then the phone's Chrome opens
  `http://localhost:3100` — a secure context, so camera and BarcodeDetector
  work. Desktop Chromium has **no** BarcodeDetector, so the scan page's
  fallback path is what CI and desktop browsing exercise.
- **Deferred minors from the final review live only here now** (the SDD ledger
  was deleted): `checkInAttendee` presence-checks but does not shape-check
  `bookingId`, so junk shows a raw Postgres sentence to the host (fix:
  `UUID_PATTERN.test`); `checkInByCode` deliberately revalidates nothing while
  its sibling revalidates the guest list — wants a one-line comment before
  someone "fixes" the asymmetry; the generic rescan sentence and the EH022
  sentence are each duplicated once (a shared `lib/checkin/sentences.ts` starts
  paying for itself); the racing loser of two simultaneous next-ticket taps can
  under-report `tickets_in` by one (display-only, READ COMMITTED); the spec's
  "search_path = public, extensions" sentence over-generalises — the code is
  right, the spec sentence is wrong.
- **Dev DB state** (survives `db:stop`, which backs up): event
  `71272bd9-9400-4457-be2b-988e7e67a249` ("Diwali Supper Club",
  slug `task6-diwali-supper`), host sign-in `9999900003` / OTP `123456`,
  booking `G09SPK0K` with ticket 1 (`…6218eb`) checked in by the phone test
  and two tickets unchecked. The user then explored the host panel from the
  phone, so there may be additional draft events.
- **The paper palette's semantic exceptions:** status badges and error text
  keep Tailwind's green/amber/red/blue — they are statuses, not chrome. The
  one legitimate `bg-white` in the app is behind the QR (quiet-zone contrast).
- **`qrcode` drags its CLI deps (yargs etc.) into runtime dependencies** —
  server-only, zero client-bundle impact, known weight.
- Docker Desktop still starts only via PowerShell; `localhost:3100` never
  `127.0.0.1:3100`; `C:` is ~98% full; all as recorded in the prior handoffs.

## Next steps

1. **Decide the one-active-booking rule for paid orders before Phase 3.**
   Carried from the last handoff, still undecided, and Phase 3 is the next
   phase in the v1 build order. The partial unique index is not scoped to free
   bookings, so a buyer wanting a second, separate paid order will be refused.
2. **Phase 3 — payments.** Razorpay orders, webhook idempotency (the
   `payments.provider_payment_id` unique is already there), refunds on
   cancellation. The v1 doc's build order has this next; `standardwebhooks`
   is already a dependency.
3. **Fold the deferred minors** (list above) into the first small pass over
   `lib/checkin/` — none block anything.
4. **Note `TICKET_SIGNING_SECRET` wherever environment setup is recorded**
   the day a second environment (CI, deploy target) appears — it is now
   hard-required and its absence breaks every server page, which reads as an
   app bug and is not one.
