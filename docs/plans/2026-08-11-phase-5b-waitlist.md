# Phase 5b — The Waitlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sold-out instant-book event stops refusing people: an attendee joins a strict-FIFO line, a freed seat is offered automatically to the head of it with a 24-hour window, and the offer pays (online) or claims (free/cash) through exactly the rails every other booking already uses.

**Architecture:** Two migrations, because Postgres cannot add an enum value and use it in the same transaction and each migration file is one transaction. The first adds `'waitlisted'` to `booking_status`. The second adds `events.has_waitlist` (mutually exclusive with `requires_approval` by CHECK), widens `bookings_one_active_per_attendee`, and writes the two new functions — `join_waitlist` (the `request_booking` shape: no inventory, 0/0/0 money) and `promote_from_waitlist` (the offer engine: under the ticket-type row lock, repriced from the current `price_paise`, `awaiting_payment` + `approved_at` + a 24-hour hold — the exact shape `approve_booking` leaves behind, so the whole 5a pay surface applies unchanged). Promotion is wired into every seat-freeing seam by recreating three existing functions to end with a `promote_from_waitlist` call: `cancel_booking`, `release_expired_holds`, and `reserve_tickets`. That is the entire trigger story — no cron, no new sweep. `lib/bookings/service.ts` grows `joinWaitlist`, `claimOfferedSeat` and `waitlistPosition`; `lib/bookings/waitlist-copy.ts` is a new pure module holding every sentence this phase says, so the copy is unit-tested rather than buried in JSX. `beginApprovedCheckout` is reused as-is — an offer satisfies every precondition it already checks (verified in Task 3, not assumed).

**Tech Stack:** Postgres 17 (local Supabase), plpgsql, Next.js 16.3 App Router, React 19.2, TypeScript, Tailwind 4 (paper-palette tokens), supabase-js 2.x, Vitest 4. **No new runtime dependencies, no new env vars, no notification code (Phase 4).**

**Spec:** [`docs/specs/2026-08-11-phase-5b-waitlist-design.md`](../specs/2026-08-11-phase-5b-waitlist-design.md)

## Global Constraints

