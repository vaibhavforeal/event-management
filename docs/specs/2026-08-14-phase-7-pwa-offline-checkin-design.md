# Phase 7 — Happenly the PWA: offline check-in and the Play Store doorstep

Follows [`2026-08-09-phase-2b-qr-scanner-design.md`](2026-08-09-phase-2b-qr-scanner-design.md),
whose "Known limitations, deliberate" section this spec pays off. Row 7 of the
v1 build order: "PWA manifest, service worker, offline check-in, TWA wrapper."

## Goal

> The host arms the door while the venue still has signal. When the basement
> eats the network, the scanner keeps saying green-with-a-name, every scan
> lands somewhere durable, and it all reconciles the moment signal returns.
> Meanwhile the app is installable, named, and one set of credentials away
> from the Play Store.

## Scope

**In:** `app/manifest.ts` and icons under the product's real name
(**Happenly**); a hand-rolled service worker that keeps the scan page loadable
offline; a cached per-event roster ("door pack") in IndexedDB; offline scan
verdicts from a pure decision tree; a durable check-in queue; a batch sync
path that finally writes `checked_in_offline`; TWA artifacts (assetlinks
route, Bubblewrap config, Play Console runbook) up to but not including
submission.

**Out:** web push (WhatsApp is the notification channel); offline behaviour
anywhere but `/host/events/[id]/scan`; un-check-in; co-hosts or staff
scanning; Next's `experimental.useOffline` flag; the actual Play Store
submission (person-blocked: Play Console account, signing key, production
domain); renaming anything beyond user-visible surfaces — the repo stays
"Event Hoster".

## What already exists

Phase 2b built the scanner expecting this phase. The inventory:

| Piece | State |
|---|---|
| `lib/tickets/signing.ts` | Web Crypto HMAC, runs identically in Node and browser. `verifyQrPayload` already gives the instant local red; its doc comment defers cancelled/already-used knowledge to "the cached list" — which this phase builds |
| Scanner page | Server component derives the per-event key and hands it to the client. Local verify already precedes the server call; a dead network currently lands as a generic "rescan" refusal at the catch in `scanner.tsx` — the natural interception point |
| `tickets.checked_in_offline` | Column reserved since the core schema ("True when the scan happened offline and synced later"), never written |
| `check_in_ticket` / `check_in_next_ticket` | SECURITY DEFINER RPCs, service-role only, atomic test-and-set (`where checked_in_at is null`). "Already in" is an outcome with the original timestamp, not an error |
| PWA scaffolding | None. No manifest, no service worker, no icons beyond `favicon.ico`, no IndexedDB or localStorage usage anywhere in the app |
| Next.js | **16.3** — `app/manifest.ts` is a first-class file convention. `experimental.useOffline` exists (see rejected approaches) |
| Browser test harness | None — no Playwright config exists. Browser verification in this repo is a driven walk plus a physical phone, per 2b |

## Decisions taken in brainstorming

**The product is named Happenly.** Full and short manifest name both
"Happenly". Chosen over "Happnly" because names here travel by voice and
WhatsApp forward; the spelled-like-it-sounds variant is the one a heard
recommendation can type into a search box. The rename touches the manifest,
the layout metadata (title template becomes `%s · Happenly`), icons and the
TWA config; the repository, package name and internal docs keep "Event
Hoster".

**Offline reaches the scanner and nothing else.** The v1 promise is offline
*check-in*. Attendees already carry their QR as a WhatsApp screenshot — an
offline ticket page would duplicate that for real caching cost. Every other
route keeps requiring network.

**Hand-rolled service worker over Serwist over `useOffline`.** Serwist solves
only the caching layer — ~50 lines at this scope — and none of the domain
logic, at the price of a build-integration dependency family; it becomes the
right answer only if offline scope grows app-wide. `experimental.useOffline`
was rejected on three facts: its pending Server Actions live in memory, so a
locked phone at the door loses check-ins; the host needs an instant local
verdict, so the cached roster is needed anyway; and the flag changes
Server-Action failure semantics app-wide, including the payment flow — not a
side effect to smuggle into a scanner phase.

**TWA: prepare, don't publish.** Everything code-side lands; the submission
needs the user's Play Console account (~₹2,100 one-time), a signing key, and
the production domain. Those become a person-blocked next step alongside the
WABA, with a runbook.

**First-write-wins stays; the v1 doc's "last-write-wins" phrasing is
amended.** The DB's existing atomic test-and-set already decides conflicts;
a queued offline scan that syncs after an online check-in gets
`already_checked_in` with the standing timestamp. "Both timestamps retained"
is satisfied by the device's sync report ("scanned here 19:05 · already in at
19:10"). Rewriting `checked_in_at` history to scan-time order was rejected:
at pilot scale the conflict is the host's own second device, and an audit
trail that mutates is worse than one honest about sync order.

