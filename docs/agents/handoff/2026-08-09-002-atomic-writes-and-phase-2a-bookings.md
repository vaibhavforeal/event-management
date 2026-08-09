# Handoff — Atomic event writes, the oversell grant, and Phase 2a bookings

**Date:** 2026-08-09
**Branch at end of session:** `master` @ `da054f8`, pushed to `origin`
**Suite:** 322 tests, 25 files, all green. Typecheck and lint clean.

---

## Goal

Pick up the four open items from
[`2026-08-09-001`](2026-08-09-001-phase-1-close-and-login-next-path.md), then
keep going. No target beyond that was set at the start; the session's shape was
decided a step at a time, and each step was a choice that could have gone
differently:

1. Close the handoff's cleanup list.
2. Close the atomicity gap in `createEvent`/`updateEvent` — chosen over starting
   Phase 2, on the reasoning that the gap is what Phase 2 would arm.
3. Close the `reserved_count` grant hole, surfaced while doing (2).
4. Build **Phase 2a** — free bookings and ticket issuance. Phase 2 in the v1
   build order is four subsystems; it was split, and only the first half was
   built. QR and the door scanner are 2b and were deliberately not started.

## Current state

Everything is merged, pushed and green. Nothing is blocked, on a person or a
machine.

`master` and `origin/master` are both at `da054f8`. The local Supabase stack is
**stopped**. The `phase-2a-bookings` branch has been deleted; `phase-0-foundations`
and `phase-1-events` are kept as the phase record, as before.

**What works end to end, verified in a real browser and not only by tests:** a
host publishes a free event and shares the link; someone taps it in WhatsApp,
signs in by OTP, types a name, picks seats, and books; they see the booking at
`/bookings/<reference>` and in a list at `/bookings`; the host opens the guest
list and rings them on a `tel:` link; either side can cancel and the seat comes
back.

**What does not exist yet:** paid bookings, QR codes, the door scanner, the
approval flow, cash, waitlists, WhatsApp notifications. A paid or approval-gated
or already-started event shows a disabled control that says so.

Two properties fired for the first time this session and both hold:

- **50 simultaneous bookings against 10 seats sold exactly 10.** The v1 design
  document has called this test mandatory since before there was a booking entry
  point to aim it at.
- **`EH001` refused a host cutting capacity below the seats already taken**,
  through the real edit form, in the sentence it was written to say: *"4 of those
  seats are already taken, so capacity cannot go down to 2"*. It was written on
  this same day and could not fire while `reserved_count` was always 0.

## What was accomplished

**The handoff's cleanup list.** `.claude/settings.local.json` kept with
`Bash(git branch:*)` narrowed to three read-only forms so `-D` prompts again;
`login-next-path` deleted; the Supabase stack was already down. A git remote now
exists — `https://github.com/vaibhavforeal/event-management`, **public**, chosen
knowingly after the visibility was flagged. The repo previously existed in
exactly one place.

**Atomic event writes.** `createEvent` and `updateEvent` each made two
independent PostgREST writes with no transaction. A probe against the old code
caught the seats write committing alone — `quantity: 33`, `price: 12300` — while
the events write that followed was refused and the title never moved. Both now go
through `SECURITY INVOKER` plpgsql functions over RPC, so one save is one
transaction and every Phase 0 policy still evaluates inside the body.

**The oversell hole.** `grant insert, update on ticket_types to authenticated`
was table-level, and RLS filters rows rather than columns, so a host could write
`reserved_count` on their own ticket type — zero it, and oversell their own
event. Narrowed to a column list. The README had claimed for two days that
`reserved_count` is mutated only by the Postgres functions; that claim is now
true.

**Phase 2a.** Three migrations, five new modules under `lib/bookings/`, four
screens, one navigation link, and 101 new tests. Built subagent-driven: a fresh
implementer per task, a review after each, a whole-branch review at the end.

## Files changed

Only the files a reader needs a map for. `git log` has the rest.