- **Identity never comes from a form.** Every write takes a `Caller` from `lib/bookings/caller.ts`; only `currentCaller()` can produce one.
- **The ESLint admin-import fence does not grow.** `lib/supabase/admin.ts` stays importable by exactly `lib/bookings/service.ts`, `lib/checkin/service.ts`, `lib/payments/service.ts`. Every Phase 5b service-role call — including the one *read* this phase adds, `waitlistPosition` — lands in the first. Service-role reads already live there (`cancelBooking`'s owner read, `readForDecision`); this is that precedent, not a new one.
- **RLS does not protect service-role writes.** Every authorisation decision in `lib/bookings/service.ts` is the whole of the rule.
- **Money is integer paise** (`lib/money.ts`); display via `formatPaise`. **Fees and commission stay 0**: `promote_from_waitlist` writes `convenience_fee_paise = 0` and `commission_paise = 0` outright — pilot-wide, and cash zeroes commission by construction anyway.
- **A waitlist entry takes no inventory.** `reserved_count` moves only at promotion, reservation, or approval. A test asserting a `waitlisted` row moved it is wrong, not the code.
- **The two queue toggles are mutually exclusive**, enforced by `events_one_queue` CHECK *and* by the event-writer functions coercing `has_waitlist` to false when `requires_approval` is true. That is what makes "an `awaiting_payment` + `approved_at` row on a `has_waitlist` event is always a seat offer" true by construction rather than by convention.
- **EH06x is this phase's SQLSTATE block** (EH060–EH065, allocation in Task 1). Refusals `reserve_tickets` already words for a human pass through unmapped.
- **`alter type … add value` needs its own migration file.** Postgres cannot add an enum value and use it in the same transaction, and `supabase migration up` runs each file in one. Two files, in order, always.
- **`params` and `searchParams` are Promises** in Next.js 16 — use the generated `PageProps<'/route'>` helpers. `cookies()` is async.
- **Run `npm run db:types` after each migration.** `lib/supabase/types.ts` is committed, never hand-edited.
- **Apply migrations with `npx supabase migration up` — NOT `supabase db reset`.** The dev DB holds live evidence rows the user is keeping: walkthrough events `walk-cash-night` and `walk-approval-supper`, a ₹500 confirmed booking `VYRB4SHQ` (`pay_TOI2Sov6QXtMDf`), and a settled refund. Reset wipes them.
- **`npm test` needs `npm run db:start`,** which needs Docker Desktop, which starts only via PowerShell: `powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`. A `createTestUser failed: fetch failed` error means the stack is down, not an app bug.
- **Dev server: `localhost:3100`, never `127.0.0.1:3100`** (the IP form 403s dev chunks and React never hydrates).
- **Subagents dispatched with `model: "sonnet"` fail on this Foundry deployment.** Use the inherited session model or `haiku`.
- **The session mock installs as an import side effect** (`tests/helpers/session.ts`); a module under test that needs mocks must be imported with a top-level `await import` after the `vi.mock` calls.
- **`lib/events/actions.test.ts` is order-dependent; do not append to it.** New tests go in new files. Same for `lib/bookings/queries.test.ts` — the 5a reads went into `lib/bookings/approval-queries.test.ts` for exactly this reason.
- **Baseline suite: 572 tests / 54 files, all green** (at `095f88a`; re-record the exact count in Task 1 — commits since 5a's merge are docs-only). Never finish a task with a red suite.
- **Colours come from the `globals.css` tokens** (`paper/ink/muted/line/accent/raised`); semantic green/amber/red stay Tailwind hues. No hex literals in components.
- **`C:` is ~99% full.** `npm run db:stop` when the session ends.
- **Work on branch `phase-5b-waitlist`** (created in Task 1, merged `--no-ff` after the final review).

## Three places this plan refines the spec

All three are deliberate and each is argued again where it lands. Flagged here so a reviewer meets them before the code rather than after.

1. **`mayCancel` needs no `waitlisted` arm.** The spec says "`mayCancel` grows the `waitlisted` arm", but `lib/bookings/authorize.ts:19-23` is ownership-only — it never consulted status. What actually has to learn `waitlisted` is the two *call sites* that decide whether to offer the control (`app/bookings/page.tsx:52`, and the new host section), plus `cancel_booking`, which already does the right thing: its inventory return is gated on `status in ('awaiting_payment','confirmed')`, so a `waitlisted` row returns nothing because nothing was taken. No change to `authorize.ts` in this phase.

2. **EH064 fires on `available >= p_quantity`, not `available >= 1`.** The spec words the guard as "seats open and the line empty — book instead". Taken literally, someone wanting 3 seats on an event with 1 free seat and an empty line would be told to "book instead" — advice that cannot be followed. The guard is written against the quantity actually asked for, which is the same rule everywhere it matters and never gives impossible advice.

3. **There are two more promotion seams than the spec names.** The spec calls `cancel_booking` and `release_expired_holds` "the whole trigger story", and for *freed* seats they are. Seats can also appear without being freed — a host raising capacity on an event that already has a line — and neither of those two runs then.

   Task 1 adds a `perform promote_from_waitlist` beside the `release_expired_holds` call `reserve_tickets` already makes. **This does not close the capacity-raise hole, and the plan originally claimed it did.** Task 2 proved otherwise: PostgREST runs one transaction per RPC, so when the promotion consumes the new seat and `reserve_tickets` then raises "only 0 seats remain", the raise rolls back the promotion that caused it. The call is still worth keeping — it delivers the guarantee the spec actually asks for ("walk-ups don't cut": a walk-up can never *take* a seat the line is owed), and it serves the line productively whenever the reservation itself succeeds — but it is a safety seam, not a liveness one.

   The liveness fix is Task 6, Step 7: `promoteAfterCapacityChange` in `lib/bookings/service.ts`, called by `updateEvent` after the save commits. Two transactions, no grant change, no trigger. The rejected alternatives are argued there.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260811000005_waitlist_enum.sql` | **New.** `alter type booking_status add value 'waitlisted'`, and nothing else. |
| `supabase/migrations/20260811000006_waitlist.sql` | **New.** `events.has_waitlist` + `events_one_queue` CHECK; `bookings_one_active_per_attendee` recreated; `join_waitlist` (EH060–EH065); `promote_from_waitlist`; `waitlist_length`; `waitlist_position`; `cancel_booking`, `release_expired_holds` and `reserve_tickets` recreated to promote; the two event writers recreated with `p_has_waitlist`; revoke/grant pairs. |
| `lib/supabase/types.ts` | **Regenerated.** |
| `tests/helpers/db.ts` | **Modified.** `SeedOptions.hasWaitlist`. |
| `lib/bookings/waitlist.test.ts` | **New.** Join mechanics and the EH06x guards, in SQL. |
| `lib/bookings/waitlist-promotion.test.ts` | **New.** The offer engine: FIFO, blocking heads, chaining, lapse, walk-ups, started no-op, repricing. |
| `lib/bookings/rpc-errors.ts` | **Modified.** EH060–EH065 → sentences. |
| `lib/bookings/waitlist-copy.ts` | **New.** Every sentence this phase says, pure and tested. Also takes custody of 5a's approved-pay sentence so the two offer copies live together. |
| `lib/bookings/service.ts` | **Modified.** `joinWaitlist`, `claimOfferedSeat`, `waitlistPosition` (Task 4); `promoteAfterCapacityChange` (Task 6). |
| `lib/bookings/queries.ts` | **Modified.** `BOOKING_COLUMNS` gains `events.has_waitlist`; `listEventWaitlist`; `waitlistLength`. |
| `lib/events/queries.ts` | **Modified.** `has_waitlist` on `PublicEvent` and `OwnedEvent`. |
| `lib/events/validation.ts` | **Modified.** `hasWaitlist` in the schema and `EVENT_FORM_FIELDS`. |
| `app/host/events/actions.ts` | **Modified.** `p_has_waitlist` on both RPC calls. |
| `app/host/events/event-form.tsx` | **Modified.** A `QueueOptions` sub-component owning the approval and waitlist checkboxes, so the waitlist row can hide under `requires_approval` without breaking the uncontrolled-checkbox contract. |
| `app/host/events/[id]/edit/page.tsx` | **Modified.** `hasWaitlist` into `values`. |
| `app/e/[slug]/page.tsx` | **Modified.** The line-non-empty gate; the join panel. |
| `app/e/[slug]/join-waitlist-panel.tsx` | **New.** Client: name, seats, cash choice, "Join the waitlist". |
| `app/e/[slug]/actions.ts` | **Modified.** `joinTheWaitlist`. |
| `app/bookings/[reference]/page.tsx` | **Modified.** The `waitlisted` state, the offer copy branch, the claim panel, the lapsed-offer sentence. |
| `app/bookings/[reference]/claim-seat-panel.tsx` | **New.** Client: "Claim your seat". |
| `app/bookings/[reference]/approved-pay-panel.tsx` | **Modified.** Takes its sentence as a prop instead of hard-coding it. |
| `app/bookings/[reference]/actions.ts` | **Modified.** `claimSeat`. |
| `app/bookings/page.tsx` | **Modified.** "#N in line" and withdraw on `waitlisted` rows. |
| `app/host/events/[id]/attendees/page.tsx` | **Modified.** The Waitlist section; offer copy on the payment-pending strip. |

---

### Task 1: The waitlist migrations

**Files:**
- Create: `supabase/migrations/20260811000005_waitlist_enum.sql`
- Create: `supabase/migrations/20260811000006_waitlist.sql`
- Modify: `tests/helpers/db.ts`
- Create: `lib/bookings/waitlist.test.ts`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Consumes: `reserve_tickets`, `confirm_booking`, `cancel_booking`, `release_expired_holds`, `generate_booking_reference` (`20260808000002_reservation_functions.sql` — **read it first**); `create_event_with_ticket_type` / `update_event_with_ticket_type` in their current form (`20260811000002_paid_bookings.sql:36-194` — the version carrying `p_refund_cutoff_hours`, **not** the 20260809000001 original); `bookings_one_active_per_attendee` (`20260810000001_bookings_attendee_name.sql:34-36`); `tests/helpers/db.ts`.
- Produces (later tasks call these over `.rpc()`):
  - `join_waitlist(p_ticket_type_id uuid, p_attendee_id uuid, p_quantity integer, p_attendee_name text, p_payment_mode payment_mode default 'online') returns bookings` — `waitlisted`, **no inventory**, money 0/0/0.
  - `promote_from_waitlist(p_ticket_type_id uuid, p_hold_hours integer default 24) returns integer` — how many entries were promoted. Safe everywhere: no waitlist, toggle off, nothing free, event started, ticket type gone — all return 0.
  - `waitlist_length(p_ticket_type_id uuid) returns integer` — granted to `anon` as well, deliberately (see the migration's comment).
  - `waitlist_position(p_booking_id uuid) returns integer` — 1-based; 0 when the booking is not `waitlisted`. Service role only.
  - `events.has_waitlist boolean not null default false`, and `events_one_queue` CHECK.
  - The two event writers gain a trailing `p_has_waitlist boolean default false`.
  - SQLSTATEs: `EH060` no waitlist here (toggle off, or an approval event), `EH061` started, `EH062` cash where not allowed, `EH063` over `max_per_order`, `EH064` seats are open and the line is empty — book instead, `EH065` already has an active booking or entry. Unpublished passes through as the existing `check_violation` sentence, as in 5a.

- [ ] **Step 1: Branch, stack up, record the baseline**

```bash
git checkout -b phase-5b-waitlist
npm run db:start   # Docker via PowerShell first if it is down
npm test           # record the exact test/file count here for Task 9
```

- [ ] **Step 2: Write the enum migration**

`supabase/migrations/20260811000005_waitlist_enum.sql` — this file does one thing, and that is the whole point of it existing:

```sql
-- Phase 5b: the waitlist status, alone in its own migration.
--
-- Postgres will not let a transaction add an enum value and then use it, and
-- `supabase migration up` runs each file in exactly one transaction. So the
-- value lands here and everything that reads or writes it lands in
-- 20260811000006. Merging the two files fails at apply time with
-- "unsafe use of new value 'waitlisted' of enum type booking_status", which is
-- a confusing error to meet for the first time on someone else's machine.
--
-- Positioned after 'pending_approval' because the two are siblings: both are a
-- booking that exists, holds no seat, and is waiting on somebody else's move.
-- Enum order is cosmetic here -- nothing in this repo sorts by booking_status
-- -- but psql \dT and every future reader see the lifecycle in order.

alter type booking_status add value if not exists 'waitlisted' after 'pending_approval';
```

- [ ] **Step 3: Write the main migration — the schema half**

`supabase/migrations/20260811000006_waitlist.sql`. Write the whole file in this step; it is presented in three parts for reading. Part one — the column, the constraint, and the widened index:

```sql
-- Phase 5b: demand past capacity, kept.
--
-- A sold-out instant-book event stops refusing people. An attendee joins a
-- line, a freed seat is offered to the head of it automatically with a 24-hour
-- window, and the offer rides the rails 5a already built: promotion leaves a
-- booking shaped exactly like a just-granted approval -- awaiting_payment,
-- approved_at stamped, hold_expires_at 24 hours out -- so beginApprovedCheckout,
-- the webhook, reconciliation and release_expired_holds all apply unchanged.
--
-- The trigger story is three existing functions, recreated at the bottom of
-- this file to end with a promote_from_waitlist call. Every seat this product
-- frees flows through cancel_booking or release_expired_holds, and every seat
-- it sells flows through reserve_tickets, so those three calls are the whole
-- of it. No cron, no queue worker, no new sweep.

-- ---------------------------------------------------------------------------
-- events.has_waitlist -- the opt-in, and its exclusivity
-- ---------------------------------------------------------------------------
-- Instant-book events only. An approval event's request queue already captures
-- unlimited demand -- requests stay open at capacity, which is 5a's whole
-- curation model -- so a second queue beside it would put two lists on one
-- attendees page answering the same question.
--
-- The CHECK is not belt-and-braces, it is what makes a load-bearing inference
-- true: on a has_waitlist event, an awaiting_payment row carrying approved_at
-- is ALWAYS a seat offer, because no approval could have produced one. Every
-- copy branch in the application reads the event flags and trusts exactly that.
-- The event writers below also coerce rather than raise, so a host ticking
-- approval on an event that had a waitlist gets their intent honoured instead
-- of a constraint name; this is the backstop under a crafted RPC call.

alter table events add column has_waitlist boolean not null default false;

alter table events add constraint events_one_queue
  check (not (requires_approval and has_waitlist));

-- ---------------------------------------------------------------------------
-- One active booking per attendee per event -- now including the line
-- ---------------------------------------------------------------------------
-- Being in the line is being on the event: it is a bookings row with a
-- reference, it shows on /bookings, and it can be withdrawn. So it counts
-- against the same rule, or a person joins the waitlist five times from one
-- phone and takes the whole room the moment seats free.
--
-- Recreated rather than altered -- a partial index's predicate cannot be
-- changed in place. 'cancelled' and 'expired' stay outside it, which is what
-- lets a withdrawn entry, a declined request or a lapsed offer be followed by
-- a fresh one: rejoining at the back of the line is the documented answer to a
-- lapsed offer, and it needs this index to allow it.

drop index bookings_one_active_per_attendee;

create unique index bookings_one_active_per_attendee
  on bookings (event_id, attendee_id)
  where status in ('pending_approval', 'waitlisted', 'awaiting_payment', 'confirmed');
```

Part two — the two read helpers, and `join_waitlist`:

```sql
-- ---------------------------------------------------------------------------
-- waitlist_length -- how many are in line, for a stranger
-- ---------------------------------------------------------------------------
-- The one function in this repo granted to anon, and the exception is
-- deliberate rather than convenient. The public event page has to know the
-- line's length for two reasons: it prints it ("3 people waiting"), and it
-- decides on it -- while the line is non-empty the page stays in join-waitlist
-- mode even if a seat is free, so a walk-up cannot cut. That page is served to
-- signed-out visitors, and `bookings` is granted to `authenticated` alone
-- (20260808000003:212), so an embed or a count from the page answers 42501
-- rather than a number.
--
-- What crosses the boundary is one integer with no identity in it, on a page
-- that then prints that integer to the same stranger. Nothing else here is
-- reachable this way: it takes a ticket type id, which is already public on
-- that page, and returns a count.

create function waitlist_length(p_ticket_type_id uuid)
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select count(*)::integer
    from bookings
   where ticket_type_id = p_ticket_type_id
     and status = 'waitlisted';
$$;

-- ---------------------------------------------------------------------------
-- waitlist_position -- "you're #3 in line"
-- ---------------------------------------------------------------------------
-- 1-based, and 0 for a booking that is not waitlisted -- which is how the
-- caller learns "this row has no position" without a second query. The tuple
-- comparison is the same (created_at, id) ordering promote_from_waitlist
-- promotes by, written once in each place and asserted against each other in
-- the promotion suite: a position that disagrees with the promotion order is
-- worse than no position at all.
--
-- Service role only, unlike waitlist_length. This one takes a booking id and
-- says something about one identifiable person's standing, so it goes through
-- lib/bookings/service.ts, which checks the caller owns the booking or hosts
-- the event before asking.

create function waitlist_position(p_booking_id uuid)
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select count(*)::integer
    from bookings peer
    join bookings self on self.id = p_booking_id
   where self.status = 'waitlisted'
     and peer.ticket_type_id = self.ticket_type_id
     and peer.status = 'waitlisted'
     and (peer.created_at, peer.id) <= (self.created_at, self.id);
$$;

-- ---------------------------------------------------------------------------
-- join_waitlist -- request_booking's shape, for events that vet nobody
-- ---------------------------------------------------------------------------
-- Consumes no inventory and stores 0/0/0: the entry is a claim on a seat that
-- does not exist yet, and it is priced at offer time from the price the host
-- charges then. No note field -- the host is not vetting anyone, so there is
-- nothing to pitch.
--
--   EH060  this event keeps no waitlist (toggle off, or it uses approvals)
--   EH061  the event has already started
--   EH062  cash was chosen but the event does not allow it
--   EH063  more seats than max_per_order allows
--   EH064  seats are open and the line is empty -- book instead
--   EH065  this attendee already has an active booking or entry on this event
--
-- Unpublished passes through as the existing check_violation sentence, as in
-- 5a. Deliberately takes no row lock on the ticket type: nothing here moves
-- inventory, and the worst a lost race under EH064 can produce is one
-- redundant entry that the very next promote call serves.

create function join_waitlist(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text,
  p_payment_mode   payment_mode default 'online'
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  tt          ticket_types%rowtype;
  ev          events%rowtype;
  booking     bookings%rowtype;
  available   integer;
  -- v_ prefix is not decoration: an unprefixed `reference` collides with
  -- bookings.reference and Postgres raises 42702 (ambiguous column reference).
  v_reference text;
  attempts    integer := 0;
begin
  if p_quantity < 1 then
    raise exception 'quantity must be at least 1'
      using errcode = 'check_violation';
  end if;

  -- Settle first, exactly as reserve_tickets does, so "available" below is
  -- truthful rather than inflated by abandoned checkouts. This call also
  -- promotes whatever it frees -- see release_expired_holds at the bottom of
  -- this file -- which is why the read of tt comes after it and not before.
  perform release_expired_holds(p_ticket_type_id);

  select * into tt from ticket_types where id = p_ticket_type_id;
  if not found then
    raise exception 'ticket type % not found', p_ticket_type_id
      using errcode = 'no_data_found';
  end if;

  select * into ev from events where id = tt.event_id;

  if ev.status <> 'published' then
    raise exception 'event is not open for booking (status: %)', ev.status
      using errcode = 'check_violation';
  end if;

  -- One code for both, because they are one fact to the attendee: there is no
  -- line to join here. events_one_queue makes the second half unreachable
  -- while has_waitlist is true, and it is checked anyway so that the day the
  -- constraint is relaxed this function refuses rather than misbehaves.
  if not ev.has_waitlist or ev.requires_approval then
    raise exception 'this event does not keep a waitlist'
      using errcode = 'EH060';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH061';
  end if;

  if p_payment_mode = 'cash' and not ev.allows_cash then
    raise exception 'this event does not accept cash payment'
      using errcode = 'EH062';
  end if;

  -- reserve_tickets enforces this for every other booking kind; a waitlist
  -- entry never reaches it, so the cap holds here or nowhere. Same reasoning
  -- as request_booking's EH053.
  if p_quantity > tt.max_per_order then
    raise exception 'cannot join for more than % per order', tt.max_per_order
      using errcode = 'EH063';
  end if;

  -- Refuse only when the seats they asked for are actually there AND nobody is
  -- ahead of them -- i.e. when "book instead" is advice they can follow. A
  -- three-seat joiner looking at one free seat is told nothing of the kind;
  -- they belong in the line.
  available := tt.quantity - tt.reserved_count;
  if available >= p_quantity and not exists (
    select 1 from bookings b
     where b.ticket_type_id = p_ticket_type_id
       and b.status = 'waitlisted'
  ) then
    raise exception 'seats are open on this event; book instead of joining the waitlist'
      using errcode = 'EH064';
  end if;

  -- The friendly half of the one-booking rule; the partial unique index is the
  -- half that holds under concurrency. Same shape as request_booking's EH054.
  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'waitlisted', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH065';
  end if;

  loop
    attempts := attempts + 1;
    v_reference := generate_booking_reference();
    exit when not exists (select 1 from bookings b where b.reference = v_reference);
    if attempts > 10 then
      raise exception 'could not allocate a unique booking reference';
    end if;
  end loop;

  insert into bookings (
    reference, event_id, ticket_type_id, attendee_id, quantity,
    status, payment_mode,
    subtotal_paise, convenience_fee_paise, total_paise, commission_paise,
    attendee_name
  )
  values (
    v_reference, ev.id, tt.id, p_attendee_id, p_quantity,
    'waitlisted', p_payment_mode,
    -- Priced at offer time, not join time. The host's price today is the one
    -- the offer will quote, which is 5a's repricing rule, one story product-wide.
    0, 0, 0, 0,
    nullif(btrim(p_attendee_name), '')
  )
  returning * into booking;

  return booking;

exception
  -- The pre-check loses the race sometimes; the index never does.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH065';
    end if;
    raise;
end;
$$;
```

Part three — the offer engine, and the three seams that call it:

```sql
-- ---------------------------------------------------------------------------
-- promote_from_waitlist -- the offer engine
-- ---------------------------------------------------------------------------
-- Under the ticket-type row lock, walk the line from the front and offer seats
-- to whoever fits, until the head does not fit or the line runs out. Returns
-- how many were promoted, which is what the tests assert against.
--
-- What a promoted row becomes is the point of the whole design: awaiting_payment,
-- approved_at stamped, hold_expires_at 24 hours out, repriced from the CURRENT
-- price_paise. That is character for character the shape approve_booking leaves
-- an online approval in, so beginApprovedCheckout accepts it unchanged, the
-- webhook and reconcile paths confirm it unchanged, release_expired_holds
-- expires it unchanged, and bookings_expiring_idx already indexes it. This
-- function adds an engine, not a lifecycle.
--
-- It does NOT confirm free or cash offers. A ghost in the line would otherwise
-- be handed a seat forever without ever acting; the offer has to be claimed,
-- and an unclaimed one lapses back to the next person like any other hold.
--
-- Safe to call anywhere, which is what lets the three seams below call it
-- unconditionally: no such ticket type, no waitlist, toggle off, event started,
-- nothing free, empty line -- every one of them returns 0 having written
-- nothing.
--
-- Strict FIFO. A three-seat head waits while one seat sits free, and nobody
-- passes them. The seat idles; that is the accepted cost of a queue nobody can
-- cut, and it is what makes the queue worth joining. The one pathology is an
-- entry larger than the ticket type's whole capacity -- after a capacity cut,
-- say -- which blocks the line until the host removes it. Documented in the
-- spec's limitations; deliberately not special-cased, because "skip the ones
-- that don't fit" is exactly the starvation rule FIFO was chosen over.
--
-- search_path is plain `public`: nothing here calls confirm_booking, so
-- pgcrypto is not needed.

create function promote_from_waitlist(
  p_ticket_type_id uuid,
  p_hold_hours     integer default 24
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  tt        ticket_types%rowtype;
  ev        events%rowtype;
  head      bookings%rowtype;
  head_id   uuid;
  available integer;
  subtotal  bigint;
  promoted  integer := 0;
begin
  -- Serialises every promoter for this ticket type against each other and
  -- against reserve_tickets, which is what makes "the waitlister gets the seat,
  -- not the walk-up" a fact rather than a hope.
  select * into tt from ticket_types where id = p_ticket_type_id for update;
  if not found then
    return 0;
  end if;

  select * into ev from events where id = tt.event_id;

  -- Nobody is offered a seat to an event that is already happening. The
  -- entries left in the line stay where they are: withdrawable, harmless, and
  -- swept by nothing.
  if not ev.has_waitlist or ev.starts_at <= now() then
    return 0;
  end if;

  loop
    available := tt.quantity - tt.reserved_count;
    exit when available <= 0;

    -- Read the head first without a lock, then lock that exact row. The two
    -- steps exist to avoid a deadlock that a single locking select would walk
    -- into: withdrawing an entry locks the booking row and then wants this
    -- ticket type (cancel_booking ends by calling this function), while we
    -- hold the ticket type and want the booking row. `skip locked` on a
    -- named id turns that cycle into an exit -- and exiting is correct, not a
    -- concession: the transaction holding that row is a withdrawal, and it
    -- calls this function itself on its way out, so the seat is offered a
    -- moment later by them instead of now by us. Selecting the NEXT unlocked
    -- row instead would jump the queue, which is the one thing this engine
    -- must never do.
    select b.id into head_id
      from bookings b
     where b.ticket_type_id = p_ticket_type_id
       and b.status = 'waitlisted'
     order by b.created_at, b.id
     limit 1;
    exit when head_id is null;

    select * into head from bookings where id = head_id for update skip locked;
    exit when not found;

    -- The head does not fit: the line stops here. Nobody behind them is
    -- considered, however small their entry.
    exit when head.quantity > available;

    subtotal := tt.price_paise * head.quantity;

    update ticket_types
       set reserved_count = reserved_count + head.quantity
     where id = tt.id
    returning * into tt;

    update bookings
       set status = 'awaiting_payment',
           approved_at = now(),
           subtotal_paise = subtotal,
           -- Both zero outright rather than parameterised. Fees and commission
           -- are 0 pilot-wide, and cash zeroes commission by construction, so
           -- there is no number a caller could pass that this phase would
           -- honour. approve_booking's fee parameters are the wiring point for
           -- lib/pricing when that day comes; this function is not.
           convenience_fee_paise = 0,
           total_paise = subtotal,
           commission_paise = 0,
           hold_expires_at = now() + make_interval(hours => p_hold_hours)
     where id = head.id;

    promoted := promoted + 1;
  end loop;

  return promoted;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_booking -- recreated, now offering the seat on its way out
-- ---------------------------------------------------------------------------
-- Same signature, so `create or replace` keeps the existing grants. The body is
-- verbatim from 20260808000002 apart from the promote call and the widened
-- comment; every reason written there still holds.
--
-- The call is unconditional, including for a cancelled row that held no
-- inventory, and that is not laziness: withdrawing a big waitlist entry frees
-- no seat but UNBLOCKS THE LINE behind it, so a smaller entry that has been
-- waiting behind a three-seat head can finally be served. A promote call gated
-- on "did this return inventory" would miss exactly that case.

create or replace function cancel_booking(
  p_booking_id uuid,
  p_reason     text default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  booking bookings%rowtype;
begin
  select * into booking from bookings where id = p_booking_id for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if booking.status in ('cancelled', 'expired', 'refunded') then
    return booking;  -- idempotent
  end if;

  -- pending_approval and waitlisted never consumed inventory, so there is
  -- nothing to give back for either.
  if booking.status in ('awaiting_payment', 'confirmed') then
    update ticket_types
       set reserved_count = greatest(0, reserved_count - booking.quantity)
     where id = booking.ticket_type_id;
  end if;

  update bookings
     set status = 'cancelled',
         cancelled_at = now(),
         cancellation_reason = p_reason,
         hold_expires_at = null
   where id = p_booking_id
  returning * into booking;

  delete from tickets where booking_id = p_booking_id and checked_in_at is null;

  -- Half the trigger story (release_expired_holds is the other half). A seat
  -- freed by an attendee cancelling, a host removing a guest, or a host
  -- declining goes to the head of the line before anyone else can see it.
  perform promote_from_waitlist(booking.ticket_type_id);

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- release_expired_holds -- recreated, offering what it reclaims
-- ---------------------------------------------------------------------------
-- Same signature. What is new is the array of touched ticket types and the
-- promote pass after the loop.
--
-- Promoting inside the FOR loop would be promoting while iterating a cursor
-- over the very rows being changed, so it happens after, once per distinct
-- ticket type. Distinct matters: the argument-less sweep can release twenty
-- lapsed holds across three ticket types, and each promote call already walks
-- its whole line.
--
-- This is also what makes a lapsed OFFER chain to the next person with no extra
-- machinery: an unclaimed offer is an awaiting_payment row with an expiry, so
-- this function expires it, returns its seat, and offers that seat onward in
-- the same call.

create or replace function release_expired_holds(p_ticket_type_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  released integer := 0;
  rec      record;
  touched  uuid[] := '{}';
begin
  for rec in
    select b.id, b.ticket_type_id, b.quantity
    from bookings b
    where b.status = 'awaiting_payment'
      and b.hold_expires_at < now()
      and (p_ticket_type_id is null or b.ticket_type_id = p_ticket_type_id)
    order by b.ticket_type_id
    for update of b skip locked
  loop
    update bookings
       set status = 'expired',
           cancelled_at = now(),
           cancellation_reason = 'payment hold expired'
     where id = rec.id;

    update ticket_types
       set reserved_count = greatest(0, reserved_count - rec.quantity)
     where id = rec.ticket_type_id;

    touched := array_append(touched, rec.ticket_type_id);
    released := released + 1;
  end loop;

  for rec in select distinct t as ticket_type_id from unnest(touched) t loop
    perform promote_from_waitlist(rec.ticket_type_id);
  end loop;

  return released;
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_tickets -- recreated, so a walk-up can never cut the line
-- ---------------------------------------------------------------------------
-- Same signature, and the body is verbatim from 20260808000002 apart from ONE
-- added line: a promote call beside the existing release_expired_holds call,
-- before the row lock is taken and long before any seat is handed out.
--
-- release_expired_holds alone would not be enough. It promotes only what it
-- actually reclaimed, so seats that appear by some other route -- a host
-- raising capacity on an event that already has a line -- would sit there for
-- the next walk-up to take, past everyone waiting. The unconditional call
-- closes that, and costs a non-waitlist event one extra select on a row it is
-- about to lock anyway plus an early return.
--
-- The consequence is intended and is what the concurrency test asserts: on a
-- waitlist event with a line, a walk-up's own reservation attempt hands the
-- free seats to the line first and is then refused with "only 0 seats remain".

create or replace function reserve_tickets(
  p_ticket_type_id        uuid,
  p_attendee_id           uuid,
  p_quantity              integer,
  p_convenience_fee_paise bigint default 0,
  p_commission_paise      bigint default 0,
  p_payment_mode          payment_mode default 'online',
  p_hold_minutes          integer default 10,
  p_attendee_note         text default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  tt        ticket_types%rowtype;
  ev        events%rowtype;
  available integer;
  subtotal  bigint;
  booking   bookings%rowtype;
  v_reference text;
  attempts    integer := 0;
begin
  if p_quantity < 1 then
    raise exception 'quantity must be at least 1'
      using errcode = 'check_violation';
  end if;

  -- Reclaim anything lapsed before judging availability, otherwise abandoned
  -- checkouts make an event look sold out.
  perform release_expired_holds(p_ticket_type_id);
  -- And offer what is free to the line before selling any of it. A no-op on
  -- every event that keeps no waitlist.
  perform promote_from_waitlist(p_ticket_type_id);

  select * into tt
    from ticket_types
   where id = p_ticket_type_id
   for update;

  if not found then
    raise exception 'ticket type % not found', p_ticket_type_id
      using errcode = 'no_data_found';
  end if;

  select * into ev from events where id = tt.event_id;

  if ev.status <> 'published' then
    raise exception 'event is not open for booking (status: %)', ev.status
      using errcode = 'check_violation';
  end if;

  if p_payment_mode = 'cash' and not ev.allows_cash then
    raise exception 'this event does not accept cash payment'
      using errcode = 'check_violation';
  end if;

  if tt.sales_start is not null and now() < tt.sales_start then
    raise exception 'sales have not opened yet'
      using errcode = 'check_violation';
  end if;

  if tt.sales_end is not null and now() > tt.sales_end then
    raise exception 'sales have closed'
      using errcode = 'check_violation';
  end if;

  if p_quantity > tt.max_per_order then
    raise exception 'cannot book more than % per order', tt.max_per_order
      using errcode = 'check_violation';
  end if;

  available := tt.quantity - tt.reserved_count;
  if available < p_quantity then
    raise exception 'only % seats remain', available
      using errcode = 'check_violation';
  end if;

  subtotal := tt.price_paise * p_quantity;

  update ticket_types
     set reserved_count = reserved_count + p_quantity
   where id = tt.id;

  loop
    attempts := attempts + 1;
    v_reference := generate_booking_reference();
    exit when not exists (select 1 from bookings b where b.reference = v_reference);
    if attempts > 10 then
      raise exception 'could not allocate a unique booking reference';
    end if;
  end loop;

  insert into bookings (
    reference, event_id, ticket_type_id, attendee_id, quantity,
    status, payment_mode,
    subtotal_paise, convenience_fee_paise, total_paise, commission_paise,
    hold_expires_at, attendee_note
  )
  values (
    v_reference, ev.id, tt.id, p_attendee_id, p_quantity,
    'awaiting_payment', p_payment_mode,
    subtotal, p_convenience_fee_paise, subtotal + p_convenience_fee_paise,
    case when p_payment_mode = 'cash' then 0 else p_commission_paise end,
    now() + make_interval(mins => p_hold_minutes), p_attendee_note
  )
  returning * into booking;

  return booking;
end;
$$;
```

Part four — the event writers learn the toggle, and the lock-down:

```sql
-- ---------------------------------------------------------------------------
-- The event writers, re-created with the waitlist toggle
-- ---------------------------------------------------------------------------
-- Both gain a trailing `p_has_waitlist boolean default false`. The default
-- keeps the generated Args type optional, so app/host/events/actions.ts still
-- compiles until Task 5 passes it -- the 20260811000002 precedent, which added
-- p_refund_cutoff_hours the same way.
--
-- `create or replace` cannot change a signature: it would create an overload
-- beside the old function and PostgREST would refuse the ambiguous name. Drop
-- first, naming the CURRENT signatures -- the ones from 20260811000002 that
-- carry p_refund_cutoff_hours, not the 20260809000001 originals.
--
-- The bodies are otherwise verbatim from 20260811000002. Posture (SECURITY
-- INVOKER, so events_insert_own / events_update_own still evaluate), ownership
-- scoping, the oversell check and the reasoning in those comments all still
-- hold and are not restated here.
--
-- `p_has_waitlist and not p_requires_approval` rather than the raw parameter:
-- the two queues are exclusive, and a host who ticks approval on an event that
-- had a waitlist should get their intent honoured rather than events_one_queue's
-- constraint name. The CHECK stays as the backstop for a crafted RPC call.

drop function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
);
drop function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
);

create or replace function create_event_with_ticket_type(
  p_host_id                   uuid,
  p_slug                      text,
  p_title                     text,
  p_description               text,
  p_city                      text,
  p_venue_name                text,
  p_venue_address             text,
  p_cover_image_url           text,
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz,
  p_requires_approval         boolean,
  p_allows_cash               boolean,
  p_hide_venue_until_approved boolean,
  p_price_paise               bigint,
  p_quantity                  integer,
  p_refund_cutoff_hours       integer default 24,
  p_has_waitlist              boolean default false
)
returns events
language plpgsql
set search_path = public
as $$
declare
  ev events%rowtype;
begin
  insert into events (
    host_id, slug, title, description, city, venue_name, venue_address,
    cover_image_url, starts_at, ends_at, requires_approval, allows_cash,
    hide_venue_until_approved, refund_cutoff_hours, has_waitlist, status
  )
  values (
    p_host_id, p_slug, p_title, p_description, p_city, p_venue_name,
    p_venue_address, p_cover_image_url, p_starts_at, p_ends_at,
    p_requires_approval, p_allows_cash, p_hide_venue_until_approved,
    p_refund_cutoff_hours, p_has_waitlist and not p_requires_approval, 'draft'
  )
  returning * into ev;

  -- No compensating delete. If this raises, the insert above is rolled back by
  -- the transaction PostgREST opened for this call.
  insert into ticket_types (event_id, name, price_paise, quantity)
  values (ev.id, 'General', p_price_paise, p_quantity);

  return ev;
end;
$$;

create or replace function update_event_with_ticket_type(
  p_event_id                  uuid,
  p_title                     text,
  p_description               text,
  p_city                      text,
  p_venue_name                text,
  p_venue_address             text,
  p_cover_image_url           text,
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz,
  p_requires_approval         boolean,
  p_allows_cash               boolean,
  p_hide_venue_until_approved boolean,
  p_price_paise               bigint,
  p_quantity                  integer,
  p_refund_cutoff_hours       integer default 24,
  p_has_waitlist              boolean default false
)
returns events
language plpgsql
set search_path = public
as $$
declare
  ev     events%rowtype;
  ticket ticket_types%rowtype;
begin
  -- Ownership is settled once, here, before anything is written, and the row
  -- is held `for update` from the moment it is read -- which is why the update
  -- at the end is scoped on id alone. See 20260809000001 for the full essay.
  select * into ev
    from events
   where id = p_event_id
     and host_id = current_host_id()
   for update;

  if ev.id is null then
    raise exception 'event % is not yours to edit', p_event_id
      using errcode = 'EH002';
  end if;

  select * into ticket
    from ticket_types
   where event_id = p_event_id
   order by sort_order, created_at
   limit 1
   for update;

  if ticket.id is not null and p_quantity < ticket.reserved_count then
    raise exception 'capacity % is below the % seats already reserved',
      p_quantity, ticket.reserved_count
      using errcode = 'EH001', detail = ticket.reserved_count::text;
  end if;

  if ticket.id is not null then
    update ticket_types
       set price_paise = p_price_paise,
           quantity    = p_quantity
     where id = ticket.id;
  else
    insert into ticket_types (event_id, name, price_paise, quantity)
    values (p_event_id, 'General', p_price_paise, p_quantity);
  end if;

  update events
     set title                     = p_title,
         description               = p_description,
         city                      = p_city,
         venue_name                = p_venue_name,
         venue_address             = p_venue_address,
         cover_image_url           = p_cover_image_url,
         starts_at                 = p_starts_at,
         ends_at                   = p_ends_at,
         requires_approval         = p_requires_approval,
         allows_cash               = p_allows_cash,
         hide_venue_until_approved = p_hide_venue_until_approved,
         refund_cutoff_hours       = p_refund_cutoff_hours,
         has_waitlist              = p_has_waitlist and not p_requires_approval
   where id = p_event_id
  returning * into ev;

  return ev;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reachability
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default, so revoking from PUBLIC removes
-- it for everyone -- service_role included -- and each function has to be
-- granted back explicitly. `anon` is named alongside PUBLIC rather than left to
-- be covered by it, because a direct grant to anon survives a revoke from
-- PUBLIC and hosted Supabase projects commonly carry one (20260809000001's
-- reasoning, in full there).
--
-- cancel_booking, release_expired_holds and reserve_tickets kept their
-- signatures, so their existing revoke/grant pairs survive the replace and are
-- not restated.
--
-- waitlist_length is the one exception in this file, granted to anon on
-- purpose: the public event page is served to strangers and cannot function
-- without the line's length. See its own comment above.

revoke execute on function join_waitlist(uuid, uuid, integer, text, payment_mode)
  from public, anon, authenticated;
revoke execute on function promote_from_waitlist(uuid, integer)
  from public, anon, authenticated;
revoke execute on function waitlist_position(uuid)
  from public, anon, authenticated;
revoke execute on function waitlist_length(uuid) from public;
revoke execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) from public, anon;
revoke execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) from public, anon;

grant execute on function join_waitlist(uuid, uuid, integer, text, payment_mode)
  to service_role;
grant execute on function promote_from_waitlist(uuid, integer) to service_role;
grant execute on function waitlist_position(uuid) to service_role;
grant execute on function waitlist_length(uuid) to anon, authenticated, service_role;
grant execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) to authenticated, service_role;
grant execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) to authenticated, service_role;
```

- [ ] **Step 4: Apply both migrations and regenerate types**

```bash
npx supabase migration up   # NOT db reset -- the dev DB holds kept evidence rows
npm run db:types
git diff --stat lib/supabase/types.ts   # join_waitlist, promote_from_waitlist,
                                        # waitlist_length, waitlist_position,
                                        # events.has_waitlist, the widened writer Args
```

- [ ] **Step 5: Teach the seed helper about the toggle**

`tests/helpers/db.ts` — `SeedOptions` and the destructure in `seedEvent`:

```ts
export interface SeedOptions {
  quantity?: number
  pricePaise?: number
  requiresApproval?: boolean
  allowsCash?: boolean
  status?: 'draft' | 'published'
  maxPerOrder?: number
  hasWaitlist?: boolean
}
```

```ts
  const {
    quantity = 10,
    pricePaise = 50_000,
    requiresApproval = false,
    allowsCash = false,
    status = 'published',
    maxPerOrder = 10,
    hasWaitlist = false,
  } = options
```

and in the `events` insert, beside `allows_cash`:

```ts
      has_waitlist: hasWaitlist,
```

- [ ] **Step 6: Write the failing join tests**

`lib/bookings/waitlist.test.ts`. Model setup on `lib/bookings/approvals.test.ts`. Teardown order matters — bookings before users (`ON DELETE RESTRICT`) — and one attendee holds only one active booking per event, so every extra live entry needs its own `createTestUser`.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

/** Fills the room so the event is genuinely sold out — the state a waitlist is for. */
async function sellOut(seed: SeededEvent, seats: number): Promise<string> {
  const buyer = await createTestUser(db)
  const { error } = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: buyer,
    p_quantity: seats,
    p_attendee_name: 'Filler',
  })
  if (error) throw new Error(`sellOut failed: ${error.message}`)
  return buyer
}

async function reservedCount(ticketTypeId: string): Promise<number> {
  const { data } = await db.from('ticket_types').select('reserved_count').eq('id', ticketTypeId).single()
  return data!.reserved_count
}

describe('join_waitlist', () => {
  let seed: SeededEvent
  let filler = ''

  beforeAll(async () => {
    // maxPerOrder 3 so EH063 has something to refuse; allowsCash so the mode
    // choice is exercisable on the same event.
    seed = await seedEvent(db, {
      quantity: 2,
      pricePaise: 50_000,
      allowsCash: true,
      hasWaitlist: true,
      maxPerOrder: 3,
    })
    filler = await sellOut(seed, 2)
  })

  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('stores the entry without touching inventory and prices nothing', async () => {
    const before = await reservedCount(seed.ticketTypeId)
    const { data, error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Asha  ',
      p_payment_mode: 'online',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'waitlisted',
      quantity: 2,
      subtotal_paise: 0,
      total_paise: 0,
      commission_paise: 0,
      payment_mode: 'online',
      attendee_name: 'Asha',
    })
    expect(data!.hold_expires_at).toBeNull()
    expect(data!.approved_at).toBeNull()
    expect(await reservedCount(seed.ticketTypeId)).toBe(before)

    // Position is 1: they are the whole line.
    const { data: position } = await db.rpc('waitlist_position', { p_booking_id: data!.id })
    expect(position).toBe(1)
    const { data: length } = await db.rpc('waitlist_length', { p_ticket_type_id: seed.ticketTypeId })
    expect(length).toBe(1)
  })

  it('refuses a second entry from the same attendee with EH065', async () => {
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH065')
  })

  it('refuses more seats than max_per_order with EH063', async () => {
    const other = await createTestUser(db)
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: other,
      p_quantity: 4,
      p_attendee_name: 'Bala',
    })
    expect(error?.code).toBe('EH063')
    await db.auth.admin.deleteUser(other).catch(() => {})
  })

  it('takes a cash entry where the event allows it', async () => {
    const other = await createTestUser(db)
    const { data, error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: other,
      p_quantity: 1,
      p_attendee_name: 'Bala',
      p_payment_mode: 'cash',
    })
    expect(error).toBeNull()
    expect(data!.payment_mode).toBe('cash')
    // Second in line, behind Asha — the ordering the engine promotes by.
    const { data: position } = await db.rpc('waitlist_position', { p_booking_id: data!.id })
    expect(position).toBe(2)
    await db.from('bookings').delete().eq('id', data!.id)
    await db.auth.admin.deleteUser(other).catch(() => {})
  })
})

describe('join_waitlist refusals that need their own event', () => {
  it('refuses an event with no waitlist, and an approval event, with EH060', async () => {
    const plain = await seedEvent(db, { quantity: 1, pricePaise: 50_000 })
    const plainFiller = await sellOut(plain, 1)
    expect(
      (await db.rpc('join_waitlist', {
        p_ticket_type_id: plain.ticketTypeId,
        p_attendee_id: plain.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })).error?.code,
    ).toBe('EH060')
    await db.from('bookings').delete().eq('event_id', plain.eventId)
    await cleanupEvent(db, plain)
    await db.auth.admin.deleteUser(plainFiller).catch(() => {})

    // An approval event cannot even be seeded with a waitlist: events_one_queue
    // refuses the row. So the toggle is off, and the code is the same one.
    const approval = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    expect(
      (await db.rpc('join_waitlist', {
        p_ticket_type_id: approval.ticketTypeId,
        p_attendee_id: approval.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })).error?.code,
    ).toBe('EH060')
    await cleanupEvent(db, approval)
  })

  it('refuses a started event with EH061', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    const filler = await sellOut(seed, 1)
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', seed.eventId)
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH061')
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('refuses cash where the event does not allow it with EH062', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true, allowsCash: false })
    const filler = await sellOut(seed, 1)
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
      p_payment_mode: 'cash',
    })
    expect(error?.code).toBe('EH062')
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('refuses with EH064 while seats are open and nobody is waiting', async () => {
    const seed = await seedEvent(db, { quantity: 5, pricePaise: 50_000, hasWaitlist: true })
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH064')
    await cleanupEvent(db, seed)
  })

  it('accepts an entry too big for the open seats even with an empty line', async () => {
    // One seat free, three wanted: "book instead" is not advice they could
    // follow, so the line is the right answer and EH064 must not fire.
    const seed = await seedEvent(db, { quantity: 3, pricePaise: 50_000, hasWaitlist: true, maxPerOrder: 3 })
    const filler = await sellOut(seed, 2)
    const { data, error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 3,
      p_attendee_name: 'Asha',
    })
    expect(error).toBeNull()
    expect(data!.status).toBe('waitlisted')
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('refuses an unpublished event with the existing sentence, not a code', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true, status: 'draft' })
    const { error } = await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.message).toContain('not open for booking')
    await cleanupEvent(db, seed)
  })

  it('refuses to sit a waitlist beside an approval queue', async () => {
    // events_one_queue, met head-on: the constraint is what lets every copy
    // branch trust "approved_at on a waitlist event means an offer".
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    const { error } = await db.from('events').update({ has_waitlist: true }).eq('id', seed.eventId)
    expect(error?.message).toContain('events_one_queue')
    await cleanupEvent(db, seed)
  })
})
```

- [ ] **Step 7: Run the new file and make it pass**

```bash
npx vitest run lib/bookings/waitlist.test.ts
```

If a guard misfires, fix the SQL in the migration file — it has not shipped anywhere — but note that `npx supabase migration up` will NOT re-apply an already-applied migration. Re-apply the amended function directly by piping just its `create or replace function … $$;` block to `docker exec -i supabase_db_Event_Hoster psql -U postgres -d postgres`. The `alter table`, `alter type`, `drop index` and `create index` statements are already applied and must not be re-run. Do **not** `supabase db reset`. The migration file's final state must still apply cleanly to a fresh database.

- [ ] **Step 8: Full suite green, then commit**

`npm test` here is not a formality: `reserve_tickets`, `cancel_booking` and `release_expired_holds` were all recreated, and every booking test in the repo runs through at least one of them.

```bash
npm test
git add supabase/migrations/20260811000005_waitlist_enum.sql \
        supabase/migrations/20260811000006_waitlist.sql \
        lib/supabase/types.ts tests/helpers/db.ts lib/bookings/waitlist.test.ts
git commit -m "feat: the waitlist status, the line, and the offer engine"
```

---

### Task 2: The offer engine, proved

**Files:**
- Create: `lib/bookings/waitlist-promotion.test.ts`

No implementation of its own. Task 1 wrote the engine; this task is the suite that decides whether it is right, and every failure here is fixed in `20260811000006_waitlist.sql` by the re-apply route in Task 1's Step 7. It is a task rather than more steps on Task 1 because a reviewer can reject the queue's *behaviour* while accepting its schema, and because these are the assertions the whole product's fairness rests on.

**Interfaces:**
- Consumes: `join_waitlist`, `promote_from_waitlist`, `waitlist_position`, `waitlist_length`, `cancel_booking`, `release_expired_holds`, `reserve_tickets`, `book_cash_tickets` (Task 1 and existing).
- Produces: nothing. Assertions only.

- [ ] **Step 1: Write the suite**

`lib/bookings/waitlist-promotion.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

/** Every user this file mints, so afterEach can put them back. */
let minted: string[] = []
/** Every event this file seeds, torn down bookings-first. */
let seeded: SeededEvent[] = []

afterEach(async () => {
  for (const seed of seeded) {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
  }
  for (const id of minted) await db.auth.admin.deleteUser(id).catch(() => {})
  seeded = []
  minted = []
})

async function waitlistEvent(options: { quantity: number; pricePaise?: number; maxPerOrder?: number; allowsCash?: boolean }) {
  const seed = await seedEvent(db, {
    quantity: options.quantity,
    pricePaise: options.pricePaise ?? 50_000,
    maxPerOrder: options.maxPerOrder ?? 10,
    allowsCash: options.allowsCash ?? false,
    hasWaitlist: true,
  })
  seeded.push(seed)
  return seed
}

/** Takes `seats` with a confirmed cash booking, so the room is really full. */
async function fill(seed: SeededEvent, seats: number): Promise<string> {
  const buyer = await createTestUser(db)
  minted.push(buyer)
  const { data, error } = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: buyer,
    p_quantity: seats,
    p_attendee_name: 'Filler',
  })
  if (error) throw new Error(`fill failed: ${error.message}`)
  return data!.id
}

/** Joins the line as a fresh attendee and returns the entry's booking id. */
async function join(seed: SeededEvent, seats: number, name: string, mode: 'online' | 'cash' = 'online'): Promise<string> {
  const attendee = await createTestUser(db)
  minted.push(attendee)
  const { data, error } = await db.rpc('join_waitlist', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: attendee,
    p_quantity: seats,
    p_attendee_name: name,
    p_payment_mode: mode,
  })
  if (error) throw new Error(`join failed: ${error.message}`)
  return data!.id
}

async function statusOf(bookingId: string): Promise<string> {
  const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
  return data!.status
}

async function reservedCount(ticketTypeId: string): Promise<number> {
  const { data } = await db.from('ticket_types').select('reserved_count').eq('id', ticketTypeId).single()
  return data!.reserved_count
}

describe('promote_from_waitlist', () => {
  it('offers a freed seat to the head, shaped exactly like a granted approval', async () => {
    const seed = await waitlistEvent({ quantity: 2 })
    const filler = await fill(seed, 2)
    const asha = await join(seed, 1, 'Asha')

    // The cancel itself promotes; nothing else is called.
    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    const { data } = await db.from('bookings').select('*').eq('id', asha).single()
    expect(data!.status).toBe('awaiting_payment')
    expect(data!.approved_at).toBeTruthy()
    expect(data!.subtotal_paise).toBe(50_000)
    expect(data!.total_paise).toBe(50_000)
    expect(data!.convenience_fee_paise).toBe(0)
    expect(data!.commission_paise).toBe(0)
    const holdMs = new Date(data!.hold_expires_at!).getTime() - Date.now()
    expect(holdMs).toBeGreaterThan(23 * 3600_000)
    expect(holdMs).toBeLessThan(25 * 3600_000)
    // The seat left the pool with them.
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
    expect(await db.rpc('waitlist_length', { p_ticket_type_id: seed.ticketTypeId })).toMatchObject({ data: 0 })
  })

  it('strict FIFO: a head that does not fit blocks the line, and nobody passes them', async () => {
    const seed = await waitlistEvent({ quantity: 3, maxPerOrder: 3 })
    const filler = await fill(seed, 3)
    const bigHead = await join(seed, 3, 'Head of three')
    const single = await join(seed, 1, 'One seat')

    // Free exactly one seat: the head needs three, so nothing may happen —
    // and in particular the one-seat entry behind them must not jump.
    await db.from('bookings').update({ quantity: 2 }).eq('id', filler)
    await db.from('ticket_types').update({ reserved_count: 2 }).eq('id', seed.ticketTypeId)
    const { data: promoted } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })

    expect(promoted).toBe(0)
    expect(await statusOf(bigHead)).toBe('waitlisted')
    expect(await statusOf(single)).toBe('waitlisted')
    expect(await reservedCount(seed.ticketTypeId)).toBe(2)
  })

  it('chains down the line while seats keep fitting', async () => {
    const seed = await waitlistEvent({ quantity: 3 })
    const filler = await fill(seed, 3)
    const first = await join(seed, 1, 'First')
    const second = await join(seed, 1, 'Second')
    const third = await join(seed, 1, 'Third')

    // Two seats come back at once: the first two in line are offered, in order.
    await db.from('bookings').update({ quantity: 1 }).eq('id', filler)
    await db.from('ticket_types').update({ reserved_count: 1 }).eq('id', seed.ticketTypeId)
    const { data: promoted } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })

    expect(promoted).toBe(2)
    expect(await statusOf(first)).toBe('awaiting_payment')
    expect(await statusOf(second)).toBe('awaiting_payment')
    expect(await statusOf(third)).toBe('waitlisted')
    expect(await reservedCount(seed.ticketTypeId)).toBe(3)
    // The survivor is now the whole line, at position 1.
    const { data: position } = await db.rpc('waitlist_position', { p_booking_id: third })
    expect(position).toBe(1)
  })

  it('a lapsed offer expires, returns its seat, and the same call offers it onward', async () => {
    const seed = await waitlistEvent({ quantity: 1 })
    const filler = await fill(seed, 1)
    const first = await join(seed, 1, 'First')
    const second = await join(seed, 1, 'Second')

    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })
    expect(await statusOf(first)).toBe('awaiting_payment')

    // Their 24 hours run out without a payment or a claim.
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', first)
    await db.rpc('release_expired_holds')

    expect(await statusOf(first)).toBe('expired')
    expect(await statusOf(second)).toBe('awaiting_payment')
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
  })

  it('withdrawing a blocking head unblocks the line behind it', async () => {
    const seed = await waitlistEvent({ quantity: 3, maxPerOrder: 3 })
    const filler = await fill(seed, 3)
    const bigHead = await join(seed, 3, 'Head of three')
    const single = await join(seed, 1, 'One seat')

    // One seat free, blocked by the three-seat head.
    await db.from('bookings').update({ quantity: 2 }).eq('id', filler)
    await db.from('ticket_types').update({ reserved_count: 2 }).eq('id', seed.ticketTypeId)
    expect(await statusOf(single)).toBe('waitlisted')

    // The head withdraws. No seat is freed by that cancel — the entry held
    // none — but the line moves, which is why cancel_booking promotes
    // unconditionally rather than only when inventory came back.
    await db.rpc('cancel_booking', { p_booking_id: bigHead, p_reason: 'cancelled by attendee' })

    expect(await statusOf(single)).toBe('awaiting_payment')
    expect(await reservedCount(seed.ticketTypeId)).toBe(3)
  })

  it('reprices from the price at offer time, not the price when they joined', async () => {
    const seed = await waitlistEvent({ quantity: 1, pricePaise: 50_000 })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha')

    // The host raises the price while Asha is in the line.
    await db.from('ticket_types').update({ price_paise: 80_000 }).eq('id', seed.ticketTypeId)
    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    const { data } = await db.from('bookings').select('subtotal_paise, total_paise').eq('id', asha).single()
    expect(data!.subtotal_paise).toBe(80_000)
    expect(data!.total_paise).toBe(80_000)
  })

  it('a walk-up cannot cut the line: the waitlister gets the freed seat', async () => {
    const seed = await waitlistEvent({ quantity: 1 })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha')
    const walkUp = await createTestUser(db)
    minted.push(walkUp)

    // The cancel and the walk-up's reservation race. Whichever order they
    // land in, the cancel's own promote runs under the ticket-type lock and
    // reserve_tickets promotes before it sells, so the seat is Asha's.
    const [, reserved] = await Promise.all([
      db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' }),
      db.rpc('reserve_tickets', {
        p_ticket_type_id: seed.ticketTypeId,
        p_attendee_id: walkUp,
        p_quantity: 1,
      }),
    ])

    expect(await statusOf(asha)).toBe('awaiting_payment')
    expect(reserved.error?.message).toContain('seats remain')
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
  })

  it('offers nothing once the event has started', async () => {
    const seed = await waitlistEvent({ quantity: 1 })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha')

    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', seed.eventId)
    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    // Inert, not cancelled: the entry stays withdrawable and nothing sweeps it.
    expect(await statusOf(asha)).toBe('waitlisted')
    expect(await reservedCount(seed.ticketTypeId)).toBe(0)
  })

  it('is a no-op on an event that keeps no waitlist', async () => {
    const seed = await seedEvent(db, { quantity: 2, pricePaise: 50_000 })
    seeded.push(seed)
    const { data, error } = await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })
    expect(error).toBeNull()
    expect(data).toBe(0)
  })

  it('is a no-op for a ticket type that does not exist', async () => {
    const { data, error } = await db.rpc('promote_from_waitlist', {
      p_ticket_type_id: '00000000-0000-4000-8000-00000000dead',
    })
    expect(error).toBeNull()
    expect(data).toBe(0)
  })

  it('offers cash and free entries the same hold, without confirming them', async () => {
    // The ghost-in-the-line case: a cash entry must still act inside its
    // window, or the seat is gone for 24 hours per inattentive person and
    // then forever.
    const seed = await waitlistEvent({ quantity: 1, allowsCash: true })
    const filler = await fill(seed, 1)
    const asha = await join(seed, 1, 'Asha', 'cash')

    await db.rpc('cancel_booking', { p_booking_id: filler, p_reason: 'test' })

    const { data } = await db.from('bookings').select('status, payment_mode, total_paise, hold_expires_at').eq('id', asha).single()
    expect(data!.status).toBe('awaiting_payment')
    expect(data!.payment_mode).toBe('cash')
    expect(data!.total_paise).toBe(50_000)
    expect(data!.hold_expires_at).toBeTruthy()
    // No tickets: nothing is confirmed until the seat is claimed.
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', asha)
    expect(count).toBe(0)
  })
})
```

- [ ] **Step 2: Run it**

```bash
npx vitest run lib/bookings/waitlist-promotion.test.ts
```

Two failures worth naming in advance, because both mean the migration is wrong rather than the test:

- **"a head that does not fit blocks the line" promoting the one-seat entry** means the loop is selecting the first entry that *fits* rather than the first entry. Re-read the `order by b.created_at, b.id … limit 1` — the fit check must come after the head is chosen, never inside the choosing.
- **"a walk-up cannot cut the line" letting the reservation through** means `reserve_tickets` lost its `perform promote_from_waitlist` line, or it sits after the `for update` rather than before it.

- [ ] **Step 3: Full suite, then commit**

```bash
npm test
git add lib/bookings/waitlist-promotion.test.ts
git commit -m "test: strict FIFO, chaining, lapse and the walk-up that cannot cut"
```

---

### Task 3: The words — EH06x sentences and the copy module

**Files:**
- Modify: `lib/bookings/rpc-errors.ts`
- Create: `lib/bookings/waitlist-copy.ts`
- Create: `lib/bookings/waitlist-copy.test.ts`
- Test: extend `lib/bookings/rpc-errors.test.ts`

Every sentence this phase says, in one pure module with one test file, because the alternative is prose buried in four JSX files where nothing can assert it and two of them will drift. `approvedPaySentence` is here too: it is 5a's, moved out of `approved-pay-panel.tsx` (Task 8 rewires the panel), so the approval offer and the waitlist offer are written side by side and read as siblings rather than as two people's guesses.

**Interfaces:**
- Consumes: nothing but its arguments. No clock, no I/O, no `formatPaise` — every amount and deadline arrives already formatted, because the server owns both the money format and the timezone.
- Produces:
  - `mapBookingRpcError(error: PostgrestError): string` — now also maps EH060–EH065.
  - `waitlistPositionLine(position: number, seats: number): string`
  - `waitlistShortPosition(position: number): string`
  - `waitlistPriceLine(amountLabel: string | null): string`
  - `lineLengthLine(length: number): string`
  - `approvedPaySentence(amountLabel: string, deadlineLabel: string): string`
  - `offerPaySentence(amountLabel: string, deadlineLabel: string): string`
  - `offerClaimSentence(deadlineLabel: string, doorAmountLabel: string | null): string`
  - `LAPSED_OFFER_SENTENCE: string`
  - `REMOVE_FROM_WAITLIST_CONSEQUENCE: string`

- [ ] **Step 1: Write the failing tests**

`lib/bookings/waitlist-copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  approvedPaySentence,
  LAPSED_OFFER_SENTENCE,
  lineLengthLine,
  offerClaimSentence,
  offerPaySentence,
  REMOVE_FROM_WAITLIST_CONSEQUENCE,
  waitlistPositionLine,
  waitlistPriceLine,
  waitlistShortPosition,
} from '@/lib/bookings/waitlist-copy'

const DEADLINE = '12 Aug 2026, 7:00 pm'

describe('the attendee’s place in the line', () => {
  it('says the position and the seats, singular and plural', () => {
    expect(waitlistPositionLine(3, 2)).toBe('You’re #3 in line for 2 seats.')
    expect(waitlistPositionLine(1, 1)).toBe('You’re #1 in line for 1 seat.')
  })

  it('has a short form for a list row', () => {
    expect(waitlistShortPosition(4)).toBe('#4 in line')
  })
})

describe('the join panel’s price line', () => {
  it('promises payment only on an offer', () => {
    expect(waitlistPriceLine('₹500')).toBe('₹500 — you pay only if a seat opens for you')
  })

  it('says something true about a free event, where there is nothing to pay', () => {
    expect(waitlistPriceLine(null)).toBe('Free — you’re in only if a seat opens for you')
  })
})

describe('the line’s length, for a stranger deciding whether to join', () => {
  it('counts people, not seats', () => {
    expect(lineLengthLine(0)).toBe('Nobody waiting yet')
    expect(lineLengthLine(1)).toBe('1 person waiting')
    expect(lineLengthLine(7)).toBe('7 people waiting')
  })
})

describe('the two offers', () => {
  it('keeps 5a’s approval sentence intact', () => {
    expect(approvedPaySentence('₹500', DEADLINE)).toBe(
      'You’re approved! Pay ₹500 by 12 Aug 2026, 7:00 pm to confirm your seat.',
    )
  })

  it('leads a waitlist offer with the news, not the bill', () => {
    expect(offerPaySentence('₹500', DEADLINE)).toBe(
      'A seat opened up — pay ₹500 by 12 Aug 2026, 7:00 pm to take it.',
    )
  })

  it('asks a free offer to be claimed, with nothing about money', () => {
    expect(offerClaimSentence(DEADLINE, null)).toBe(
      'A seat opened up — claim it by 12 Aug 2026, 7:00 pm.',
    )
  })

  it('tells a cash offer where the money happens', () => {
    expect(offerClaimSentence(DEADLINE, '₹500')).toBe(
      'A seat opened up — claim it by 12 Aug 2026, 7:00 pm. You’ll pay ₹500 in cash at the door.',
    )
  })
})

describe('the two endings', () => {
  it('names the next move after a lapse', () => {
    expect(LAPSED_OFFER_SENTENCE).toBe('Your seat offer expired — you can rejoin the waitlist.')
  })

  it('promises no money when the host removes someone from the line', () => {
    // Nothing was paid and no seat was held, so this must not read like
    // cancelConsequence's refund promise.
    expect(REMOVE_FROM_WAITLIST_CONSEQUENCE).toBe('Removing takes them off the waitlist.')
  })
})
```

Append to `lib/bookings/rpc-errors.test.ts`:

```ts
describe('mapBookingRpcError EH06x', () => {
  it('maps every Phase 5b code to a sentence', () => {
    expect(mapBookingRpcError(err('EH060'))).toBe("This event doesn't keep a waitlist.")
    expect(mapBookingRpcError(err('EH061'))).toBe('This event has already started.')
    expect(mapBookingRpcError(err('EH062'))).toBe("This event doesn't take cash bookings.")
    expect(mapBookingRpcError(err('EH063'))).toBe("That's more seats than this event allows per booking.")
    expect(mapBookingRpcError(err('EH064'))).toBe('Seats are open — book instead of joining the waitlist.')
    expect(mapBookingRpcError(err('EH065'))).toBe(
      'You have already booked this event. Cancel that booking first to change it.',
    )
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run lib/bookings/waitlist-copy.test.ts lib/bookings/rpc-errors.test.ts
```

Expected: the copy file fails to resolve; the EH06x codes fall through to `error.message` and come back as `'raw postgres text'`.

- [ ] **Step 3: Write the copy module**

`lib/bookings/waitlist-copy.ts`:

```ts
/**
 * Every sentence the waitlist says, in one place.
 *
 * Pure: no clock, no locale, no money formatting. Amounts arrive as strings
 * from formatPaise and deadlines as strings from formatIst, both computed on
 * the server that owns the rupee format and the timezone — so this module
 * cannot be the reason a price or a time is wrong, only the reason a sentence
 * is.
 *
 * Here rather than in the four components that print these, because copy in
 * JSX is copy nothing can assert. Four surfaces say "a seat opened up" in this
 * phase and they have to say it identically; a test file is the only thing
 * that makes that survive the next edit.
 */

/** Seats, said the way a person would. */
function seatsPhrase(seats: number): string {
  return `${seats} ${seats === 1 ? 'seat' : 'seats'}`
}

/** Where the attendee stands, on their own booking page. */
export function waitlistPositionLine(position: number, seats: number): string {
  return `You’re #${position} in line for ${seatsPhrase(seats)}.`
}