## The door pack

Every scanner page load **with network** pulls a fresh pack through a server
action → `buildDoorPack` in `lib/checkin/service.ts` (authorized by the
existing `mayCheckIn`, service-role read), and stores it in IndexedDB,
replacing the previous pack for that event.

Pack contents: `eventId`, `generatedAt` (server clock), and one row per
ticket of a confirmed booking — `codeHash`, `attendeeName`
(`bookings.attendee_name`, same source as the RPCs), booking `reference`,
`bookingId`, `checkedInAt`, plus per-booking `ticketsTotal`/`ticketsIn`.

**`codeHash`, not the code.** The pack stores SHA-256 of each ticket code;
raw bearer codes never sit on disk. The scan itself yields the raw code, the
client hashes it (Web Crypto, already a dependency of the verify path) and
looks up the row. A copied IndexedDB therefore leaks names and counts — which
the host can see anyway — but not the codes that admit people. The per-event
key is already on the page by 2b's design; this keeps the *server's*
authority (the unguessable code) out of storage.

The scanner header shows the pack's age and size — "Roster as of 19:02 · 43
tickets · 12 in" — with a manual refresh button. Staleness is a visible
state, not an error.

## The offline verdict

Online behaviour is unchanged: local HMAC verify → server action →
authoritative verdict. The offline path engages only when `navigator.onLine`
is false or the check-in action dies on a network error — the catch that
today says "rescan" instead consults the pack.

One pure function, `offlineVerdict(payload, pack, queue)` in
`lib/checkin/offline/verdict.ts`:

| Case | Verdict | Queued? |
|---|---|---|
| HMAC invalid | Red, existing reasons, unchanged | No |
| Valid, in pack, pack says checked in | Amber — "already in at 19:10" (pack timestamp) | No |
| Valid, in pack, already in local queue | Amber — "already scanned here at 19:05, pending sync" | No |
| Valid, in pack, fresh | **Green** — name, "2 of 3 in" (counts include queued scans on the same booking) | Yes |
| Valid HMAC, not in pack | Amber — "Valid ticket, not on the 19:02 roster — booked after it, or since cancelled. Queued; syncs when signal returns. Admit at your discretion." | Yes |

The last row is honest by construction: cancellation deletes unscanned
tickets server-side, so offline the pack cannot distinguish "booked after the
roster" from "cancelled since it" — the HMAC only proves Happenly issued this
code for this event. The server settles it at sync (a cancelled ticket comes
back `EH020`). The signature's Phase-7 job, promised in 2b, is exactly this:
full offline verification of issuance; the pack adds the cancelled/already-in
knowledge it can.

Verdict sentences live beside the existing ones in
`lib/checkin/sentences.ts` — client-safe, shared with the sync report.

## The queue and sync

**Queue entries are durable and minimal:** `{id (uuid), eventId, code (raw),
scannedAt (device clock, ISO), verdictAtScan ('fresh' | 'not_on_roster')}` in
IndexedDB. The raw code is needed to sync (the RPC's authority is the code
lookup); it was physically presented at the door and lives in the queue only
until drained. Locked phones, killed tabs and reboots do not lose scans.

**Sync is page-driven.** Triggers: scanner page load, the browser's `online`
event, and a 30-second interval while the queue is non-empty. The Background Sync API
was considered and rejected: it adds SW↔IndexedDB coordination for the sole
case of a host who never reopens the scanner, at a door where the scanner
stays open. The queue badge ("3 pending sync") stays on screen until drained.

**One batch action, per-entry outcomes.** A server action posts the queue for
one event to `syncOfflineCheckIns(caller, eventId, entries)` in
`lib/checkin/service.ts`: authorize once via `mayCheckIn`, then call the RPC
per entry (sequentially; a supper-club queue is tens, not thousands — the
action shape-checks and caps a batch at 200 entries, draining in rounds
beyond that). Each entry resolves to `checked_in`, `already_checked_in` (with
the standing timestamp), or a mapped `EH02x` refusal.

**Removal only on a received response.** Entries leave the queue when their
outcome arrives — including refusals, which are *resolved*: they move to a
session-visible sync report so the host sees what bounced and why. A response
lost mid-flight retries the whole batch; the RPC's test-and-set makes replays
land as `already_checked_in`, so retry is idempotent by construction. An
expired session surfaces "sign in to sync" and the queue holds; transport and
auth failures keep entries queued, per-entry refusals do not.

