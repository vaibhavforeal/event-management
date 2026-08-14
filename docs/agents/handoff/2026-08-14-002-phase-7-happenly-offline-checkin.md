# Handoff — Phase 7: Happenly, the offline door, and the Play Store doorstep

**Date:** 2026-08-14 (session ran ~14:15 → ~21:50 IST)
**Branch at end of session:** `master` @ `c6204c2`, pushed to origin
(github.com/vaibhavforeal/event-management)
**Suite:** 989 tests / 89 files, green (was 938/78 at session start);
typecheck 0, lint 0, `next build` clean
**Phase branch kept locally:** `phase-7-pwa-offline-checkin` (the tenth)

---

## Goal

Pick up from
[`2026-08-14-001`](2026-08-14-001-phase-6b-6c-hardening-and-analytics.md)
and start **Phase 7 — PWA, offline check-in, TWA
wrapper**, the last row of the v1 build order. The user skipped the 001
handoff's browser-walk step and went straight to the phase; mid-brainstorm
this also became the session that **named the product: Happenly**.

## Current state

**Phase 7 is done, merged (`c6204c2`) and pushed.** The v1 build order's
row 7 — and with it the whole v1 table — is code-complete. Nothing is
blocked on code.

What works, test-proven and (mostly) browser-proven:

- The scanner arms a **door pack** (roster in IndexedDB, ticket codes as
  SHA-256 hashes), gives instant local verdicts offline, queues scans
  durably, and drains them idempotently on reconnect;
  `tickets.checked_in_offline` finally gets written, with the device
  timestamp clamped to (now()−24h, now()].
- The app installs as **Happenly** (manifest + icons + themed layout), and
  the scan page **survives a fully-offline reload** — verified live in a
  Playwright-driven production browser this session, along with the
  manifest and the SW being active+controlling. The feed deliberately does
  not load offline (passthrough).
- TWA artifacts are committed: env-gated `/.well-known/assetlinks.json`
  (404 until `TWA_PACKAGE_NAME`/`TWA_CERT_SHA256` exist),
  `twa/twa-manifest.json`, `docs/runbooks/play-store-twa.md`.

**Two verification boxes remain unchecked, both need a human:**