/** The same fact in a list row, where the seats are already in the line above. */
export function waitlistShortPosition(position: number): string {
  return `#${position} in line`
}

/**
 * The join panel's headline. Its whole job is that joining costs nothing now —
 * the price is real but conditional, and a bare "₹500" over a Join button reads
 * as a charge about to happen.
 *
 * `null` means a free event, where there is no amount to qualify and the
 * sentence has to earn its place some other way.
 */
export function waitlistPriceLine(amountLabel: string | null): string {
  return amountLabel === null
    ? 'Free — you’re in only if a seat opens for you'
    : `${amountLabel} — you pay only if a seat opens for you`
}

/** How long the line is, for a stranger deciding whether it is worth joining. */
export function lineLengthLine(length: number): string {
  if (length === 0) return 'Nobody waiting yet'
  return `${length} ${length === 1 ? 'person' : 'people'} waiting`
}

/**
 * 5a's approval offer, moved here verbatim from approved-pay-panel.tsx so that
 * it and the waitlist offer below are written next to each other. They are the
 * same event to the machinery — awaiting_payment, approved_at, a 24-hour hold —
 * and deliberately different news to the person: one is a host saying yes, the
 * other is a seat coming free.
 */
export function approvedPaySentence(amountLabel: string, deadlineLabel: string): string {
  return `You’re approved! Pay ${amountLabel} by ${deadlineLabel} to confirm your seat.`
}