## The write path

One migration, `supabase/migrations/20260814000001_offline_checkin.sql`.
`check_in_ticket` gains two defaulted parameters:

```sql
check_in_ticket(p_event_id uuid, p_code text, p_checked_in_by uuid,
                p_scanned_at timestamptz default null,
                p_offline boolean default false)
```

Adding parameters changes the signature, so the migration drops and recreates
the function, restating the 2b posture verbatim: SECURITY DEFINER,
`set search_path = public`, EXECUTE revoked from `public`/`anon`/
`authenticated`, granted to `service_role`. With the defaults the behaviour
is byte-identical to today — the existing 2b suites passing untouched is the
regression proof. `check_in_next_ticket` is not touched.

On the fresh-check-in branch:

```sql
checked_in_at = least(now(), greatest(coalesce(p_scanned_at, now()),
                                      now() - interval '24 hours'))
checked_in_offline = p_offline
```

The clamp means a wrong device clock can neither post-date reality nor drag a
check-in more than 24 hours into the past; a null `p_scanned_at` (every
existing caller) is `now()`, exactly today's write. The conflict branch is
untouched: first write wins, the original `checked_in_at` comes back.

No new error codes. `EH020`–`EH022` already say everything the sync path
needs; EH078+ remain free.

`lib/supabase/types.ts` gains the two optional args on the RPC signature.

## PWA shell

**Manifest** — `app/manifest.ts`, Next 16's file convention: name and
short_name `Happenly`, `start_url: '/'` (the city feed; the store presence is
for attendees — hosts navigate from there), `display: 'standalone'`,
`background_color` paper `#fbfaf7`, `theme_color` accent `#0f5e52`, both from
the one palette. Icons: 192, 512, maskable 512, apple-touch 180 — a generated
placeholder wordmark (ink/verdigris on paper), produced once by a one-off
script and committed as PNGs — the generator does not become a project
dependency. Real branding is a later design task, recorded in the runbook. The root layout gains the matching
`viewport` themeColor export and its title strings become Happenly.

**Service worker** — `public/sw.js`, registered from a small client component
in the root layout (`{ type: 'module', updateViaCache: 'none' }`, behind
feature detection; browsers without module-SW support simply skip it —
everything but offline reload works without a SW). The strategy decisions
live in `public/sw-strategy.mjs`, a dependency-free ESM module the SW
imports and vitest imports the same way — the pure/glue split without a
bundler. The entire fetch policy is three rules:

1. `GET /_next/static/**` → **cache-first**. Content-hashed, immutable by
   construction; this also covers the self-hosted `next/font` files.
2. **Navigations to `/host/events/*/scan`** → **network-first, cache
   fallback**; each successful response replaces the cached copy. Online is
   always fresh HTML; offline is the page as of the last online visit — and
   because that visit runtime-cached its own hashed chunks, HTML and assets
   are a consistent pair. No build stamping needed.
3. Everything else → passthrough. No POST caching, no API caching, no
   attendee pages.

Cache names carry a manual `CACHE_VERSION`; `activate` deletes other
versions' caches. `next.config.ts` gains a `headers()` entry serving `/sw.js`
and `/sw-strategy.mjs` with `Cache-Control: no-cache` so a deployed fix is
picked up on next load rather than after a stale-SW window.

**Trust note, stated rather than hidden:** the cached scan page contains the
per-event key and renders offline without a server auth check. That is the
same trust the page already extends — it was handed to the authenticated
host while online, on the host's own device, and holds only that event's key;
2b's threat model survives intact. Writes still authorize server-side at
sync, always.

## TWA prep

Three artifacts, no submission:

1. **`app/.well-known/assetlinks.json/route.ts`** — reads `TWA_PACKAGE_NAME`
   and `TWA_CERT_SHA256` from env (both optional in `lib/env.ts`); returns
   the digital-asset-links JSON when both are set, 404 until then. Nothing
   fake is ever served.
2. **`twa/twa-manifest.json`** — the committed Bubblewrap config: package id
   `com.happenly.app`, launcher name Happenly, palette colors, host domain a
   stated placeholder (the production domain is itself a person decision).
3. **`docs/runbooks/play-store-twa.md`** — the person steps in order: Play
   Console account, production domain, `bubblewrap init/build` against the
   deployed manifest, signing key → SHA-256 fingerprint → the two env vars,
   verify `assetlinks.json` serves, internal-testing track upload.

## Application modules