| File | What it now does |
|---|---|
| `supabase/migrations/20260809000001_event_write_transactions.sql` | `create_event_with_ticket_type` and `update_event_with_ticket_type`, `SECURITY INVOKER`, granted to `authenticated`. Header explains why this inverts `20260808000002`'s posture. |
| `supabase/migrations/20260809000002_ticket_types_column_grants.sql` | Replaces the table-level write grant with a column list that excludes `reserved_count`. |
| `supabase/migrations/20260810000001_bookings_attendee_name.sql` | `bookings.attendee_name`, plus the partial unique index enforcing one active booking per attendee per event. |
| `supabase/migrations/20260810000002_profiles_visible_to_hosts.sql` | `profiles_select_for_host` — the first time `profiles` has been readable by anyone but its owner. |
| `supabase/migrations/20260810000003_book_free_tickets.sql` | `book_free_tickets`, four guards (`EH010`–`EH013`), service-role only. Composes Phase 0's reserve + confirm in one transaction. |
| `lib/bookings/caller.ts` | The branded `Caller` type and `currentCaller()`, the only way to make one. |
| `lib/bookings/authorize.ts` | `mayCancel()` — pure, unit-tested. The whole of the cancel rule, since RLS does not see these writes. |
| `lib/bookings/service.ts` | Every booking **write**. The only file permitted to import `lib/supabase/admin.ts`. |
| `lib/bookings/queries.ts` | Every booking **read**, on the RLS-scoped client. Deliberately a separate module from the writes. |
| `lib/bookings/rpc-errors.ts` | Maps booking SQLSTATEs to sentences an attendee can read. |
| `lib/events/rpc-errors.ts` | The same, for the event-write functions. `EH001`/`EH002`. |
| `eslint.config.mjs` | `no-restricted-imports` with `patterns`, quarantining the service role to `lib/bookings/service.ts`. |
| `app/e/[slug]/book-panel.tsx`, `actions.ts` | The Book control and its Server Action. Name, quantity, no identity from the form. |
| `app/bookings/` | The attendee's list, one booking's confirmation page, and the cancel action. |
| `app/host/events/[id]/attendees/` | The host's guest list with dialable numbers, and the host cancel action. |
| `lib/events/datetime.ts` | Gains `hasStarted(startsAt, now)` — fail-closed on an unparseable date on either side. |
| `lib/inventory/reservation.test.ts` | Fixtures only: rewritten to use distinct buyers, because the new unique index made one-buyer concurrency tests illegal. Every assertion is byte-identical. |

## Files in flight

**Nothing.** Working tree clean, `master` pushed, no stashes, no untracked files
of consequence. The SDD scratch workspace under `.superpowers/sdd/` was deleted
after the final review, as its own instructions require.

`.claude/settings.local.json` is still untracked and still covered by a global
gitignore. It is now a deliberate keep rather than an open question.

## Failed attempts

Nine things in the plans I wrote turned out to be wrong. The subagents caught all
of them, which is the argument for the review loop rather than for my planning.
The ones worth not repeating:

**Assuming RLS does not apply inside a policy's own subquery.** An exploration
early in the session asserted this confidently and it is **false**. A bare
`select 1 from bookings` inside a policy on `profiles` *is* filtered by `bookings`'
own policies. That is precisely why `owns_event()` and `current_host_id()` are
`SECURITY DEFINER`, as `20260808000003:13-14` says in its own words. Settled by a
four-way probe — mutant/real policy × normal/`using (true)` bookings policy — and
a leak appears only when both are widened. I asked an implementer to mutation-test
a policy on the strength of the wrong claim; it measured instead and told me so.

**Two "mine" queries scoped by RLS alone.** `listMyBookings` had no `attendee_id`
filter and `listEventAttendees` filtered on `event_id` alone. RLS ORs
`bookings_select_own` with `bookings_select_for_host`, so a user who both hosts
and books saw other people's bookings in their personal list, and an ordinary
attendee got a one-row "guest list" of themselves. `lib/events/queries.ts` opens
with a comment warning about exactly this, written in a previous session. The
plan repeated the mistake the repo had already written down.

**A lint rule that could be walked around.** `no-restricted-imports` with `paths`
matches the specifier string exactly, so `import '../supabase/admin'` lints
clean — in a rule whose entire purpose is to be unbypassable. Fixed with
`patterns`. An implementer then found a third spelling I had missed, `./admin`
from inside `lib/supabase/`, and closed that too. Three probes, each watched
failing before deletion.