/** An online offer: the news first, then what it costs to take. */
export function offerPaySentence(amountLabel: string, deadlineLabel: string): string {
  return `A seat opened up — pay ${amountLabel} by ${deadlineLabel} to take it.`
}

/**
 * A free or cash offer. Nothing is charged here — cash pays at the door, as
 * everywhere in this product — so the deadline is a deadline to *act*, and
 * saying so is the only thing standing between an attendee and a seat that
 * quietly lapses to the next person.
 *
 * `doorAmountLabel` is null on a free event and the amount on a cash one.
 */
export function offerClaimSentence(deadlineLabel: string, doorAmountLabel: string | null): string {
  const claim = `A seat opened up — claim it by ${deadlineLabel}.`
  return doorAmountLabel === null
    ? claim
    : `${claim} You’ll pay ${doorAmountLabel} in cash at the door.`
}

/**
 * The ending for an offer nobody took. Names the next move, because there is
 * one: the one-active index ignores 'expired', so rejoining is allowed — at
 * the back of the line, which the sentence does not promise otherwise.
 */
export const LAPSED_OFFER_SENTENCE = 'Your seat offer expired — you can rejoin the waitlist.'

/**
 * What removing a waitlist entry does, stated beside the host's control the
 * way cancelConsequence states a refund. Deliberately not routed through
 * cancelConsequence: that function answers a question about money, and the
 * honest answer here is that there is none — no payment was taken and no seat
 * was held — so it would return null and the host would get no sentence at all
 * where one is owed.
 */
export const REMOVE_FROM_WAITLIST_CONSEQUENCE = 'Removing takes them off the waitlist.'
```

- [ ] **Step 4: Map the codes**

`lib/bookings/rpc-errors.ts` — add below the EH05x constants:

```ts
/** Phase 5b: the waitlist block. */
const NO_WAITLIST = 'EH060'
const WAITLIST_STARTED = 'EH061'
const WAITLIST_CASH_NOT_ALLOWED = 'EH062'
const WAITLIST_OVER_MAX_PER_ORDER = 'EH063'
const SEATS_ARE_OPEN = 'EH064'
const WAITLIST_ALREADY_ACTIVE = 'EH065'
```

and inside `mapBookingRpcError`, before the final passthrough. Four of the six join existing sentences rather than inventing near-duplicates — an attendee meeting "more seats than this event allows" does not care which queue refused them:

```ts
  if (error.code === NO_WAITLIST) return "This event doesn't keep a waitlist."
  if (error.code === WAITLIST_STARTED) return 'This event has already started.'
  if (error.code === WAITLIST_CASH_NOT_ALLOWED) return "This event doesn't take cash bookings."
  if (error.code === WAITLIST_OVER_MAX_PER_ORDER) {
    return "That's more seats than this event allows per booking."
  }
  if (error.code === SEATS_ARE_OPEN) return 'Seats are open — book instead of joining the waitlist.'
  if (error.code === WAITLIST_ALREADY_ACTIVE) {
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
```

Update the function's header comment: it now maps twenty codes across four phases of booking development — EH010–EH013, EH050–EH059 and EH060–EH065.

- [ ] **Step 5: Green, then commit**

```bash
npx vitest run lib/bookings/waitlist-copy.test.ts lib/bookings/rpc-errors.test.ts
npm test
git add lib/bookings/waitlist-copy.ts lib/bookings/waitlist-copy.test.ts \
        lib/bookings/rpc-errors.ts lib/bookings/rpc-errors.test.ts
git commit -m "feat: the waitlist's sentences, and the EH06x refusals"
```

---

### Task 4: The service — join, claim, and where you stand

**Files:**
- Modify: `lib/bookings/service.ts`
- Create: `lib/bookings/waitlist-service.test.ts`
- Create: `lib/payments/waitlist-offer-checkout.test.ts`

**Interfaces:**
- Consumes: `mapBookingRpcError` (Task 3), `mayCancel` (`lib/bookings/authorize.ts:19`), the Task 1 RPCs, `createAdminClient`, `Caller`, `BookingResult` / `ApproveResult` (already exported from this module).
- Produces (Tasks 7–9 call these from Server Actions and pages):
  - `joinWaitlist(caller: Caller, ticketTypeId: string, quantity: number, attendeeName: string, paymentMode: 'online' | 'cash'): Promise<BookingResult>`
  - `claimOfferedSeat(caller: Caller, bookingId: string): Promise<ApproveResult>`
  - `waitlistPosition(caller: Caller, bookingId: string): Promise<number | null>` — null when the caller is neither the attendee nor the host, when the lookup fails, and when the booking is not `waitlisted`. All three are the same answer on purpose: "there is no position to show here".

**`beginApprovedCheckout` needs no change — verified, not assumed.** Its preconditions (`lib/payments/service.ts:128-138`) are: the caller is the attendee; `status === 'awaiting_payment'`; `approved_at` is set; `payment_mode === 'online'`; `hold_expires_at` is set and in the future. A promoted online entry satisfies all five by construction — Task 1's engine writes exactly those four fields. Its two refusal sentences are already queue-neutral: `'That booking is not yours to pay for.'` and `'There is nothing to pay on this booking right now.'` (`lib/payments/service.ts:86-87`); neither says "approval". The last test file in this task proves the whole join end to end rather than resting on this paragraph.

- [ ] **Step 1: Write the failing service tests**

`lib/bookings/waitlist-service.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import {
  cancelBooking,
  claimOfferedSeat,
  joinWaitlist,
  waitlistPosition,
} from '@/lib/bookings/service'

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

/** Confirms `seats` against the room so the event is genuinely full. */
async function fill(seed: SeededEvent, seats: number): Promise<{ buyer: string; bookingId: string }> {
  const buyer = await createTestUser(db)
  const { data, error } = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: buyer,
    p_quantity: seats,
    p_attendee_name: 'Filler',
  })
  if (error) throw new Error(`fill failed: ${error.message}`)
  return { buyer, bookingId: data!.id }
}

describe('joinWaitlist', () => {
  let seed: SeededEvent
  let filler = ''
  let stranger = ''

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, allowsCash: true, hasWaitlist: true })
    filler = (await fill(seed, 1)).buyer
    stranger = await createTestUser(db)
  })

  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
  })

  it('joins as the caller, never as a form value', async () => {
    const result = await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(result.ok).toBe(true)

    const { data } = await db
      .from('bookings')
      .select('attendee_id, status, total_paise')
      .eq('event_id', seed.eventId)
      .eq('status', 'waitlisted')
      .single()
    expect(data).toMatchObject({ attendee_id: seed.attendeeId, status: 'waitlisted', total_paise: 0 })
  })

  it('turns a refusal into a sentence rather than a Postgres code', async () => {
    // Same attendee, second entry: EH065 underneath.
    const again = await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(again).toEqual({
      ok: false,
      error: 'You have already booked this event. Cancel that booking first to change it.',
    })
  })

  it('shows a position to the attendee and to the host, and to nobody else', async () => {
    const { data: entry } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'waitlisted').single()

    expect(await waitlistPosition(asCaller(seed.attendeeId), entry!.id)).toBe(1)
    expect(await waitlistPosition(asCaller(seed.hostProfileId), entry!.id)).toBe(1)
    expect(await waitlistPosition(asCaller(stranger), entry!.id)).toBeNull()
  })

  it('has no position for a booking that is not in the line', async () => {
    const { data: confirmed } = await db
      .from('bookings').select('id, attendee_id').eq('event_id', seed.eventId).eq('status', 'confirmed').single()
    expect(await waitlistPosition(asCaller(confirmed!.attendee_id), confirmed!.id)).toBeNull()
  })

  it('lets the attendee withdraw, which frees them to rejoin', async () => {
    const { data: entry } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'waitlisted').single()

    expect(await cancelBooking(asCaller(seed.attendeeId), entry!.id, 'attendee')).toEqual({ ok: true })

    const rejoined = await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(rejoined.ok).toBe(true)
  })
})

describe('claimOfferedSeat', () => {
  let seed: SeededEvent
  let filler = { buyer: '', bookingId: '' }
  let stranger = ''

  beforeAll(async () => {
    // Cash, so the offer is claimed rather than paid.
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, allowsCash: true, hasWaitlist: true })
    filler = await fill(seed, 1)
    stranger = await createTestUser(db)
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'cash')
    // Freeing the seat promotes Asha — the offer now exists.
    await db.rpc('cancel_booking', { p_booking_id: filler.bookingId, p_reason: 'test' })
  })

  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler.buyer, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
  })

  it('refuses everyone but the attendee, with one sentence for all of them', async () => {
    const { data: offer } = await db
      .from('bookings').select('id').eq('attendee_id', seed.attendeeId).single()

    for (const who of [stranger, seed.hostProfileId]) {
      expect(await claimOfferedSeat(asCaller(who), offer!.id)).toEqual({
        ok: false,
        error: 'That seat offer is not yours to claim.',
      })
    }
    // And an id that is not a booking at all gets the same answer — no oracle.
    expect(
      await claimOfferedSeat(asCaller(seed.attendeeId), '00000000-0000-4000-8000-00000000dead'),
    ).toEqual({ ok: false, error: 'That seat offer is not yours to claim.' })

    const { data: after } = await db.from('bookings').select('status').eq('id', offer!.id).single()
    expect(after!.status).toBe('awaiting_payment')
  })

  it('confirms the seat with a ticket per person, and is idempotent', async () => {
    const { data: offer } = await db
      .from('bookings').select('id').eq('attendee_id', seed.attendeeId).single()

    expect(await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).toEqual({ ok: true })

    const { data: after } = await db
      .from('bookings').select('status, payment_mode, total_paise').eq('id', offer!.id).single()
    expect(after).toMatchObject({ status: 'confirmed', payment_mode: 'cash', total_paise: 50_000 })

    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', offer!.id)
    expect(count).toBe(1)

    // A double tap must not issue a second ticket. confirm_booking returns
    // early on an already-confirmed row, so the second claim is refused before
    // it ever gets there — the status is no longer awaiting_payment.
    expect((await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).ok).toBe(false)
    const { count: still } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', offer!.id)
    expect(still).toBe(1)
  })
})