| Unit | Responsibility |
|---|---|
| `lib/checkin/offline/verdict.ts` | The pure decision tree above. No I/O |
| `lib/checkin/offline/store.ts` | The only file touching IndexedDB: door packs (keyed by event) and the queue (keyed by entry id, indexed by event). Absence/failure of IndexedDB degrades to online-only with a visible banner |
| `lib/checkin/offline/sync.ts` | Drain planning: batch assembly, applying per-entry outcomes to queue and pack, building the sync report. Pure where possible, adapter calls at the edge |
| `lib/checkin/service.ts` | Gains `buildDoorPack` and `syncOfflineCheckIns`, both behind `authorizedEventHost`, same admin-client posture as the existing exports |
| `app/host/events/[id]/scan/actions.ts` | Gains `loadDoorPack` and `syncOfflineCheckins` actions, shape-checked like `checkInByCode` |
| `app/host/events/[id]/scan/scanner.tsx` + `scan-state.ts` | Arms on load, consults the verdict tree on network death, shows roster age, queue badge and sync report. The reducer gains the two pending-sync amber verdicts |
| `app/manifest.ts`, icons, `app/layout.tsx` | The shell and the rename |
| `public/sw.js` + `public/sw-strategy.mjs` | Glue + testable strategy |
| `app/.well-known/assetlinks.json/route.ts`, `twa/`, runbook | TWA prep |

## Failure modes

- **IndexedDB unavailable** (private mode, storage pressure): scanner works
  exactly as today, online-only, with a visible "offline arming unavailable"
  banner. Never a hard failure.
- **Roster staleness:** first-class state — visible timestamp, refresh
  button, the amber not-on-pack verdict.
- **Session expiry while offline:** local scanning continues; sync surfaces
  "sign in to sync" and the queue holds.
- **Response lost mid-sync:** per-entry removal on received outcomes only;
  replays resolve to `already_checked_in`. No double check-ins, no lost scans.
- **Wrong device clock:** the SQL clamp.
- **Botched SW deploy:** bump `CACHE_VERSION`; HTML is network-first whenever
  there is signal, and `/sw.js` itself is served no-cache.

## Testing

Same layers as every phase, plus two new seams:

- **Pure, exhaustive:** every row of the verdict table including the queue
  arithmetic in "2 of 3 in"; sync drain planning (what is sent, what is
  removed, on which outcomes); the SW strategy module (URL → rule). Plain
  vitest, no browser.
- **IndexedDB adapter** against `fake-indexeddb` (the suite's one new dev
  dependency) in the existing node environment: pack replace, queue
  survives reopen, drain removal, missing/broken DB → the degradation path.
- **Integration, real database:** defaults byte-identical (the untouched 2b
  suites are the proof); `p_offline` writes the column; the clamp's three
  cases (null, future, ancient); first-write-wins under a live conflict —
  concurrent online check-in vs. sync replay, in the style of the existing
  door-concurrency tests; `syncOfflineCheckIns` with mixed entries (fresh,
  already-in, since-cancelled EH020) resolving per-entry; a non-host's sync
  refused.
- **Action layer:** mocked at the same seams as the existing scan action
  tests.
- **Mutation discipline** per repo memory: full-file runs, mutants observed
  red live, never `-t`-filtered. Priority targets: the clamp, the verdict
  tree, the removal-only-on-response rule.
- **Browser, driven walk + physical phone** (no Playwright harness exists in
  this repo): visit the scan page online → DevTools offline → full reload
  still renders with roster banner and queue badge. The camera path and the
  true airplane-mode walk — scan offline, queue, restore network, watch the
  sync land with `checked_in_offline = true` — happen on a physical phone,
  per the v1 verification list and 2b's precedent.

## Known limitations, deliberate

- **Guest-list tap check-in stays online-only.** The offline door is the
  scanner. A host without camera *and* without signal has no path — the same
  Chrome-on-Android ruling 2b made, now with the stakes stated.
- **Counts elsewhere lag until sync.** The attendees page and the admin strip
  see offline check-ins only after the queue drains. Pilot-acceptable.
- **The sync report is session-local.** Conflict details ("scanned here
  19:05 · already in at 19:10") live on the device that scanned; the database
  keeps one timestamp and the `checked_in_offline` flag. An audit table was
  considered and rejected as a feature without a customer at pilot scale.
- **The placeholder icon ships.** Real branding — icon, splash, store
  listing art — is a design task for the person, listed in the runbook.

## Migration and types

- `supabase/migrations/20260814000001_offline_checkin.sql`
- `lib/supabase/types.ts` updated by hand for the two new optional RPC args
  (the repo's convention; `database.types.ts` dumps are not used).
- New env keys `TWA_PACKAGE_NAME`, `TWA_CERT_SHA256` in `.env.example`,
  optional in `lib/env.ts`.