**A `tel:` link that would not dial.** GoTrue strips the leading `+` from phone
numbers on the way in, so `tel:919999900001` is a *local* number under RFC 3966.
An Indian handset will not connect it and from abroad it never will. The whole
point of the guest list was contacting guests, and it looked correct on screen.

**`revoke execute … from public` also strips `service_role`.** It is neither a
superuser nor a member of `authenticated`. A test expecting `EH002` got `42501`
instead. Every function migration since grants back explicitly.

**A clock read in a component body.** `const finished = … <= Date.now()` fails
`react-hooks/purity`, and would have treated `NaN` as "not started" — a Book
button on an event with an unparseable date. Now `hasStarted()`, fail-closed on
both sides.

**Telling a visitor an event had finished when it had started.** The label fired
on `starts_at`, so someone arriving twenty minutes into a three-hour supper club
was told it was over. Arriving mid-event is normal for a link that lives in a
WhatsApp group.

**Two premises stated as fact and disproven by measurement.** The feed card does
*not* print a seat count — only date, title, venue and price — and
`staleTimes.dynamic` has defaulted to 0 since Next 15, so Back already refetches.
Both were load-bearing in the argument for `revalidatePath`. The calls were kept
as insurance with the true reasoning written into the comments.

**A teardown that leaked 50 users per run.** `bookings.attendee_id` is
`ON DELETE RESTRICT` and the plan's cleanup deleted buyers before their bookings,
with the error swallowed by `.catch(() => {})`.

## Key decisions

**`SECURITY INVOKER` for the event writers, `SECURITY DEFINER` for the booking
writers.** Not an inconsistency. The event functions guard a write the caller is
already entitled to make, so the body runs as the caller and every Phase 0 policy
still applies — nothing new is authorised, the statements only move into one
transaction. The booking functions mutate `reserved_count`, which nothing
reachable from a browser may do, so they keep Phase 0's posture: definer,
`EXECUTE` revoked, service-role only.

**The service role in application code, and the alternative that was rejected.**
`auth.uid()` works inside `SECURITY DEFINER` — `current_host_id()` proves it, in
this repo — so the booking functions *could* have been granted to `authenticated`
and authorised themselves in SQL, next to the write and under the same lock, with
no service role in the app at all. That was considered and **turned down** in
favour of keeping the PostgREST surface as narrow as Phase 0 drew it. The trade
is explicit: a narrower reachable surface bought with a wider hand-written
authorisation surface. Mitigated by the branded `Caller`, the one-module rule and
the lint rule that holds it.

**Hosts see attendees' phone numbers.** Initially designed the other way — name
only, `profiles` untouched — and reversed on instruction. A host has to reach
their guests and WhatsApp is the only channel this product has. Note the
consequence: RLS filters rows and not columns, so a host now sees the *whole*
`profiles` row. Nothing sensitive lives there today; the day something does, it
needs a column-level grant the way `hosts.upi_id` has one.

**Name on the booking, not on the profile.** `profiles.full_name` is null for
every user who has ever existed — `handle_new_user()` writes `id` and `phone` and
nothing else. A booking-time name is also the right one for a door list: it does
not change retroactively when someone edits their profile a month later.

**One *active* booking per attendee per event, by partial unique index.** An
application check races with itself, and this is the phase that introduces the
concurrency. Partial on the active statuses, so cancelling frees the slot.

**Reads and writes in separate modules.** `queries.ts` on the RLS client,
`service.ts` on the service role. The split is what makes "does this bypass RLS?"
answerable by which file you are in, and it is what makes the lint rule mean
anything.

**Phase 2 split into 2a and 2b.** Four subsystems was too much for one spec. 2a
is demo-able on its own; the QR and scanner build on it.

## What a fresh agent would otherwise rediscover

**Environment**

- **Use `localhost:3100`, never `127.0.0.1:3100`.** On the IP form Next 403s its
  own dev chunks (`allowedDevOrigins`), React never hydrates, and a form degrades
  to a non-redirecting POST. It looks exactly like a broken redirect and cost
  real time twice.