describe('claimOfferedSeat on offers it must not touch', () => {
  it('refuses an online offer — that one is paid for, not claimed', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    const filler = await fill(seed, 1)
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    await db.rpc('cancel_booking', { p_booking_id: filler.bookingId, p_reason: 'test' })

    const { data: offer } = await db
      .from('bookings').select('id, status').eq('attendee_id', seed.attendeeId).single()
    expect(offer!.status).toBe('awaiting_payment')
    expect(await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).toEqual({
      ok: false,
      error: 'There is no seat to claim on this booking right now.',
    })

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler.buyer).catch(() => {})
  })

  it('claims a FREE offer, where there is no online money to ask for', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 0, hasWaitlist: true })
    const buyer = await createTestUser(db)
    const { data: booked } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: buyer,
      p_quantity: 1,
      p_attendee_name: 'Filler',
    })
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    await db.rpc('cancel_booking', { p_booking_id: booked!.id, p_reason: 'test' })

    const { data: offer } = await db
      .from('bookings').select('id, total_paise').eq('attendee_id', seed.attendeeId).single()
    expect(offer!.total_paise).toBe(0)
    expect(await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).toEqual({ ok: true })

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(buyer).catch(() => {})
  })

  it('refuses a lapsed offer, and the settle turns it into an expired one', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, allowsCash: true, hasWaitlist: true })
    const filler = await fill(seed, 1)
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'cash')
    await db.rpc('cancel_booking', { p_booking_id: filler.bookingId, p_reason: 'test' })

    const { data: offer } = await db.from('bookings').select('id').eq('attendee_id', seed.attendeeId).single()
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', offer!.id)

    expect((await claimOfferedSeat(asCaller(seed.attendeeId), offer!.id)).ok).toBe(false)
    // The claim's own settle did it: the row is expired and the seat is back.
    const { data: after } = await db.from('bookings').select('status').eq('id', offer!.id).single()
    expect(after!.status).toBe('expired')

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler.buyer).catch(() => {})
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/bookings/waitlist-service.test.ts
```

Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement in `lib/bookings/service.ts`**

Append below `declineBooking`. `mayCancel` joins the existing import from `@/lib/bookings/authorize`:

```ts
/** One refusal for "not yours", "does not exist" and "the lookup failed" — a
 *  stranger must not be able to tell an offer that exists from one that does
 *  not, and an outage must not be distinguishable from a refusal. */
const NOT_YOURS_TO_CLAIM = 'That seat offer is not yours to claim.'
const NOTHING_TO_CLAIM = 'There is no seat to claim on this booking right now.'

export async function joinWaitlist(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  paymentMode: 'online' | 'cash',
): Promise<BookingResult> {
  const db = createAdminClient()
  const { data, error } = await db.rpc('join_waitlist', {
    p_ticket_type_id: ticketTypeId,
    // The caller's own id. There is no parameter through which a request could
    // supply someone else's, and there must never be one.
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
    p_payment_mode: paymentMode,
  })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: data.reference }
}

/**
 * Takes a free or cash seat offer.
 *
 * The online twin of this is beginApprovedCheckout, which needs no waitlist
 * branch: an offer is awaiting_payment with approved_at set, which is every
 * precondition it already checks. This function exists for the two cases that
 * have no online money to ask for — cash pays at the door, free pays nothing —
 * where the honest control is "claim", not "pay".
 *
 * Deliberately NOT owner-or-host like cancelBooking: a host must not be able
 * to claim a seat on a guest's behalf. Claiming is an acceptance, and only the
 * person being offered the seat can accept it.
 */
export async function claimOfferedSeat(caller: Caller, bookingId: string): Promise<ApproveResult> {
  const db = createAdminClient()

  const { data: booking, error: readError } = await db
    .from('bookings')
    .select('id, attendee_id, ticket_type_id')
    .eq('id', bookingId)
    .maybeSingle()

  if (readError) {
    console.error('[bookings] could not read the booking for a seat claim', readError)
    return { ok: false, error: NOT_YOURS_TO_CLAIM }
  }
  if (!booking || booking.attendee_id !== caller.id) return { ok: false, error: NOT_YOURS_TO_CLAIM }

  // Settle before judging, so a hold that ran out an hour ago cannot be
  // claimed by someone who left the tab open. This also hands the seat to the
  // next person in the same call, which is why it happens even though the
  // guard below would have refused anyway: refusing without settling would
  // leave the seat held by a dead offer until something else swept it.
  const { error: settleError } = await db.rpc('release_expired_holds', {
    p_ticket_type_id: booking.ticket_type_id,
  })
  if (settleError) {
    console.error('[bookings] could not settle holds before a seat claim', settleError)
    return { ok: false, error: NOTHING_TO_CLAIM }
  }

  // Re-read AFTER the settle: the row may have just become 'expired', and the
  // whole point of settling first is that this read is the truthful one.
  const { data: fresh, error: freshError } = await db
    .from('bookings')
    .select('status, approved_at, payment_mode, total_paise')
    .eq('id', bookingId)
    .maybeSingle()
  if (freshError || !fresh) {
    console.error('[bookings] could not re-read the booking for a seat claim', freshError)
    return { ok: false, error: NOTHING_TO_CLAIM }
  }

  // An offer, and one with nothing to pay online. An online offer belongs to
  // beginApprovedCheckout, and sending it here would confirm a seat nobody
  // paid for.
  const isOffer = fresh.status === 'awaiting_payment' && !!fresh.approved_at
  const claimable = fresh.payment_mode === 'cash' || fresh.total_paise === 0
  if (!isOffer || !claimable) return { ok: false, error: NOTHING_TO_CLAIM }

  const { error } = await db.rpc('confirm_booking', { p_booking_id: bookingId })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true }
}

/**
 * Where this booking stands in its line, 1-based. Null when there is no
 * position to show.
 *
 * A read in the writes file, which the module comment above forbids in spirit
 * — but the ESLint fence decides where the service role may be held, and
 * waitlist_position is service-role only for the reason its own SQL comment
 * gives. cancelBooking and readForDecision already read here for the same
 * reason: a service-role read that precedes a decision belongs beside the
 * decision.
 *
 * Owner-or-host, via the same mayCancel that arbitrates withdraw and remove —
 * the two people entitled to act on this entry are exactly the two entitled to
 * see where it stands.
 */
export async function waitlistPosition(caller: Caller, bookingId: string): Promise<number | null> {
  const db = createAdminClient()

  const { data: booking, error: readError } = await db
    .from('bookings')
    .select('attendee_id, events(hosts(profile_id))')
    .eq('id', bookingId)
    .maybeSingle()

  if (readError) {
    console.error('[bookings] could not read the booking for a waitlist position', readError)
    return null
  }
  if (!booking) return null

  if (
    !mayCancel(caller, {
      attendee_id: booking.attendee_id,
      event_host_profile_id: booking.events.hosts.profile_id,
    })
  ) {
    return null
  }

  const { data, error } = await db.rpc('waitlist_position', { p_booking_id: bookingId })
  if (error) {
    console.error('[bookings] could not read a waitlist position', error)
    return null
  }
  // 0 is the function's way of saying "this row is not in the line" — a
  // promoted, withdrawn or expired entry. Null is this module's way of saying
  // the same thing, so no caller has to know about the sentinel.
  return data && data > 0 ? data : null
}
```

- [ ] **Step 4: Prove the online offer rides the Phase 3 rails end to end**

`lib/payments/waitlist-offer-checkout.test.ts`. Read `lib/payments/approved-checkout.test.ts` first — this file is its waitlist twin, using the same `fakeProvider` / `capturedEvent` helpers and the same scoped teardown, with a promoted entry where its `approvedBooking()` had an approved request:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { capturedEvent, fakeProvider } from '@/tests/helpers/payments'
import type { Caller } from '@/lib/bookings/caller'

vi.mock('@/lib/payments/razorpay')

const { razorpayProvider } = await import('@/lib/payments/razorpay')
const { beginApprovedCheckout, processWebhookEvent } = await import('@/lib/payments/service')

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

describe('an online seat offer on the Phase 3 rails', () => {
  let seed: SeededEvent
  let filler = ''
  let provider: ReturnType<typeof fakeProvider>

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    // Fill the room, put Asha in the line, then free the seat so she is
    // promoted. Nothing here is approval machinery — the shape it produces
    // just happens to be identical, which is the entire design.
    filler = await createTestUser(db)
    const { data: booked } = await db.rpc('book_cash_tickets', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: filler,
      p_quantity: 1,
      p_attendee_name: 'Filler',
    })
    await db.rpc('join_waitlist', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    await db.rpc('cancel_booking', { p_booking_id: booked!.id, p_reason: 'test' })
  })

  beforeEach(() => {
    provider = fakeProvider()
    vi.mocked(razorpayProvider).mockReturnValue(provider)
  })

  afterAll(async () => {
    // Scoped exactly as approved-checkout.test.ts scopes it: the dev DB
    // doubles as the test DB and holds kept evidence payments and receipts.
    const { data: bookings } = await db.from('bookings').select('id').eq('event_id', seed.eventId)
    const ids = (bookings ?? []).map((b) => b.id)
    if (ids.length > 0) {
      const { data: payments } = await db.from('payments').select('id').in('booking_id', ids)
      const paymentIds = (payments ?? []).map((p) => p.id)
      if (paymentIds.length > 0) await db.from('refunds').delete().in('payment_id', paymentIds)
      await db.from('payments').delete().in('booking_id', ids)
    }
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(filler).catch(() => {})
  })

  it('the join: offer → order → captured webhook → confirmed with tickets', async () => {
    const { data: offer } = await db
      .from('bookings')
      .select('id, total_paise, status, approved_at')
      .eq('attendee_id', seed.attendeeId)
      .single()
    // The precondition set beginApprovedCheckout checks, met by promotion
    // alone — no approve_booking was ever called on this row.
    expect(offer).toMatchObject({ status: 'awaiting_payment', total_paise: 50_000 })
    expect(offer!.approved_at).toBeTruthy()

    expect(await beginApprovedCheckout(asCaller(seed.attendeeId), offer!.id)).toEqual({ ok: true })

    const { data: payment } = await db
      .from('payments').select('provider_order_id').eq('booking_id', offer!.id).single()
    const fixture = capturedEvent({ orderId: payment!.provider_order_id, amountPaise: offer!.total_paise })
    await processWebhookEvent({
      providerEventId: fixture.eventId,
      eventType: fixture.eventType,
      payload: fixture.payload,
    })

    const { data: after } = await db.from('bookings').select('status').eq('id', offer!.id).single()
    expect(after!.status).toBe('confirmed')
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', offer!.id)
    expect(count).toBe(1)

    await db
      .from('provider_webhook_events')
      .delete()
      .eq('provider', 'razorpay')
      .eq('provider_event_id', fixture.eventId)
  })
})
```

- [ ] **Step 5: Green, then commit**

```bash
npx vitest run lib/bookings/waitlist-service.test.ts lib/payments/waitlist-offer-checkout.test.ts
npm test
git add lib/bookings/service.ts lib/bookings/waitlist-service.test.ts \
        lib/payments/waitlist-offer-checkout.test.ts
git commit -m "feat: join the line, claim the seat, and know where you stand"
```

---

### Task 5: The reads — the host's line, the stranger's count, the widened columns

**Files:**
- Modify: `lib/bookings/queries.ts`
- Modify: `lib/events/queries.ts`
- Create: `lib/bookings/waitlist-queries.test.ts`

**Interfaces:**
- Consumes: `signedInClient()` (`lib/bookings/queries.ts:66`), `createClient` (`lib/supabase/server`), `waitlist_length` (Task 1).
- Produces:
  - `interface WaitlistEntry { id, reference, attendee_name, quantity, payment_mode, created_at, profiles: { phone } | null }` and `listEventWaitlist(eventId: string): Promise<WaitlistEntry[]>` — `waitlisted` rows, oldest first, empty unless the caller hosts it. **Position is the array index + 1**, because the order is the promotion order; no per-row query.
  - `waitlistLength(ticketTypeId: string): Promise<number>` — works signed out.
  - `MyBooking.events` gains `has_waitlist: boolean` (and `requires_approval` is already absent — add it too; Task 8 branches on both).
  - `PublicEvent.has_waitlist` and `OwnedEvent.has_waitlist`.

- [ ] **Step 1: Write the failing tests**

`lib/bookings/waitlist-queries.test.ts`. Its own file, not appended to `approval-queries.test.ts` or `queries.test.ts` — both are order-dependent on their shared seeds:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

const { listEventWaitlist, waitlistLength, listMyBookings, listApprovedUnpaid } = await import(
  '@/lib/bookings/queries'
)

const db = adminClient()

let seed: SeededEvent
let filler = ''
let second = ''
let stranger = ''
let firstRef = ''
let secondRef = ''

async function phoneOf(userId: string): Promise<string> {
  const { data } = await db.from('profiles').select('phone').eq('id', userId).single()
  return data!.phone
}

beforeAll(async () => {
  seed = await seedEvent(db, {
    quantity: 1,
    pricePaise: 50_000,
    allowsCash: true,
    hasWaitlist: true,
    maxPerOrder: 3,
  })

  filler = await createTestUser(db)
  const booked = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: filler,
    p_quantity: 1,
    p_attendee_name: 'Filler',
  })
  if (booked.error) throw new Error(`setup fill failed: ${booked.error.message}`)

  // Two in line, in this order — "oldest first" is only an assertion when
  // there is a second row to come after the first.
  const first = await db.rpc('join_waitlist', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: 2,
    p_attendee_name: 'Asha',
    p_payment_mode: 'online',
  })
  if (first.error) throw new Error(`setup first join failed: ${first.error.message}`)
  firstRef = first.data!.reference

  second = await createTestUser(db)
  const next = await db.rpc('join_waitlist', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: second,
    p_quantity: 1,
    p_attendee_name: 'Bala',
    p_payment_mode: 'cash',
  })
  if (next.error) throw new Error(`setup second join failed: ${next.error.message}`)
  secondRef = next.data!.reference

  stranger = await createTestUser(db)
})