1. **The camera-path airplane walk** (spec's own scope: CI has no camera):
   scanner open with signal as `…9002` → airplane mode → scan a real ticket
   QR → green "offline, will sync" + queue badge → signal back → badge
   drains, sync report line appears, `checked_in_offline = true` in the DB.
2. **The 001 handoff's /admin strip walk** — still nobody has *looked* at
   the Phase 6c analytics strip. It carried over untouched.

The Supabase stack is running with all **21** migrations applied via
`npx supabase migration up` — **never `db:reset` this session either**, the
walk fixtures survived again. Fees still ₹0 (CA-blocked); WhatsApp go-live
unchanged (WABA-blocked); Play submission newly person-blocked (runbook).

## What was accomplished

- **Brainstorm → spec (`71f97ac`) → plan (`c2a15b5`)** by the book. Rulings
  taken: offline reaches the scanner only; TWA prepared not published;
  product named **Happenly** (chosen over the user's "Happnly?" — names
  here travel by voice and WhatsApp, the spelled-like-it-sounds form wins);
  hand-rolled SW over Serwist over Next 16's `experimental.useOffline`.
- **Execution: subagent-driven in parallel waves** (user-directed
  deviation): implementers ran **no git**, the controller committed each
  task's files separately; same-wave agents touched disjoint files; scoped
  vitest per agent, repo-wide gates only at controller checkpoints. 13
  tasks, ~19 commits, per-task reviews (sonnet), three in-loop fix rounds
  (T6, T11, T10), five plan-defect corrections, mutation checks observed
  red live throughout (SQL mutants via psql-in-container included).
- **Final whole-branch review (fable)** found what per-task reviews
  structurally could not: a Critical (`arm()` treating a thrown server
  action as IndexedDB death — a venue-wifi flake would have disabled the
  offline door for the session) and an Important (the spec's "sign in to
  sync" surface existed in no plan task — the actions redirected instead,
  and a background heartbeat could yank the door to /login). One fix wave,
  one scoped re-review, both clean.
- **Housekeeping from 001:** the stray `lib/supabase/database.types.ts` and
  `mutant-output.txt` are deleted.

## Files changed

The map; `git log a7162c3..c6204c2` has the detail (45 files, +2176).

| File | What it now does |
|---|---|
| `supabase/migrations/20260814000001_offline_checkin.sql` | `check_in_ticket` is now 5-arg: defaulted `p_scanned_at` (clamped) + `p_offline`; defaults byte-identical to 2b; conflict branch untouched (first write wins) |
| `lib/checkin/offline/pack.ts`, `contract.ts`, `hash.ts` | Client-safe foundations: DoorPack/PackTicket types + index, the sync wire contract, `sha256Hex` |
| `lib/checkin/offline/verdict.ts` | Pure offline decision tree; DB truth beats device memory; not-on-roster is honest amber |
| `lib/checkin/offline/store.ts` | The ONLY IndexedDB toucher: packs + durable queue; null on unavailability |
| `lib/checkin/offline/sync.ts` | `applyOutcomes`/`drainQueue`: remove-only-on-answer, batch 200, `stopReason` surfaces why a drain stopped |
| `lib/checkin/service.ts` | Gained `buildDoorPack` (codes hashed server-side, confirmed-only) and `syncOfflineCheckIns` (authorize once, per-entry refusals) |
| `app/host/events/[id]/scan/actions.ts` | Gained `loadDoorPack` + `syncOfflineCheckins`; both RETURN the sign-in sentence instead of redirecting (heartbeat safety); `checkInByCode` untouched |
| `app/host/events/[id]/scan/scanner.tsx` | Arms on load, offline fallback on the old dead-end catch, queue badge, session sync report ("scanned here · already in at"), roster header + refresh; an action failure can never kill the store |
| `app/host/events/[id]/scan/scan-state.ts`, `lib/checkin/sentences.ts` | Three offline verdict kinds; NOT_ON_ROSTER / ARMING_UNAVAILABLE / SIGN_IN_TO_SYNC sentences |
| `app/manifest.ts`, icons, `app/layout.tsx` | Happenly identity; viewport themeColor `#0f5e52`; `scripts/make-icons.mjs` regenerates the placeholder wordmark (sharp via npm exec, never a dependency) |
| `public/sw.js` + `public/sw-strategy.mjs` | Module SW, three rules only (static cache-first, scan-page network-first, else passthrough); strategy file is vitest-imported; bump `CACHE_VERSION` to condemn caches |
| `app/sw-register.tsx`, `next.config.ts` | Silent-no-op registration in the layout; no-cache headers for both SW files |
| `app/.well-known/assetlinks.json/route.ts`, `twa/`, `docs/runbooks/play-store-twa.md` | TWA prep + the person-steps runbook |
| `lib/env.ts`, `.env.example` | Optional `TWA_PACKAGE_NAME`, `TWA_CERT_SHA256` |
| `docs/specs/2026-08-08-event-platform-v1-design.md` | §"four things" item 3 amended: first-write-wins, not last-write-wins |
| New test files (10) + extended (4) | RPC clamp/offline/conflict; door pack; sync service; actions; verdict (10 cases); store (fake-indexeddb, the one new dev dep); sync engine; SW strategy; manifest |

## Files in flight

- **`btw Which UI language is better for.txt`** — the user's scratch file,
  untracked, left alone as always. The tree is otherwise clean.
- **`phase-7-pwa-offline-checkin` kept local, unpushed** — convention.
- **The Supabase stack is running**; `npm run db:stop` frees it.

## Failed attempts

The expensive-to-rediscover ones, most of them mine (the plan's):

- **The plan shipped five defects that implementers/reviewers caught.**
  (1) Its non-confirmed fixture used `awaiting_payment`, which violates the
  `bookings_hold_has_expiry` CHECK — `pending_approval` substituted, filter
  still mutation-proven. (2) Its verdict mutation (b) could never go red:
  no test covered pack-checked-in + locally-queued; a tenth test (DB truth
  wins) was the fix. (3) Its mutant-restore instruction for the migration
  is unsafe as written — the migration uses `create function`, so restoring
  needs a **pre-drop of the 5-arg signature** first. (4) Its RPC test read
  `.single()` untyped (TS2339 ×4) and (5) prescribed a `@ts-expect-error`
  that was unused — **vitest never sees type errors (esbuild strips
  types); only repo-wide `tsc` does**, and scoped agents don't run that.
  Gate typecheck at the controller, always.
- **Per-task reviews cannot see cross-task seams.** The one true Critical —
  `arm()`'s catch conflating a failed `loadDoorPack` action with IndexedDB
  death — sat between two halves that each looked right alone. The
  whole-branch final review on the strongest model is not a formality.
- **A spec sentence that gets no plan task silently vanishes.** "Sign in to
  sync" was promised in the spec's failure modes and appeared in zero
  tasks; grep confirmed no implementer dropped it. When writing plans,
  walk the spec's failure-mode list line by line against tasks.
- **The controller itself dropped a dispatch** (T3's reviewer + T4's
  implementer announced but not sent in one batch) — caught only because
  the ledger's next update didn't line up. Trust the ledger, not memory.
- **A giant single Write stalled the API mid-plan** (~2900-line file); the
  plan had to be written in chunks via an append-marker Edit pattern.
- **The `sonnet` subagent alias works again** (6c's "broken" memory is
  stale — aliases rot and un-rot mid-week). The Playwright MCP calls hit
  transient permission-classifier timeouts; plain retry worked every time.

## Key decisions

- **Happenly** (user ruling). Only user-visible surfaces renamed; repo and
  package stay `event-hoster`.
- **Offline = the scanner, nothing else.** Attendees carry WhatsApp
  screenshots; every other route still needs network.
- **Hand-rolled SW; Serwist and `experimental.useOffline` rejected** —
  Serwist solves only the easy ~50 lines at this scope; `useOffline`'s
  pending actions die with a locked phone and the flag changes Server
  Action failure semantics app-wide, payments included.
- **Door pack stores code HASHES; raw codes only in QR + queue.** A copied
  IndexedDB leaks names/counts, not admission. Per-event key model intact.
- **First-write-wins stands; the v1 doc's "last-write-wins" was amended** —
  the losing sync replay reports `already_checked_in`, both timestamps live
  in the device's session sync report.
- **Sync is page-driven** (load + `online` event + 30s heartbeat), not
  Background Sync API — the door keeps the scanner open.
- **The two new actions return the sign-in sentence instead of
  redirecting** — a redirect fired by a heartbeat would yank the scanner to
  /login mid-door. `checkInByCode` keeps its redirect.
- **Parallel-wave SDD** (user asked for speed): disjoint-file waves,
  no-git implementers, controller commits per task; reviews per task plus
  the whole-branch final. It held — but only because file conflicts were
  mapped before dispatching.
- **Deferred minors, triaged by the final review — don't re-litigate:**
  verdict double-count in the lost-response × refreshed-pack window
  (display-only, self-heals); loose `isIsoInstant`; SW `cache.put` not
  awaited + no same-origin check; `RESCAN_SENTENCE` doubling as a sync
  stopReason wording; the `data.outcome as …` casts (all three RPC callers,
  fix in one sweep or never); manifest icon `type` fields unasserted;
  sequential-not-concurrent conflict tests (atomicity inherited from 2b's
  FOR UPDATE suite — conscious substitution).

## What a fresh agent would otherwise rediscover

- **`check_in_ticket` is 5-arg now.** Re-applying the migration over a live
  function needs `drop function check_in_ticket(uuid, text, uuid,
  timestamptz, boolean)` first — `create function`, not `or replace`.
- **EH codes: EH078+ still free** — Phase 7 added none.
- **21 migrations**; `npx supabase migration up` remains the non-destructive
  path; still no `seed.sql`; walk fixtures (`walk-ended-supper` with
  `UTRWALK0001`, `walk-future-supper`) still alive on dev.
- **SW debugging:** `public/sw.js` is a module worker importing
  `/sw-strategy.mjs` over HTTP; both are served no-cache; bump
  `CACHE_VERSION` in the strategy file to condemn a bad deploy's caches;
  test SW behavior against `npm run build && npm run start`, never dev.
- **`fake-indexeddb`** is the suite's new dev dep: fresh `new IDBFactory()`
  per test, reuse the factory to simulate the locked-phone reopen.
- **Icons:** `npm exec --yes --package=sharp -- node scripts/make-icons.mjs`
  regenerates them; sharp must never enter package.json.
- Local login numbers `919999900001/2/3`, OTP `123456`, port **3100**;
  admin is `…9001`, the walk host is `…9002`; walk event ids
  `22222222-2222-4222-8222-2222222222{01,02}`.

## Next steps

1. **The airplane walk (physical phone, ~3 minutes):** `npm run build &&
   npm run start`, phone on the LAN → scanner as `…9002` for
   `walk-future-supper` → airplane mode → scan a ticket QR → green
   "offline, will sync" → signal back → badge drains, report line shows,
   `checked_in_offline = true`. This is the phase's last unchecked box.
2. **The 001 handoff's /admin strip walk** — still pending, two minutes,
   `…9001` at `/admin`.
3. **Play Store (person):** follow `docs/runbooks/play-store-twa.md` in
   order — Console account, production domain, Bubblewrap build, keystore
   (BACK IT UP), fingerprint → the two env vars in Vercel, verify
   assetlinks serves, internal-testing upload. Replace the placeholder
   icons with real branding before the listing.
4. **The v1 build order is complete.** What remains before pilot is
   person-blocked: WABA/WhatsApp go-live (unchanged from
   [`2026-08-12-001`](2026-08-12-001-waitlist-and-notifications.md)), fees
   via the CA, Play submission above, and a launch city. Next code work, if
   any, should come from pilot feedback — or the deferred-minors sweep in
   Key decisions if a quiet session wants hygiene.
5. **Housekeeping:** `npm run db:stop` when not working; C: is nearly full;
   `seed.sql` before the next `db:reset` bites someone.