- **The dev server can wedge** with a `WorkerError` / "Jest worker … retry limit"
  and start 500-ing pages that rendered fine a moment earlier. Kill it and delete
  `.next`. It mimics a page regression precisely.
- **Subagents dispatched with `model: "sonnet"` fail immediately** on this Foundry
  deployment. `haiku` and the inherited session model both work. The error only
  arrives after the agent is launched, so it costs a whole dispatch.
- Docker Desktop still only starts via PowerShell; `npm test` still needs
  `npm run db:start`; port 3100, not 3000. All as recorded last session.
- `C:` is ~98% full. `npm run db:stop` when done.

**Schema and platform facts, all measured this session**

- **GoTrue strips the leading `+`** from phone numbers, so `profiles.phone` holds
  `919999900001`. `core_schema.sql:49` documents the column as E.164 *with* the
  plus and is wrong; `lib/auth/phone-otp.test.ts:69` has pinned the real shape
  since Phase 0. Anything building a `tel:` or a WhatsApp address must normalise.
- **`reserve_tickets` checks `max_per_order` before availability**, so an
  over-large quantity yields "cannot book more than N per order" and never "only
  N seats remain". Tests for the sold-out path must exceed remaining while staying
  under the cap.
- **`anon` has no `select` grant on `bookings`**, so a signed-out read throws
  `42501` rather than returning zero rows. That is a grant failure, not a policy
  filter, and it must not be rescued — swallowing it would mask a
  misconfiguration as an empty list.
- **Every page in this app is dynamically rendered**, because
  `lib/supabase/server.ts` awaits `cookies()` on every query path. There is no
  ISR window and no data cache in front of any count.
- **Tailwind v4 defaults `border-color` to `currentColor`**, so a bare `border`
  class paints near-black. Every component here pins one.
- **`supabase gen types` emits every text and timestamptz function argument as
  non-nullable `string`**, because Postgres does not record argument nullability.
  `app/host/events/actions.ts` handles this with
  `satisfies Nullable<Args> as Args` — the `satisfies` is load-bearing and keeps
  a missing or misspelled key a compile error.

**Testing conventions**

- `tests/helpers/session.ts` still installs its mock as an import side effect, so
  modules under test need a top-level `await import(...)`.
- `lib/events/actions.test.ts` is still order-dependent.
- Teardown order matters now: `bookings.attendee_id` is `ON DELETE RESTRICT`, so
  bookings must be deleted before the users who made them.
- Any test booking twice as one person on one event is refused by
  `bookings_one_active_per_attendee`. That is correct behaviour.

**Known limitation, deliberate**

The `unique_violation` handler in `book_free_tickets` is unreachable from the
test suite single-threaded — the pre-check always wins. It was verified by
reproducing the race across two psql sessions, and there is a comment at the
handler saying so, because it otherwise reads as dead code.

## Next steps

1. **Phase 2b — QR and the door scanner.** The spec's own "Notes for 2b" section
   is written for this. `confirm_booking` already writes `tickets.code` as 128
   bits of hex; 2b derives the signature from that code plus a per-event key and
   never stores it, so the two cannot drift. `TICKET_SIGNING_SECRET` is already
   in `.env.example`. Nothing in 2a reads or writes a signature.
2. **Decide about the schema-wide one-booking rule before Phase 3.** The index is
   not scoped to free bookings, so the paid path inherits it: a buyer wanting a
   second, separate paid order will be refused. That was decided by a
   free-bookings task and deserves a deliberate answer.
3. **`not-found.tsx` for `/bookings/[reference]`.** A mistyped eight-character
   reference is the expected case, not an edge one, and `app/e/[slug]/not-found.tsx`
   sets the precedent. Currently Next's default 404 renders.
4. **Guard the slug before `revalidatePath`.** Both cancel actions interpolate a
   slug taken straight from a form field. No write, no exposure, and every route
   is dynamic — a shape check closes the argument for two lines.
5. **Dark mode.** The two new booking pages do not pin colours, so they read
   poorly under `prefers-color-scheme: dark`, as `/host` already does. App-wide
   and worth doing once rather than per page.