afterAll(async () => {
  await db.from('bookings').delete().eq('event_id', seed.eventId)
  await cleanupEvent(db, seed)
  for (const id of [filler, second, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('listEventWaitlist', () => {
  it('gives the host the line in promotion order, with seats, mode and phone', async () => {
    signInAs(seed.hostProfileId)
    const line = await listEventWaitlist(seed.eventId)

    // The order IS the position: index 0 is who gets the next seat that fits.
    expect(line.map((e) => e.reference)).toEqual([firstRef, secondRef])
    expect(line[0].attendee_name).toBe('Asha')
    expect(line[0].quantity).toBe(2)
    expect(line[0].payment_mode).toBe('online')
    expect(line[0].profiles?.phone).toBe(await phoneOf(seed.attendeeId))
    expect(line[1].payment_mode).toBe('cash')
  })

  it('shows a stranger nothing, and a person in the line nothing', async () => {
    signInAs(stranger)
    expect(await listEventWaitlist(seed.eventId)).toHaveLength(0)
    // bookings_select_own matches this caller's own entry, so without the
    // hosts !inner hop this would be a one-row "line" handed to a guest.
    signInAs(seed.attendeeId)
    expect(await listEventWaitlist(seed.eventId)).toHaveLength(0)
  })

  it('shows nothing when signed out', async () => {
    signInAs(null)
    expect(await listEventWaitlist(seed.eventId)).toHaveLength(0)
  })

  it('does not confuse the line with the approved-unpaid strip', async () => {
    // A waitlisted row is not awaiting_payment, so the strip stays empty until
    // somebody is actually offered a seat.
    signInAs(seed.hostProfileId)
    expect(await listApprovedUnpaid(seed.eventId)).toHaveLength(0)
  })
})

describe('waitlistLength', () => {
  it('counts the line for a signed-out stranger', async () => {
    // The public event page's whole gate depends on this working with no
    // session at all: `bookings` is granted to `authenticated` alone, so a
    // direct read here would answer 42501 rather than a number.
    signInAs(null)
    expect(await waitlistLength(seed.ticketTypeId)).toBe(2)
  })

  it('is zero for a ticket type nobody is waiting on', async () => {
    const quiet = await seedEvent(db, { quantity: 5, pricePaise: 50_000, hasWaitlist: true })
    signInAs(null)
    expect(await waitlistLength(quiet.ticketTypeId)).toBe(0)
    await cleanupEvent(db, quiet)
  })
})

describe('the widened booking columns', () => {
  it('carries the event flags a waitlisted booking needs to describe itself', async () => {
    signInAs(seed.attendeeId)
    const [booking] = await listMyBookings()

    expect(booking.reference).toBe(firstRef)
    expect(booking.status).toBe('waitlisted')
    expect(booking.quantity).toBe(2)
    // Both flags, because the booking page picks its sentence from the pair:
    // approved_at on a has_waitlist event is an offer, on a requires_approval
    // event it is an approval. An unselected column reads undefined and would
    // silently choose the wrong branch.
    expect(booking.events?.has_waitlist).toBe(true)
    expect(booking.events?.requires_approval).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/bookings/waitlist-queries.test.ts
```

- [ ] **Step 3: Widen the columns and add the two reads**

`lib/bookings/queries.ts` — `BOOKING_COLUMNS`, in the embedded `events(...)` list, after `hide_venue_until_approved`:

```ts
const BOOKING_COLUMNS =
  'id, reference, quantity, status, created_at, total_paise, hold_expires_at, attendee_id, attendee_name, attendee_note, payment_mode, approved_at, cancellation_reason, events(id, slug, title, starts_at, city, venue_name, venue_address, hide_venue_until_approved, requires_approval, has_waitlist, refund_cutoff_hours), payments(provider_order_id, status)'
```

and on `MyBooking['events']`:

```ts
    hide_venue_until_approved: boolean
    /** The pair that says which queue this booking came from — and therefore
     *  which sentence an approved_at row deserves. See app/bookings/[reference]. */
    requires_approval: boolean
    has_waitlist: boolean
    refund_cutoff_hours: number
```

Then append the two reads:

```ts
export interface WaitlistEntry {
  id: string
  reference: string
  attendee_name: string | null
  quantity: number
  payment_mode: string
  created_at: string
  profiles: { phone: string } | null
}

/**
 * The line for one event, in the order it will be served. Empty unless the
 * caller hosts it, by the same !inner scoping as the guest list and the
 * request queue.
 *
 * No position column and no per-row query: this order IS the position, because
 * it is the same `created_at, id` ordering promote_from_waitlist promotes by.
 * The page numbers the rows from the array index, which cannot disagree with
 * the engine the way a separately-computed number could.
 */
export async function listEventWaitlist(eventId: string): Promise<WaitlistEntry[]> {
  const session = await signedInClient()
  if (!session) return []

  const { data, error } = await session.supabase
    .from('bookings')
    .select(
      'id, reference, attendee_name, quantity, payment_mode, created_at, profiles(phone), events!inner(hosts!inner(profile_id))',
    )
    .eq('event_id', eventId)
    .eq('events.hosts.profile_id', session.userId)
    .eq('status', 'waitlisted')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })

  if (error) throw new Error(`Could not load the waitlist: ${error.message}`)
  return (data ?? []) as unknown as WaitlistEntry[]
}

/**
 * How many people are in line for one ticket type. Works signed out, which is
 * the whole reason it is an RPC.
 *
 * The one read in this file that does NOT go through signedInClient(), and the
 * exception is deliberate rather than an oversight: every other read here
 * touches `bookings`, which is granted to `authenticated` alone
 * (20260808000003:212), so a signed-out caller gets 42501 rather than an empty
 * list. waitlist_length is SECURITY DEFINER and granted to `anon` precisely so
 * the public event page — served to strangers, and gated on this number — can
 * ask. What crosses the boundary is one integer with no identity in it, which
 * that page then prints to the same stranger.
 *
 * Throws rather than returning 0 on error, for the reason the module comment
 * gives at length: a swallowed failure here would put the page back into
 * "book now" mode with a full line behind it, which is the exact silent-empty
 * shape this file is written against.
 */
export async function waitlistLength(ticketTypeId: string): Promise<number> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('waitlist_length', { p_ticket_type_id: ticketTypeId })
  if (error) throw new Error(`Could not read the waitlist: ${error.message}`)
  return data ?? 0
}
```

`lib/events/queries.ts` — three edits, none of them optional:

```ts
// PublicEvent (~line 280)
  requires_approval: boolean
  allows_cash: boolean
  has_waitlist: boolean

// getPublishedEventBySlug's select (~line 295)
       requires_approval, allows_cash, has_waitlist, refund_cutoff_hours,
       hosts(display_name, bio, avatar_url)

// OwnedEvent (~line 345)
  requires_approval: boolean
  allows_cash: boolean
  has_waitlist: boolean

// getOwnedEvent's select (~line 367)
       description, venue_name, venue_address, ends_at, requires_approval, allows_cash,
       has_waitlist, refund_cutoff_hours, hide_venue_until_approved, hosts(display_name),
```

- [ ] **Step 4: Green, then commit**

```bash
npx vitest run lib/bookings/waitlist-queries.test.ts
npm test
git add lib/bookings/queries.ts lib/events/queries.ts lib/bookings/waitlist-queries.test.ts
git commit -m "feat: the host reads the line, a stranger reads its length"
```

---

### Task 6: The toggle — "Keep a waitlist when it sells out"

**Files:**
- Modify: `lib/events/validation.ts`
- Modify: `app/host/events/actions.ts`
- Modify: `app/host/events/event-form.tsx`
- Modify: `app/host/events/[id]/edit/page.tsx`
- Modify: `lib/bookings/service.ts`
- Test: extend `lib/events/validation.test.ts`
- Create: `lib/events/waitlist-toggle.test.ts`
- Create: `lib/bookings/capacity-promote.test.ts`

**Interfaces:**
- Consumes: `EVENT_FORM_FIELDS` and `eventDraftSchema` (`lib/events/validation.ts:118-166`), the widened `create_event_with_ticket_type` / `update_event_with_ticket_type` (Task 1), `OwnedEvent.has_waitlist` (Task 5), `mayApprove` (`lib/bookings/authorize.ts:38`), `createAdminClient`, `Caller`.
- Produces: `EventDraftInput.hasWaitlist: boolean`; `SubmittedEventValues.hasWaitlist: boolean` (free — it is derived from `EVENT_FORM_FIELDS`); `EventFormValues.hasWaitlist?: boolean`; `promoteAfterCapacityChange(caller: Caller, eventId: string): Promise<void>`.

`EVENT_FORM_FIELDS` carries `satisfies Record<keyof EventDraftInput, FieldKind>`, so adding `hasWaitlist` to the schema without adding it to that map is a compile error, and the echo cannot silently drop it. That is the mechanism; do not work around it.

- [ ] **Step 1: Write the failing tests**

Append to `lib/events/validation.test.ts` (parse-level, no database):

```ts
describe('the waitlist toggle', () => {
  it('defaults to false when the box is absent', () => {
    const result = parseEventForm(form({}))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.hasWaitlist).toBe(false)
  })

  it('is true when the box is checked', () => {
    const result = parseEventForm(form({ hasWaitlist: 'on' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.hasWaitlist).toBe(true)
  })

  it('survives a rejected save in the echo', () => {
    // The echo is what a host gets back when the save is refused; a checkbox
    // missing from it comes back unticked and the host loses the choice
    // silently. EVENT_FORM_FIELDS is what stops that, so assert it.
    const values = readSubmittedValues(form({ hasWaitlist: 'on', title: 'x' }))
    expect(values.hasWaitlist).toBe(true)
  })
})
```

`lib/events/waitlist-toggle.test.ts` — the writers, against the real database. Its own file rather than `lib/events/atomicity.test.ts`, which owns its seeds:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, createTestUser } from '@/tests/helpers/db'

const db = adminClient()

let hostProfileId = ''
let hostId = ''
const created: string[] = []

beforeAll(async () => {
  hostProfileId = await createTestUser(db)
  const { data, error } = await db
    .from('hosts')
    .insert({ profile_id: hostProfileId, display_name: 'Toggle Host' })
    .select()
    .single()
  if (error) throw new Error(`seed host failed: ${error.message}`)
  hostId = data.id
})

afterAll(async () => {
  for (const id of created) {
    await db.from('ticket_types').delete().eq('event_id', id)
    await db.from('events').delete().eq('id', id)
  }
  await db.from('hosts').delete().eq('id', hostId)
  await db.auth.admin.deleteUser(hostProfileId).catch(() => {})
})

/** The writer's full argument list, with only the two toggles varying. */
async function create(requiresApproval: boolean, hasWaitlist: boolean) {
  const { data, error } = await db.rpc('create_event_with_ticket_type', {
    p_host_id: hostId,
    p_slug: `toggle-${crypto.randomUUID().slice(0, 8)}`,
    p_title: 'Toggle Supper Club',
    p_description: null,
    p_city: 'Indore',
    p_venue_name: 'Somewhere',
    p_venue_address: null,
    p_cover_image_url: null,
    p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    p_ends_at: null,
    p_requires_approval: requiresApproval,
    p_allows_cash: false,
    p_hide_venue_until_approved: false,
    p_price_paise: 50_000,
    p_quantity: 10,
    p_refund_cutoff_hours: 24,
    p_has_waitlist: hasWaitlist,
  })
  if (error) throw new Error(`create failed: ${error.message}`)
  created.push(data!.id)
  return data!
}

describe('the event writers and the waitlist toggle', () => {
  it('stores the toggle on an instant-book event', async () => {
    const event = await create(false, true)
    expect(event.has_waitlist).toBe(true)
    expect(event.requires_approval).toBe(false)
  })

  it('coerces rather than raises when both queues are asked for', async () => {
    // A host who ticks approval gets their intent honoured. The alternative —
    // letting events_one_queue fire — hands them a constraint name for a
    // combination the form does not even offer.
    const event = await create(true, true)
    expect(event.requires_approval).toBe(true)
    expect(event.has_waitlist).toBe(false)
  })

  it('turns the waitlist off when an event switches to approvals', async () => {
    const event = await create(false, true)
    const { data, error } = await db.rpc('update_event_with_ticket_type', {
      p_event_id: event.id,
      p_title: event.title,
      p_description: null,
      p_city: 'Indore',
      p_venue_name: 'Somewhere',
      p_venue_address: null,
      p_cover_image_url: null,
      p_starts_at: event.starts_at,
      p_ends_at: null,
      p_requires_approval: true,
      p_allows_cash: false,
      p_hide_venue_until_approved: false,
      p_price_paise: 50_000,
      p_quantity: 10,
      p_refund_cutoff_hours: 24,
      p_has_waitlist: true,
    })
    // service_role has no current_host_id(), so the ownership guard refuses it
    // — which is the defence in depth 20260809000001 documents, and is why
    // this assertion is about the refusal, not the row.
    expect(error?.code).toBe('EH002')
    expect(data).toBeNull()
  })
})
```

> If the third case's `EH002` expectation is wrong on this database — check by running it before writing the implementation — delete that case rather than weakening the guard: the coercion on update is the same expression as on create, already covered, and `update_event_with_ticket_type` is deliberately unreachable to the service role.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/events/validation.test.ts lib/events/waitlist-toggle.test.ts
```

- [ ] **Step 3: Schema and field map**

`lib/events/validation.ts` — in `eventDraftSchema`, beside its two siblings:

```ts
    requiresApproval: z.boolean(),
    allowsCash: z.boolean(),
    hasWaitlist: z.boolean(),
    hideVenueUntilApproved: z.boolean(),
```

and in `EVENT_FORM_FIELDS`:

```ts
  requiresApproval: 'checkbox',
  allowsCash: 'checkbox',
  hasWaitlist: 'checkbox',
  hideVenueUntilApproved: 'checkbox',
```

- [ ] **Step 4: Pass it through both writers**

`app/host/events/actions.ts` — one line in each RPC call, beside `p_refund_cutoff_hours`:

```ts
    p_has_waitlist: input.hasWaitlist,
```

Passed raw. The exclusivity is the function's job (`p_has_waitlist and not p_requires_approval`), written once in SQL where both writers share it, rather than twice here where the two could drift.

- [ ] **Step 5: The form**

`app/host/events/event-form.tsx`. First, `EventFormValues` and `CheckboxState` each gain the field:

```ts
  requiresApproval?: boolean
  allowsCash?: boolean
  hasWaitlist?: boolean
  hideVenueUntilApproved?: boolean
```

```ts
interface CheckboxState {
  requiresApproval: boolean
  allowsCash: boolean
  hasWaitlist: boolean
  hideVenueUntilApproved: boolean
}
```

and both branches of the `checkboxes` expression gain `hasWaitlist: lastEcho.hasWaitlist` / `hasWaitlist: values.hasWaitlist ?? false`.

Then the two queue toggles move into a sub-component, above the main component:

```tsx
/**
 * The two queue toggles, together, because they are exclusive: an approval
 * event's request queue already keeps unlimited demand, so a waitlist beside
 * it would put two lists on one attendees page. events_one_queue refuses the
 * combination in the database and the writers coerce it; this is where the
 * host simply never meets it.
 *
 * A component rather than a `useState` in the form body, because the
 * checkboxes here are uncontrolled on purpose (see the essay on `checkboxes`
 * below) and the visibility state has to reset exactly when they do. Giving
 * this one `key={generation}` remounts the state and the two inputs together;
 * a bare state in the parent would survive the remount and leave the waitlist
 * row hidden after an echo that unticked approval.
 *
 * Unmounting the waitlist input rather than disabling it is the point: an
 * absent checkbox is absent from FormData, which readSubmittedValues reads as
 * false — so ticking approval turns the waitlist off through the same path the
 * SQL coerces, and the two cannot disagree.
 */
function QueueOptions({
  defaultRequiresApproval,
  defaultHasWaitlist,
}: {
  defaultRequiresApproval: boolean
  defaultHasWaitlist: boolean
}) {
  const [approvalOn, setApprovalOn] = useState(defaultRequiresApproval)

  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="requiresApproval"
          defaultChecked={defaultRequiresApproval}
          onChange={(event) => setApprovalOn(event.currentTarget.checked)}
        />
        I approve each guest before they pay
      </label>
      {!approvalOn && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="hasWaitlist" defaultChecked={defaultHasWaitlist} />
          Keep a waitlist when it sells out
        </label>
      )}
    </>
  )
}
```

In the `<fieldset>`, the standalone `requiresApproval` label is replaced by:

```tsx
        <QueueOptions
          key={generation}
          defaultRequiresApproval={checkboxes.requiresApproval}
          defaultHasWaitlist={checkboxes.hasWaitlist}
        />
```

The `allowsCash` and `hideVenueUntilApproved` labels below it are untouched, keys and all.

- [ ] **Step 6: The edit page seeds it**

`app/host/events/[id]/edit/page.tsx`, in `values`:

```tsx
          requiresApproval: event.requires_approval,
          allowsCash: event.allows_cash,
          hasWaitlist: event.has_waitlist,
          hideVenueUntilApproved: event.hide_venue_until_approved,
```

- [ ] **Step 7: Serve the line after a capacity raise**

A host who adds seats to a sold-out event that already has a line must have those seats reach the line, and nothing in the phase so far makes that happen. `cancel_booking` needs a booking; `release_expired_holds` promotes only what it itself reclaimed; and the `promote_from_waitlist` call inside `reserve_tickets` cannot do it — PostgREST runs one transaction per RPC, so when the promotion consumes the new seat and `reserve_tickets` then raises "only 0 seats remain", the raise rolls back the promotion that caused it. That call is worth keeping for the guarantee it *does* deliver (a walk-up can never take a seat the line is owed, and the line is served whenever the reservation itself succeeds), but the productive trigger has to live somewhere that commits.

The host's own Server Action is that place. Two transactions: the capacity raise commits first, so the promote sees the new seats; a failed promote leaves the raise standing and the next cancel or expiry serves the line.

Rejected: granting `promote_from_waitlist` to `authenticated` so `update_event_with_ticket_type` could call it — that function is SECURITY INVOKER precisely so RLS still applies to it, and the grant would put a function that writes inventory and bookings within reach of a crafted PostgREST call. Also rejected: an `AFTER UPDATE` trigger on `ticket_types` — tightest of the three, but it hides a booking mutation behind a column write in a codebase whose stated rule is that every `reserved_count` mutation lives in one file.

First the test, `lib/bookings/capacity-promote.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import { joinWaitlist, promoteAfterCapacityChange } from '@/lib/bookings/service'

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

describe('promoteAfterCapacityChange', () => {
  let seed: SeededEvent
  let filler = ''
  let stranger = ''

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, hasWaitlist: true })
    // Sell the only seat, so the room is genuinely full and Asha may join.
    filler = await createTestUser(db)
    const booked = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: filler,
      p_quantity: 1,
      p_attendee_name: 'Filler',
    })
    if (booked.error) throw new Error(`setup fill failed: ${booked.error.message}`)
    await db.rpc('confirm_booking', { p_booking_id: booked.data!.id })
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    stranger = await createTestUser(db)
  })

  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler, stranger]) await db.auth.admin.deleteUser(id).catch(() => {})
  })

  async function statusOfAsha(): Promise<string> {
    const { data } = await db.from('bookings').select('status').eq('attendee_id', seed.attendeeId).single()
    return data!.status
  }

  it('does nothing for anyone but the host', async () => {
    // The seats exist by now only if this refuses — so raise capacity first
    // and prove a stranger's call leaves the line where it is.
    await db.from('ticket_types').update({ quantity: 2 }).eq('id', seed.ticketTypeId)
    await promoteAfterCapacityChange(asCaller(stranger), seed.eventId)
    expect(await statusOfAsha()).toBe('waitlisted')
    await promoteAfterCapacityChange(asCaller(seed.attendeeId), seed.eventId)
    expect(await statusOfAsha()).toBe('waitlisted')
  })

  it('serves the line when the host adds a seat', async () => {
    await promoteAfterCapacityChange(asCaller(seed.hostProfileId), seed.eventId)
    expect(await statusOfAsha()).toBe('awaiting_payment')
    const { data } = await db.from('ticket_types').select('reserved_count').eq('id', seed.ticketTypeId).single()
    expect(data!.reserved_count).toBe(2)
  })

  it('never throws on an event that cannot be found', async () => {
    // A save must not fail because the promote did. Same reasoning as
    // refundIfOwed: the seat is the important part, and the sweep catches up.
    await expect(
      promoteAfterCapacityChange(asCaller(seed.hostProfileId), '00000000-0000-4000-8000-00000000dead'),
    ).resolves.toBeUndefined()
  })
})
```

Then the service function, appended to `lib/bookings/service.ts`:

```ts
/**
 * Offers newly-added seats to the line, after the host's save has committed.
 *
 * The one seat-appearing path the SQL seams cannot cover. cancel_booking needs
 * a booking and release_expired_holds promotes only what it reclaimed, so a
 * capacity raise frees seats through neither — and reserve_tickets' own
 * promote call cannot do it either, because one PostgREST transaction per RPC
 * means its "only 0 seats remain" raise unwinds the promotion that produced
 * it. Hence a second, committing call from here.
 *
 * Never throws. A failed promote must not turn a successful save into an
 * error the host has to interpret — the seats are added either way, and the
 * next cancel or hold expiry serves the line. Same posture as refundIfOwed.
 *
 * Host-only, and the check is real rather than ceremonial: this is reached
 * from a Server Action carrying an eventId out of a form.
 */
export async function promoteAfterCapacityChange(caller: Caller, eventId: string): Promise<void> {
  try {
    const db = createAdminClient()

    const { data: event, error } = await db
      .from('events')
      .select('id, has_waitlist, hosts(profile_id), ticket_types(id)')
      .eq('id', eventId)
      .maybeSingle()

    if (error) {
      console.error('[bookings] could not read the event to serve its waitlist', error)
      return
    }
    // No event, no waitlist, or not this caller's to touch — all silent, all
    // the same nothing. promote_from_waitlist would refuse the middle one
    // anyway; checking here saves a round trip per ticket type.
    if (!event || !event.has_waitlist) return
    if (!mayApprove(caller, { event_host_profile_id: event.hosts.profile_id })) return

    for (const ticketType of event.ticket_types) {
      const { error: promoteError } = await db.rpc('promote_from_waitlist', {
        p_ticket_type_id: ticketType.id,
      })
      if (promoteError) {
        console.error('[bookings] could not serve the waitlist after a capacity change', promoteError)
      }
    }
  } catch (cause) {
    console.error('[bookings] serving the waitlist after a capacity change threw', cause)
  }
}
```

Finally the call site. `app/host/events/actions.ts`, in `updateEvent`, immediately after the `if (error) return …` guard on the `update_event_with_ticket_type` call and before the host-rename block:

```ts
  // The save has committed, so any seats it added are real and visible. Only
  // now can the line be served — see promoteAfterCapacityChange for why this
  // cannot ride inside the writer's own transaction. Never throws, so a
  // waitlist problem cannot fail a save that already succeeded.
  await promoteAfterCapacityChange(caller, eventId)
```

`updateEvent` works from an RLS-scoped Supabase client rather than a `Caller`, so mint one at the top of the action beside the existing `getCurrentHost()` call:

```ts
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())
```

with `currentCaller` imported from `@/lib/bookings/caller`. Do not pass `auth.user.id` or `host.profile_id` in its place — `Caller` is branded so that identity cannot be conjured from a string, and this call site is no exception.

- [ ] **Step 8: Green, then commit**

```bash
npx vitest run lib/events/validation.test.ts lib/events/waitlist-toggle.test.ts \
               lib/bookings/capacity-promote.test.ts
npm test
npm run typecheck   # EVENT_FORM_FIELDS' `satisfies` is only enforced here
git add lib/events/validation.ts app/host/events/actions.ts app/host/events/event-form.tsx \
        "app/host/events/[id]/edit/page.tsx" lib/bookings/service.ts \
        lib/events/validation.test.ts lib/events/waitlist-toggle.test.ts \
        lib/bookings/capacity-promote.test.ts
git commit -m "feat: the host opts into a waitlist, and adding seats serves the line"
```

---

### Task 7: The public event page — the door that stops refusing people

**Files:**
- Create: `app/e/[slug]/join-waitlist-panel.tsx`
- Modify: `app/e/[slug]/actions.ts`
- Modify: `app/e/[slug]/page.tsx`
- Create: `app/e/[slug]/join-waitlist.test.ts`

**Interfaces:**
- Consumes: `joinWaitlist` (Task 4), `waitlistLength` (Task 5), `PublicEvent.has_waitlist` (Task 5), `waitlistPriceLine` / `lineLengthLine` (Task 3), `BookState` (`app/e/[slug]/actions.ts:10`), `currentCaller`, `loginPath`.
- Produces: `joinTheWaitlist(previous: BookState, formData: FormData): Promise<BookState>`; `<JoinWaitlistPanel ticketTypeId slug maxSeats priceLine lineLine offerCash />`.

- [ ] **Step 1: Write the failing action test**

`app/e/[slug]/join-waitlist.test.ts`. Every seam is mocked — what is under test is what a handcrafted POST can make this action do, not what the database does with it (Task 4 owns that):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
// Side effect only: runs dotenv so lib/env.ts can validate when the action's
// import chain pulls in the Supabase client.
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`)
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/e/test-event' }),
}))

let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

vi.mock('@/lib/bookings/service', () => ({
  joinWaitlist: vi.fn(),
  bookFreeTickets: vi.fn(),
  bookCashTickets: vi.fn(),
  requestBooking: vi.fn(),
}))
vi.mock('@/lib/payments/service', () => ({ startPaidCheckout: vi.fn() }))

const { joinWaitlist } = vi.mocked(await import('@/lib/bookings/service'))
const { joinTheWaitlist } = await import('@/app/e/[slug]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const RELOAD_SENTENCE = 'Something went wrong. Reload the page and try again.'

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.set('ticketTypeId', 'tt-1')
  fd.set('slug', 'test-event')
  fd.set('quantity', '2')
  fd.set('attendeeName', 'Asha')
  fd.set('paymentMode', 'online')
  for (const [key, value] of Object.entries(overrides)) fd.set(key, value)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as unknown as Caller
  joinWaitlist.mockResolvedValue({ ok: true, reference: 'VYRB4SHQ' })
})

describe('joinTheWaitlist', () => {
  it('sends the caller to sign in rather than joining as nobody', async () => {
    caller = null
    await expect(joinTheWaitlist({}, form())).rejects.toBeInstanceOf(RedirectSignal)
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it('joins as the caller and lands on the new entry', async () => {
    await expect(joinTheWaitlist({}, form())).rejects.toMatchObject({ to: '/bookings/VYRB4SHQ' })
    expect(joinWaitlist).toHaveBeenCalledWith(
      { id: CALLER_ID },
      'tt-1',
      2,
      'Asha',
      'online',
    )
  })

  it('repaints the event page, whose line just got longer', async () => {
    // Joining moves no inventory, so unlike bookEvent there is no feed number
    // to correct — but this page prints "N people waiting" and gates its whole
    // bottom bar on that number, so it must not be served stale.
    await expect(joinTheWaitlist({}, form())).rejects.toBeInstanceOf(RedirectSignal)
    expect(revalidatePath).toHaveBeenCalledWith('/e/test-event')
  })

  it('refuses a quantity that is not a whole number of seats', async () => {
    for (const bad of ['0', '-1', 'two', '1.5', '']) {
      expect(await joinTheWaitlist({}, form({ quantity: bad }))).toEqual({
        error: 'Choose how many seats you need.',
      })
    }
    expect(joinWaitlist).not.toHaveBeenCalled()
  })

  it('insists on a name for the door list', async () => {
    expect(await joinTheWaitlist({}, form({ attendeeName: '   ' }))).toEqual({
      error: 'Tell the host who to expect.',
    })
  })

  it('caps the name at 80 characters, as the input does and a POST does not', async () => {
    await expect(joinTheWaitlist({}, form({ attendeeName: 'a'.repeat(200) }))).rejects.toBeInstanceOf(
      RedirectSignal,
    )
    expect(joinWaitlist).toHaveBeenCalledWith({ id: CALLER_ID }, 'tt-1', 2, 'a'.repeat(80), 'online')
  })

  it('knows only two payment modes, whatever the form says', async () => {
    await expect(joinTheWaitlist({}, form({ paymentMode: 'barter' }))).rejects.toBeInstanceOf(
      RedirectSignal,
    )
    expect(joinWaitlist).toHaveBeenCalledWith({ id: CALLER_ID }, 'tt-1', 2, 'Asha', 'online')
  })

  it('stops without a ticket type', async () => {
    const fd = form()
    fd.delete('ticketTypeId')
    expect(await joinTheWaitlist({}, fd)).toEqual({ error: RELOAD_SENTENCE })
  })

  it('hands the service’s refusal back as it is', async () => {
    joinWaitlist.mockResolvedValue({ ok: false, error: 'Seats are open — book instead of joining the waitlist.' })
    expect(await joinTheWaitlist({}, form())).toEqual({
      error: 'Seats are open — book instead of joining the waitlist.',
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run "app/e/[slug]/join-waitlist.test.ts"
```

- [ ] **Step 3: The action**

`app/e/[slug]/actions.ts` — `joinWaitlist` joins the existing service import; the action goes below `requestToJoin`:

```ts
/**
 * Joins the line on a sold-out instant-book event.
 *
 * requestToJoin's shape minus the note: the host is not vetting anyone here,
 * so there is nothing to pitch. The three field reads are that action's,
 * character for character — the two must refuse the same mistake with the same
 * sentence — and why each looks the way it does is documented once, over
 * bookEvent.
 */
export async function joinTheWaitlist(
  _previous: BookState,
  formData: FormData,
): Promise<BookState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const ticketTypeId = String(formData.get('ticketTypeId') ?? '')
  if (!ticketTypeId) return { error: 'Something went wrong. Reload the page and try again.' }

  const quantity = Number(formData.get('quantity'))
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'Choose how many seats you need.' }
  }

  const attendeeName = String(formData.get('attendeeName') ?? '').trim().slice(0, 80)
  if (!attendeeName) return { error: 'Tell the host who to expect.' }

  // A two-value parse: anything that is not the literal 'cash' is online, so a
  // handcrafted POST cannot invent a third mode.
  const paymentMode = formData.get('paymentMode') === 'cash' ? ('cash' as const) : ('online' as const)

  const result = await joinWaitlist(caller, ticketTypeId, quantity, attendeeName, paymentMode)
  if (!result.ok) return { error: result.error }

  // No inventory moved, so the feed's payload is untouched and '/' is not
  // revalidated — unlike bookEvent. This page is another matter: it prints the
  // line's length and decides its entire bottom bar on it, so it must not be
  // served from before this person joined.
  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`)
  redirect(`/bookings/${result.reference}`)
}
```

- [ ] **Step 4: The panel**

`app/e/[slug]/join-waitlist-panel.tsx` — `RequestPanel`'s shape without the note field:

```tsx
'use client'

import { useActionState, useState } from 'react'
import { joinTheWaitlist, type BookState } from './actions'

interface Props {
  ticketTypeId: string
  slug: string
  /** min(max_per_order, quantity) — NOT seats remaining. There are none; that
   *  is why this panel is mounted. */
  maxSeats: number
  /** "₹500 — you pay only if a seat opens for you". */
  priceLine: string
  /** "3 people waiting" — the number that decides whether joining is worth it. */
  lineLine: string
  /** Offer the online/cash choice — allows_cash events with a price. */
  offerCash: boolean
}

/**
 * The bottom bar on a sold-out event that keeps a line. Where "Sold out" used
 * to sit inert, this asks for a name and a seat count and nothing else — no
 * payment, no hold, no note. The money question is answered now only because
 * the offer, when it comes, has to know which door to open.
 */
export function JoinWaitlistPanel({
  ticketTypeId,
  slug,
  maxSeats,
  priceLine,
  lineLine,
  offerCash,
}: Props) {
  const [state, action, pending] = useActionState<BookState, FormData>(joinTheWaitlist, {})
  const [mode, setMode] = useState<'online' | 'cash'>('online')

  return (
    <form action={action} className="mx-auto max-w-2xl space-y-2">
      <input type="hidden" name="ticketTypeId" value={ticketTypeId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="paymentMode" value={mode} />

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[19px] leading-tight font-semibold">{priceLine}</p>
          <p className="text-muted font-mono text-[12px]">{state.error ?? lineLine}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="sr-only" htmlFor="attendeeName">Your name</label>
          <input
            id="attendeeName"
            name="attendeeName"
            type="text"
            required
            maxLength={80}
            placeholder="Your name"
            disabled={pending}
            className="border-line w-28 rounded-lg border px-3 py-3 text-[15px]"
          />
          <label className="sr-only" htmlFor="quantity">Seats</label>
          <select
            id="quantity"
            name="quantity"
            defaultValue="1"
            disabled={pending}
            className="border-line rounded-lg border px-3 py-3 font-mono text-[15px]"
          >
            {Array.from({ length: maxSeats }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={pending}
            className="bg-ink text-paper rounded-lg px-5 py-3 text-[15px] font-medium disabled:opacity-60"
          >
            {pending ? 'Joining…' : 'Join the waitlist'}
          </button>
        </div>
      </div>

      {offerCash && (
        <fieldset className="flex gap-4 font-mono text-[12px]">
          <legend className="sr-only">How you&apos;ll pay if a seat opens</legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="paymentModeChoice"
              checked={mode === 'online'}
              onChange={() => setMode('online')}
              disabled={pending}
            />
            Pay online if a seat opens
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="paymentModeChoice"
              checked={mode === 'cash'}
              onChange={() => setMode('cash')}
              disabled={pending}
            />
            Cash at the door
          </label>
        </fieldset>
      )}
    </form>
  )
}
```

- [ ] **Step 5: The gate**

`app/e/[slug]/page.tsx`. New imports:

```ts
import { waitlistLength } from '@/lib/bookings/queries'
import { lineLengthLine, waitlistPriceLine } from '@/lib/bookings/waitlist-copy'
import { JoinWaitlistPanel } from './join-waitlist-panel'
```

Then, after `soldOut` and `started` are computed:

```ts
  // Only asked for on events that keep a line — one RPC, skipped entirely on
  // every other event, which is most of them. Signed-out safe by design; see
  // waitlistLength.
  const lineLength = ticket && event.has_waitlist ? await waitlistLength(ticket.id) : 0

  // The line holds the door. While anyone is waiting, this page stays in
  // join-waitlist mode even when a seat is free — because a seat that is free
  // right now is a seat somebody in the line is owed, and letting a walk-up
  // take it is the one thing that would make the queue not worth joining. SQL
  // enforces the same priority underneath (reserve_tickets promotes before it
  // sells); this is what stops a visitor being offered a button that is going
  // to refuse them.
  const joinable = !!ticket && !started && event.has_waitlist && (soldOut || lineLength > 0)
  // Capped at max_per_order rather than seats remaining, like the request
  // panel: there are no seats remaining, which is why this panel exists.
  const joinMax = ticket ? Math.max(1, Math.min(ticket.quantity, ticket.max_per_order ?? 10)) : 1
```

and `common` grows one clause — this is the line that actually closes the door on walk-ups:

```ts
  const common = !!ticket && !soldOut && !started && !event.requires_approval && !joinable
```

In the bottom bar, a branch between `requestable` and `bookableFree`. The two can never both be true — `events_one_queue` makes `requires_approval` and `has_waitlist` exclusive — so the order between them is readability, not precedence:

```tsx
        ) : joinable && ticket ? (
          <JoinWaitlistPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={joinMax}
            priceLine={waitlistPriceLine(
              ticket.price_paise === 0 ? null : formatPaise(ticket.price_paise),
            )}
            lineLine={lineLengthLine(lineLength)}
            offerCash={event.allows_cash && ticket.price_paise > 0}
          />
        ) : bookableFree && ticket ? (
```

- [ ] **Step 6: Green, then commit**

```bash
npx vitest run "app/e/[slug]/join-waitlist.test.ts"
npm test
npm run typecheck
git add "app/e/[slug]/join-waitlist-panel.tsx" "app/e/[slug]/actions.ts" \
        "app/e/[slug]/page.tsx" "app/e/[slug]/join-waitlist.test.ts"
git commit -m "feat: a sold-out event offers a place in the line instead of a closed door"
```

---

### Task 8: The attendee's surfaces — in line, offered, claimed, lapsed

**Files:**
- Modify: `app/bookings/[reference]/page.tsx`
- Modify: `app/bookings/[reference]/approved-pay-panel.tsx`
- Create: `app/bookings/[reference]/claim-seat-panel.tsx`
- Modify: `app/bookings/[reference]/actions.ts`
- Modify: `app/bookings/page.tsx`
- Create: `app/bookings/[reference]/claim-seat.test.ts`

**Interfaces:**
- Consumes: `claimOfferedSeat`, `waitlistPosition` (Task 4); the copy module (Task 3); `MyBooking.events.has_waitlist` / `.requires_approval` (Task 5); `CancelButton` (`app/bookings/cancel-button.tsx`), `currentCaller`, `formatIst`, `formatPaise`.
- Produces: `claimSeat(previous: ClaimState, formData: FormData): Promise<ClaimState>`; `<ClaimSeatPanel reference sentence />`; `<ApprovedPayPanel reference amountLabel sentence />` (the `deadlineLabel` prop is replaced — the panel no longer writes its own sentence).

- [ ] **Step 1: Write the failing action test**

`app/bookings/[reference]/claim-seat.test.ts` — the twin of `approved-pay.test.ts` in the same directory; read it first and keep its mock block identical:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))

class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`)
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/bookings/VYRB4SHQ' }),
}))

let caller: Caller | null = null
vi.mock('@/lib/bookings/caller', () => ({ currentCaller: async () => caller }))

vi.mock('@/lib/bookings/service', () => ({ claimOfferedSeat: vi.fn() }))
vi.mock('@/lib/payments/service', () => ({
  beginApprovedCheckout: vi.fn(),
  reconcileAfterCheckout: vi.fn(),
  reconcileBooking: vi.fn(),
}))
vi.mock('@/lib/bookings/queries', () => ({ getBookingByReference: vi.fn() }))

const { claimOfferedSeat } = vi.mocked(await import('@/lib/bookings/service'))
const { getBookingByReference } = vi.mocked(await import('@/lib/bookings/queries'))
const { claimSeat } = await import('@/app/bookings/[reference]/actions')

const CALLER_ID = '00000000-0000-4000-8000-000000000001'
const RELOAD_SENTENCE = 'Something went wrong. Reload the page and try again.'
const OFFER = { id: 'b-1', status: 'awaiting_payment' }

function form(reference = 'VYRB4SHQ'): FormData {
  const fd = new FormData()
  fd.set('reference', reference)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  caller = { id: CALLER_ID } as unknown as Caller
  getBookingByReference.mockResolvedValue(OFFER as never)
  claimOfferedSeat.mockResolvedValue({ ok: true })
})

describe('claimSeat', () => {
  it('sends a signed-out visitor to sign in rather than claiming as nobody', async () => {
    caller = null
    await expect(claimSeat({}, form())).rejects.toBeInstanceOf(RedirectSignal)
    expect(claimOfferedSeat).not.toHaveBeenCalled()
  })

  it('claims through the service, which owns the decision', async () => {
    expect(await claimSeat({}, form())).toEqual({})
    expect(claimOfferedSeat).toHaveBeenCalledWith({ id: CALLER_ID }, 'b-1')
  })

  it('repaints this booking and the list it appears on', async () => {
    await claimSeat({}, form())
    expect(revalidatePath).toHaveBeenCalledWith('/bookings/VYRB4SHQ')
    expect(revalidatePath).toHaveBeenCalledWith('/bookings')
  })

  it('refuses a reference that is not one', async () => {
    // Shape-checked because it is interpolated into a revalidate path, the
    // same rule the cancel actions follow for slugs and event ids.
    for (const bad of ['', 'short', 'VYRB4SHQX', 'vyrb4shq', '../../login', 'VYRB4SHI']) {
      expect(await claimSeat({}, form(bad))).toEqual({ error: RELOAD_SENTENCE })
    }
    expect(claimOfferedSeat).not.toHaveBeenCalled()
  })

  it('says nothing useful about a booking it cannot resolve', async () => {
    getBookingByReference.mockResolvedValue(null)
    expect(await claimSeat({}, form())).toEqual({ error: RELOAD_SENTENCE })
    expect(claimOfferedSeat).not.toHaveBeenCalled()
  })

  it('hands the service’s refusal back unchanged, and repaints nothing', async () => {
    claimOfferedSeat.mockResolvedValue({ ok: false, error: 'That seat offer is not yours to claim.' })
    expect(await claimSeat({}, form())).toEqual({ error: 'That seat offer is not yours to claim.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run "app/bookings/[reference]/claim-seat.test.ts"
```

- [ ] **Step 3: The claim action**

`app/bookings/[reference]/actions.ts` — add the import of `claimOfferedSeat` from `@/lib/bookings/service`, then below `startApprovedPayment`:

```ts
export interface ClaimState {
  error?: string
}

/**
 * The Claim tap on a free or cash seat offer — the twin of startApprovedPayment,
 * for the offers that have no online money to ask for.
 *
 * Same posture: the reference is shape-checked before it is used, the booking
 * is resolved through the RLS read, and the service re-checks that the caller
 * IS the attendee. getBookingByReference deliberately also resolves for the
 * event's host, and a host must not be able to accept a seat on a guest's
 * behalf — accepting is the guest's to do.
 */
export async function claimSeat(
  _previous: ClaimState,
  formData: FormData,
): Promise<ClaimState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const reference = String(formData.get('reference') ?? '')
  if (!REFERENCE_PATTERN.test(reference)) {
    return { error: 'Something went wrong. Reload the page and try again.' }
  }

  const booking = await getBookingByReference(reference)
  if (!booking) return { error: 'Something went wrong. Reload the page and try again.' }

  const result = await claimOfferedSeat(caller, booking.id)
  if (!result.ok) return { error: result.error }

  // The seat is confirmed and tickets exist, so this page owes a QR — and the
  // list owes a status that is no longer "in line".
  revalidatePath(`/bookings/${reference}`)
  revalidatePath('/bookings')
  return {}
}
```

- [ ] **Step 4: The two panels**

`app/bookings/[reference]/claim-seat-panel.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { claimSeat, type ClaimState } from './actions'

/**
 * "A seat opened up — claim it by <deadline>." One tap confirms; the server
 * re-render then swaps this panel for the tickets. Everything authoritative
 * happens server-side; this is a form with a sentence.
 *
 * The sentence arrives as a prop rather than being written here: it lives in
 * lib/bookings/waitlist-copy.ts with its three siblings, where a test can hold
 * it to its word.
 */
export function ClaimSeatPanel({ reference, sentence }: { reference: string; sentence: string }) {
  const [state, action, pending] = useActionState<ClaimState, FormData>(claimSeat, {})

  return (
    <section className="border-line mt-8 rounded-lg border p-4">
      <form action={action}>
        <input type="hidden" name="reference" value={reference} />
        <p className="text-sm">{sentence}</p>
        <button
          type="submit"
          disabled={pending}
          className="bg-ink text-paper mt-3 w-full rounded-lg px-5 py-3 text-[15px] font-medium disabled:opacity-60"
        >
          {pending ? 'Claiming…' : 'Claim your seat'}
        </button>
        {state.error && <p className="text-muted mt-2 text-center text-[13px]">{state.error}</p>}
      </form>
    </section>
  )
}
```

`app/bookings/[reference]/approved-pay-panel.tsx` — the sentence moves out. The whole component becomes:

```tsx
'use client'

import { useActionState } from 'react'
import { startApprovedPayment, type ApprovedPayState } from './actions'

/**
 * One tap creates the order; the server re-render then swaps this panel for
 * the checkout sheet. Everything authoritative happens server-side; this is a
 * form with a sentence.
 *
 * The sentence is a prop because there are two of them now — a host saying yes,
 * and a seat coming free off a waitlist — and they are the same machinery
 * underneath (awaiting_payment, approved_at, a 24-hour hold) telling a person
 * two different things. Both live in lib/bookings/waitlist-copy.ts.
 */
export function ApprovedPayPanel({
  reference,
  amountLabel,
  sentence,
}: {
  reference: string
  amountLabel: string
  sentence: string
}) {
  const [state, action, pending] = useActionState<ApprovedPayState, FormData>(startApprovedPayment, {})

  return (
    <section className="border-line mt-8 rounded-lg border p-4">
      <form action={action}>
        <input type="hidden" name="reference" value={reference} />
        <p className="text-sm">{sentence}</p>
        <button
          type="submit"
          disabled={pending}
          className="bg-ink text-paper mt-3 w-full rounded-lg px-5 py-3 text-[15px] font-medium disabled:opacity-60"
        >
          {pending ? 'Starting payment…' : `Pay ${amountLabel}`}
        </button>
        {state.error && <p className="text-muted mt-2 text-center text-[13px]">{state.error}</p>}
      </form>
    </section>
  )
}
```

- [ ] **Step 5: The booking page**

`app/bookings/[reference]/page.tsx`. New imports:

```ts
import { currentCaller } from '@/lib/bookings/caller'
import { waitlistPosition } from '@/lib/bookings/service'
import {
  approvedPaySentence,
  LAPSED_OFFER_SENTENCE,
  offerClaimSentence,
  offerPaySentence,
  waitlistPositionLine,
} from '@/lib/bookings/waitlist-copy'
import { CancelButton } from '../cancel-button'
import { ClaimSeatPanel } from './claim-seat-panel'
```

`STATUS_LINE` gains its entry — the map is exhaustive over `booking_status` on purpose, and a new enum value without a line here falls to the "never heard of it" fallback:

```ts
  pending_approval: 'Request sent — the host will review it',
  waitlisted: "You're in line",
```

After `isAttendee` is computed, the phase's four derived facts:

```ts
  // Which queue this booking came from decides what an approved_at row means.
  // The two flags are mutually exclusive (events_one_queue), so this is a
  // clean either/or rather than a precedence question.
  const isWaitlistEvent = !!event?.has_waitlist
  const isOffer = booking.status === 'awaiting_payment' && !!booking.approved_at && isWaitlistEvent
  const lapsedOffer = booking.status === 'expired' && !!booking.approved_at && isWaitlistEvent
  // An offer with nothing to pay online is claimed, not paid: cash settles at
  // the door and free settles nowhere. Never true on an approval event —
  // approve_booking confirms both of those straight through — but derived from
  // the booking rather than the event, so it stays right if that ever changes.
  const claimable = booking.payment_mode === 'cash' || booking.total_paise === 0

  // Where they stand in the line. currentCaller() rather than the `user`
  // above because waitlistPosition takes a Caller, which only that module can
  // mint; requireUser() has already established there is one.
  const caller = await currentCaller()
  const position =
    caller && booking.status === 'waitlisted' ? await waitlistPosition(caller, booking.id) : null
```

`statusLine` grows two arms:

```ts
  const statusLine =
    booking.status === 'cancelled' && booking.cancellation_reason === 'declined by host'
      ? "The host couldn't fit you in this time"
      : isOffer
        ? 'A seat opened up for you'
        : lapsedOffer
          ? 'Your seat offer expired'
          : (STATUS_LINE[booking.status] ?? `Booking ${booking.status}`)
```

Below the `pending_approval` note echo, the line's own block:

```tsx
      {booking.status === 'waitlisted' && (
        <section className="mt-6">
          {position !== null && (
            <p className="text-[15px]">{waitlistPositionLine(position, booking.quantity)}</p>
          )}
          <p className="text-muted mt-1 text-sm">
            Nothing is charged unless a seat opens for you. You&rsquo;ll have 24 hours to take it.
          </p>
          {isAttendee && (
            <CancelButton
              bookingId={booking.id}
              slug={event?.slug ?? ''}
              label="Leave the waitlist"
              /* No money moved and no seat was held, so there is no
                 consequence to state — cancelConsequence would return null for
                 this row anyway. */
              consequence={null}
            />
          )}
        </section>
      )}
```

> `CancelButton`'s action revalidates `/bookings` and `/e/[slug]`, not this path — and it does not need to. A Server Action re-renders the route it was called from, and every page here is dynamically rendered (`lib/supabase/server.ts` awaits `cookies()` on every query path), so this page repaints from the database on the same round trip.

The approved-pay block gains `!claimable` and hands over its sentence:

```tsx
      {booking.status === 'awaiting_payment' &&
        booking.approved_at &&
        isAttendee &&
        !claimable &&
        !payment &&
        holdLive &&
        keyId &&
        event && (
          <ApprovedPayPanel
            reference={booking.reference}
            amountLabel={formatPaise(booking.total_paise)}
            sentence={
              isWaitlistEvent
                ? offerPaySentence(
                    formatPaise(booking.total_paise),
                    formatIst(new Date(booking.hold_expires_at!)),
                  )
                : approvedPaySentence(
                    formatPaise(booking.total_paise),
                    formatIst(new Date(booking.hold_expires_at!)),
                  )
            }
          />
        )}
```

and the claim panel sits beside it. No `keyId` in its gate — there is no payment provider in this path at all, which is the whole reason it exists:

```tsx
      {isOffer && isAttendee && claimable && holdLive && (
        <ClaimSeatPanel
          reference={booking.reference}
          sentence={offerClaimSentence(
            formatIst(new Date(booking.hold_expires_at!)),
            booking.payment_mode === 'cash' ? formatPaise(booking.total_paise) : null,
          )}
        />
      )}

      {lapsedOffer && <p className="text-muted mt-6 text-sm">{LAPSED_OFFER_SENTENCE}</p>}
```

- [ ] **Step 6: The bookings list**

`app/bookings/page.tsx`. New imports (`currentCaller`, `waitlistPosition`, `waitlistShortPosition`), and after the bookings are loaded:

```tsx
  // One position per waitlisted row. Two round trips each, which is why it is
  // scoped to the rows that need it — a person has a handful of bookings, and
  // most of them are never in a line.
  const caller = await currentCaller()
  const waiting = bookings.filter((b) => b.status === 'waitlisted')
  const resolved = caller
    ? await Promise.all(waiting.map((b) => waitlistPosition(caller, b.id)))
    : []
  const positions = new Map<string, number>()
  waiting.forEach((b, index) => {
    const place = resolved[index]
    if (place !== null && place !== undefined) positions.set(b.id, place)
  })
```

The meta line gains the position, and the control gains the third status:

```tsx
              <p className="text-muted mt-1 font-mono text-[13px]">
                {booking.events && `${formatIst(new Date(booking.events.starts_at))} · `}
                {booking.quantity} {booking.quantity === 1 ? 'seat' : 'seats'} · {booking.status}
                {positions.has(booking.id) && ` · ${waitlistShortPosition(positions.get(booking.id)!)}`}
              </p>
              {/* A confirmed booking is cancelled, a pending request is
                  withdrawn, a waitlist entry is left — same cancel_booking
                  underneath, three verbs on the surface because they are three
                  different things to the person doing them. Not offered on a
                  cancelled row: cancel_booking is idempotent so it would be
                  harmless, and still wrong — it would read as though the row
                  might come back. */}
              {(booking.status === 'confirmed' ||
                booking.status === 'pending_approval' ||
                booking.status === 'waitlisted') && (
                <CancelButton
                  bookingId={booking.id}
                  slug={booking.events?.slug ?? ''}
                  label={
                    booking.status === 'pending_approval'
                      ? 'Withdraw request'
                      : booking.status === 'waitlisted'
                        ? 'Leave the waitlist'
                        : undefined
                  }
                  /* Untouched. Already gated on `confirmed`, so a waitlist
                     entry gets null without a new branch — and correctly:
                     nothing was paid and no seat was held. */
                  consequence={
                    booking.status === 'confirmed' && booking.events
                      ? cancelConsequence({
                          initiator: 'attendee',
                          totalPaise: booking.total_paise,
                          startsAt: booking.events.starts_at,
                          cutoffHours: booking.events.refund_cutoff_hours,
                          paymentMode: booking.payment_mode === 'cash' ? 'cash' : 'online',
                        })
                      : null
                  }
                />
              )}
```

- [ ] **Step 7: Green, then commit**

```bash
npx vitest run "app/bookings/[reference]/claim-seat.test.ts" "app/bookings/[reference]/approved-pay.test.ts"
npm test
npm run typecheck
git add "app/bookings/[reference]/page.tsx" "app/bookings/[reference]/approved-pay-panel.tsx" \
        "app/bookings/[reference]/claim-seat-panel.tsx" "app/bookings/[reference]/actions.ts" \
        "app/bookings/[reference]/claim-seat.test.ts" app/bookings/page.tsx
git commit -m "feat: the booking page says where you stand, and takes the seat when it comes"
```

---

### Task 9: The host's page — the line, and the offers in flight

**Files:**
- Modify: `app/host/events/[id]/attendees/page.tsx`
- Test: append to `lib/bookings/waitlist-service.test.ts`

There is no promote button, and adding one would be a mistake rather than a convenience: promotion is automatic, and a control that fires it by hand would let a host reorder a queue whose entire value is that it cannot be reordered. What this page gets is the line's contents, the offers currently in flight, and the one action a host legitimately has — removing somebody.

**Interfaces:**
- Consumes: `listEventWaitlist` (Task 5), `REMOVE_FROM_WAITLIST_CONSEQUENCE` (Task 3), `OwnedEvent.has_waitlist` (Task 5), `CancelAttendeeButton`, `dialable` and `formatIst` (already in this file).
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `lib/bookings/waitlist-service.test.ts`:

```ts
describe('the host removing somebody from the line', () => {
  it('removes them and lets the line move, without touching money', async () => {
    const seed = await seedEvent(db, { quantity: 3, pricePaise: 50_000, hasWaitlist: true, maxPerOrder: 3 })
    const filler = await fill(seed, 3)
    // A three-seat head blocking a one-seat entry behind it.
    const bigHead = await createTestUser(db)
    await joinWaitlist(asCaller(bigHead), seed.ticketTypeId, 3, 'Head of three', 'online')
    await joinWaitlist(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')

    // One seat comes back; the head cannot use it and nobody may pass them.
    await db.from('bookings').update({ quantity: 2 }).eq('id', filler.bookingId)
    await db.from('ticket_types').update({ reserved_count: 2 }).eq('id', seed.ticketTypeId)
    await db.rpc('promote_from_waitlist', { p_ticket_type_id: seed.ticketTypeId })

    const { data: head } = await db.from('bookings').select('id').eq('attendee_id', bigHead).single()
    // The host removes the blocking entry — the same cancelBooking a guest's
    // own withdraw goes through, with 'host' as the initiator.
    expect(await cancelBooking(asCaller(seed.hostProfileId), head!.id, 'host')).toEqual({ ok: true })

    const { data: after } = await db
      .from('bookings').select('status, cancellation_reason').eq('id', head!.id).single()
    expect(after).toMatchObject({ status: 'cancelled', cancellation_reason: 'cancelled by host' })

    // No refund row could exist — a waitlist entry never had a payment.
    const { data: payments } = await db.from('payments').select('id').eq('booking_id', head!.id)
    expect(payments).toHaveLength(0)

    // And the line moved: Asha now holds the seat that was stuck behind them.
    const { data: asha } = await db
      .from('bookings').select('status').eq('attendee_id', seed.attendeeId).single()
    expect(asha!.status).toBe('awaiting_payment')

    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    for (const id of [filler.buyer, bigHead]) await db.auth.admin.deleteUser(id).catch(() => {})
  })
})
```

- [ ] **Step 2: Run to verify it passes already**

```bash
npx vitest run lib/bookings/waitlist-service.test.ts
```

This one is expected to pass on the first run — `cancel_booking` and `mayCancel` already do all of it, and Task 1 wired the promotion. That is the assertion's whole point: it pins behaviour this task's UI is about to depend on, so a later change to the cancel path cannot quietly remove a host's ability to unblock a stuck line. If it fails, the fault is in Task 1's `cancel_booking`, not here.

- [ ] **Step 3: The page**

`app/host/events/[id]/attendees/page.tsx`. Imports:

```ts
import {
  listApprovedUnpaid,
  listEventAttendees,
  listEventRequests,
  listEventWaitlist,
  type EventRequest,
} from '@/lib/bookings/queries'
import { REMOVE_FROM_WAITLIST_CONSEQUENCE } from '@/lib/bookings/waitlist-copy'
```

The parallel read grows a fourth:

```ts
  const [attendees, requests, unpaid, waitlist] = await Promise.all([
    listEventAttendees(id),
    listEventRequests(id),
    listApprovedUnpaid(id),
    listEventWaitlist(id),
  ])
```

The headline's queue summary grows a third number. Confirmed seats stay the headline; the queue numbers ride beside it only while any of them is non-zero:

```tsx
        {(requests.length > 0 || unpaid.length > 0 || waitlist.length > 0) &&
          ` · ${requests.length} requested · ${unpaid.length} approved unpaid · ${waitlist.length} waiting`}
```

The Waitlist section goes **below** the payment-pending strip and above the guest list: the strip is what is waiting on somebody *now*, while the line is waiting on a seat that may never come free. Rendered only when there is a line, so a host whose event keeps none never sees the machinery:

```tsx
      {/* The line, in the order it will be served. The number in front of each
          name is the array index, not a stored column — this list is ordered by
          the same (created_at, id) that promote_from_waitlist promotes by, so
          the position on screen cannot disagree with the engine. */}
      {waitlist.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Waitlist</h2>
          <p className="text-muted mt-1 font-mono text-[13px]">
            {waitlist.length} {waitlist.length === 1 ? 'person' : 'people'} waiting. Seats are
            offered automatically, in this order.
          </p>
          <ul className="divide-line mt-4 divide-y">
            {waitlist.map((entry, index) => (
              <li key={entry.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <span className="text-muted font-mono text-[12px]">#{index + 1}</span>{' '}
                    {entry.attendee_name ?? 'Guest'}
                  </p>
                  <p className="text-muted font-mono text-[12px]">
                    {entry.quantity} {entry.quantity === 1 ? 'seat' : 'seats'} ·{' '}
                    {entry.payment_mode === 'cash' ? 'cash' : 'online'} · {entry.reference} ·{' '}
                    joined {formatIst(new Date(entry.created_at))}
                  </p>
                  {entry.profiles?.phone && (
                    <a
                      href={`tel:${dialable(entry.profiles.phone)}`}
                      className="font-mono text-[12px] underline"
                    >
                      {dialable(entry.profiles.phone)}
                    </a>
                  )}
                </div>
                <div className="flex shrink-0 items-start">
                  {/* The existing host cancel. Its consequence is not
                      cancelConsequence's: no money moved and no seat was held,
                      so that function would return null and leave the control
                      with nothing beside it. */}
                  <CancelAttendeeButton
                    bookingId={entry.id}
                    eventId={id}
                    slug={event.slug}
                    consequence={REMOVE_FROM_WAITLIST_CONSEQUENCE}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
```

Finally the payment-pending strip learns which queue it is reporting on. Two strings, one condition — the rows themselves are identical, because an offer and an approval genuinely are the same row:

```tsx
      {unpaid.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">
            {event.has_waitlist ? 'Seat offers — waiting on the guest' : 'Approved — payment pending'}
          </h2>
```

and inside each row's meta line, the verb:

```tsx
                    {u.quantity} {u.quantity === 1 ? 'seat' : 'seats'} ·{' '}
                    {formatPaise(u.total_paise)} ·{' '}
                    {event.has_waitlist ? 'Offer expires ' : 'Pay by '}
                    {u.hold_expires_at ? formatIst(new Date(u.hold_expires_at)) : '—'}
```

> "Offer expires" rather than "Pay by" because a waitlist offer may be a *claim* rather than a payment — a cash or free offer is taken with a tap, not a card — and a host chasing someone should not be told to ask for money that settles at the door. The row does not say which of the two it is; the deadline is the fact the host needs either way.

- [ ] **Step 4: Green, then commit**

```bash
npx vitest run lib/bookings/waitlist-service.test.ts
npm test
npm run typecheck
git add "app/host/events/[id]/attendees/page.tsx" lib/bookings/waitlist-service.test.ts
git commit -m "feat: the host sees the line and the offers in flight"
```

---

### Task 10: Finale — suite, build, spec cross-check, merge

**Files:** none new.

- [ ] **Step 1: The full gauntlet**

```bash
npm test          # every file; count must be >= Task 1's baseline + this phase's new tests
npm run lint      # `eslint`. NOT `npx next lint` — Next 16 removed that subcommand
                  # and reads the word "lint" as a directory name instead.
npm run typecheck # `next typegen && tsc --noEmit` — the typegen half is what
                  # makes the PageProps<'/route'> helpers exist.
npm run build
```

- [ ] **Step 2: Prove the migrations apply to a fresh database**

Everything above was applied incrementally to a dev database that already had the 5a schema, and Task 1's Step 7 re-apply route means individual function bodies may have been pushed through `psql` rather than through the migration file. A fresh apply is the only thing that proves the committed files are what actually built this.

Do **not** run `supabase db reset` — the dev DB holds kept evidence rows. Apply to a scratch database instead:

```bash
docker exec -i supabase_db_Event_Hoster psql -U postgres -c 'create database waitlist_check;'
for f in supabase/migrations/*.sql; do
  docker exec -i supabase_db_Event_Hoster psql -v ON_ERROR_STOP=1 -U postgres -d waitlist_check < "$f" || break
done
docker exec -i supabase_db_Event_Hoster psql -U postgres -c 'drop database waitlist_check;'
```

Expect no errors. `unsafe use of new value "waitlisted"` means the two migrations got merged into one file; `function … does not exist` in the 20260811000006 grants means a signature in a `revoke`/`grant` line does not match the function above it.

- [ ] **Step 3: Cross-check the spec**

Open `docs/specs/2026-08-11-phase-5b-waitlist-design.md` and verify each is true in code, ticking them off:

- join → promote → pay → confirm works end to end for an online entry (Task 4's `waitlist-offer-checkout.test.ts`)
- claim confirms free and cash offers with tickets (Task 4)
- strict FIFO: a big head blocks the line, and nobody passes them (Task 2)
- two freed seats chain down the line in order (Task 2)
- a lapsed offer expires and the same call offers it onward (Task 2)
- promotion no-ops after `starts_at`; un-promoted entries sit inert and withdrawable (Task 2, Task 8)
- walk-ups cannot cut, in SQL and on the page (Task 2's concurrency test; Task 7's `joinable` gate)
- a host adding seats to a sold-out event serves the line rather than the next walk-up (Task 6's `promoteAfterCapacityChange`), **and Task 2's rollback pin — `a refused reservation rolls back the promotion it just made` — is still green and still there.** It is not a defect awaiting repair; it is the documented reason `promoteAfterCapacityChange` exists, and it stays green because that fix adds a committing caller at the service layer without touching `reserve_tickets`, while the pin drives `reserve_tickets` directly. Do not delete it.
- repricing is at offer time, against a mid-queue price edit (Task 2)
- every `EH06x` guard, plus unpublished passing through unmapped (Task 1)
- `has_waitlist` toggle, hidden under `requires_approval`, exclusive by CHECK and by coercion (Task 6)
- position for the attendee on both surfaces; the line for the host (Tasks 5, 8, 9)
- the copy: position, offer-pay, offer-claim, lapse, remove (Task 3)
- authorisation as attempts that must fail: a stranger cannot claim another's offer, see another's position, or read the host's line (Tasks 4, 5)
- **no notifications anywhere** — `grep -rn "whatsapp\|notify\|sendMessage" lib/ app/` returns nothing new
- **no new dependencies or env vars** — `git diff master --stat package.json .env.example` is empty
- **no new admin importers** — `grep -rn "lib/supabase/admin" lib/ app/` still returns exactly the three fenced files

- [ ] **Step 4: Walk it once in the browser**

The suite cannot see a bottom bar. On `localhost:3100` (never `127.0.0.1:3100`), with a `has_waitlist` event seeded to one seat:

1. Sell the seat. The event page turns from Book to **Join the waitlist** with "Nobody waiting yet".
2. Join as a second user. `/bookings/<ref>` says "You're #1 in line for 1 seat".
3. Reload the event page as a third user — still join-waitlist mode, now "1 person waiting".
4. Cancel the first booking. Refresh `/bookings/<ref>`: "A seat opened up for you", with Pay (online) or Claim (cash/free).
5. The host's attendees page shows the offer under **Seat offers — waiting on the guest**, and an empty Waitlist section.
6. Take the offer. Tickets and a QR appear.

- [ ] **Step 5: Merge**

```bash
git checkout master
git merge --no-ff phase-5b-waitlist -m "Merge Phase 5b: the waitlist"
```

Keep the branch, matching the repo's convention (phase-0/1/2b/3/5a are all still around). Push only when the user confirms. `npm run db:stop` if the session is ending — `C:` is ~99% full.

