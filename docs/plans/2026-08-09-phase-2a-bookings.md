# Phase 2a — Free Bookings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An attendee taps a WhatsApp link, taps Book, and has a seat; the host can see who is coming.

**Architecture:** One new `SECURITY DEFINER` function wraps Phase 0's `reserve_tickets` → `confirm_booking` in a single transaction. Writes go through the service role from one module, `lib/bookings/service.ts`, because `bookings` and `tickets` are deliberately not writable by `authenticated`. Reads stay on the normal RLS-scoped client. Authorisation is hand-written TypeScript made structural by a branded `Caller` type and a lint rule.

**Tech Stack:** Postgres 17 (local Supabase), plpgsql, Next.js 16.3 App Router, React 19.2, TypeScript, Tailwind 4, supabase-js 2.x, Vitest 4.

**Spec:** [`docs/specs/2026-08-09-phase-2a-bookings-design.md`](../specs/2026-08-09-phase-2a-bookings-design.md)

## Global Constraints

- **Money is always integer paise.** `rupeesToPaise()` / `formatPaise()` from `lib/money.ts`. Never floats, never rupees in the database.
- **`lib/bookings/service.ts` is the ONLY file in `app/` or `lib/` that may import `lib/supabase/admin.ts`.** A lint rule enforces this from Task 2 onward. Everything else uses `@/lib/supabase/server`.
- **Identity never comes from a form.** Every write takes a `Caller`, which only `currentCaller()` can produce. A posted `attendeeId` field must not exist anywhere.
- **Only free, no-approval, not-yet-started events are bookable.** `price_paise = 0`, `requires_approval = false`, `starts_at > now()`. Enforced in SQL, not only in the action.
- **One active booking per attendee per event.** Enforced by a partial unique index, not by an application check, because an application check races with itself.
- **A host never sees an attendee's phone number.** The guest list shows the name the attendee typed. `profiles` stays readable only by its owner.
- **`params` and `searchParams` are Promises** in Next.js 16. Use the generated `PageProps<'/route'>` from `next typegen`; never hand-write page prop types.
- **`cookies()` is async.** `lib/supabase/server.ts#createClient` must be awaited.
- **IST is UTC+05:30 year-round, no DST.** Use `lib/events/datetime.ts`; never `new Date(localString)` on a zoneless value.
- **Run `npm run db:types` after the migration.** `lib/supabase/types.ts` is committed and must never be hand-edited.
- **`npm test` needs `npm run db:start`,** which needs Docker Desktop, which on this machine starts only via PowerShell: `powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`. Without it, tests fail with `createTestUser failed: fetch failed`, which reads like an app bug and is not one.
- **`lib/events/actions.test.ts` is order-dependent.** Do not append to it; new tests go in new files.
- **Baseline suite is 221 tests across 16 files, all green.** Never finish a task with a red suite.
- **`C:` is ~98% full.** Run `npm run db:stop` when the session ends.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260810000001_bookings_attendee_name.sql` | **New.** `bookings.attendee_name`, and the partial unique index enforcing one active booking per attendee per event. |
| `supabase/migrations/20260810000002_book_free_tickets.sql` | **New.** `book_free_tickets()`, its four guards, its revoke/grant pair. |
| `lib/supabase/types.ts` | **Regenerated.** Gains the new function's `Args`. |
| `lib/bookings/caller.ts` | **New.** The branded `Caller` type and the only way to make one. |
| `lib/bookings/authorize.ts` | **New.** Pure. `mayCancel()`. No database, no imports beyond the `Caller` type. |
| `lib/bookings/rpc-errors.ts` | **New.** Pure. Maps booking SQLSTATEs to sentences. |
| `lib/bookings/service.ts` | **New.** The only `admin.ts` importer. All booking writes. |
| `lib/bookings/queries.ts` | **New.** All booking reads, on the RLS-scoped client. |
| `eslint.config.mjs` | **Modified.** `no-restricted-imports` guarding `admin.ts`. |
| `app/e/[slug]/book-panel.tsx` | **New.** Client component: quantity picker + submit. |
| `app/e/[slug]/actions.ts` | **New.** `bookEvent` Server Action. |
| `app/e/[slug]/page.tsx` | **Modified**, lines 322-347: the inert control becomes `<BookPanel>` for bookable events. |
| `app/bookings/[reference]/page.tsx` | **New.** Confirmation page. |
| `app/bookings/page.tsx` | **New.** Attendee's own bookings. |
| `app/bookings/actions.ts` | **New.** `cancelMyBooking` Server Action. |
| `app/host/events/[id]/attendees/page.tsx` | **New.** Host guest list. |
| `app/host/events/[id]/attendees/actions.ts` | **New.** `cancelAttendeeBooking` Server Action. |
| `app/page.tsx` | **Modified**, line 57: a "Your bookings" link beside "Host an event". |

Reads and writes are split into two modules on purpose: `queries.ts` runs under RLS like every other read in this repo, and `service.ts` is the single quarantined place where RLS does not apply.

## Findings from the pre-implementation audit

Four things were checked against the codebase after this plan was first written, and each changed it. They are recorded here because each is invisible from the task list and each would have cost a build.

**A host cannot read an attendee's `profiles` row.** `profiles_select_own` is `id = auth.uid()` and that is the entire SELECT surface on the table (`20260808000003_rls_policies.sql:61`). An embed of `bookings.profiles(full_name, phone)` therefore returns `null` for every attendee — PostgREST raises nothing, so a guest list built that way renders "Guest" and a blank phone for every row while every test that counts rows passes. Compounding it, `full_name` is null for every user who has ever existed: the signup trigger writes `id` and `phone` only (`20260808000001_core_schema.sql:64`) and nothing in the repo writes it. **Resolution:** the attendee types a name when booking and it is stored on the booking. No RLS change, and hosts never see phone numbers.

**Nothing stopped an attendee booking the same event repeatedly.** `max_per_order` bounds one order, not a person, so ten single-seat bookings take a ten-seat room. **Resolution:** one active booking per attendee per event, enforced by a partial unique index.

**`reserve_tickets` never checks `starts_at`.** It validates published status and the sales window, both of which a finished event still passes, so anyone scrolling back through WhatsApp could book last month's supper club. **Resolution:** an explicit guard.

**There is no navigation anywhere in the app.** `app/layout.tsx:58` is `<body className="min-h-full">{children}</body>` — no header, no nav, no shell. Without a link added deliberately, `/bookings` is reachable only by typing the URL. **Resolution:** Task 9.

One thing the audit cleared rather than changed: every page in this app is dynamically rendered, because `lib/supabase/server.ts:13` awaits `cookies()` on every query path. There is no ISR window and no data cache in front of the seats-left count, so a reload always shows the truth. `revalidatePath` still matters for Next's client Router Cache on back/forward navigation, which is why the booking actions call it.

---

### Task 1: `attendee_name`, the one-booking rule, and `book_free_tickets()`

**Files:**
- Create: `supabase/migrations/20260810000001_bookings_attendee_name.sql`
- Create: `supabase/migrations/20260810000002_book_free_tickets.sql`
- Modify: `lib/supabase/types.ts` (regenerated, never hand-edited)
- Test: `lib/bookings/book-free-tickets.test.ts`

**Interfaces:**
- Consumes: `reserve_tickets`, `confirm_booking` from `20260808000002_reservation_functions.sql`
- Produces: `book_free_tickets(p_ticket_type_id uuid, p_attendee_id uuid, p_quantity integer, p_attendee_name text, p_attendee_note text) returns bookings`; `bookings.attendee_name`; SQLSTATE `EH010` (not free), `EH011` (requires approval), `EH012` (already booked), `EH013` (event has started)

Two migrations, not one: the column and the index are schema, the function is behaviour, and this repo's history is one focused change per file.

- [ ] **Step 1: Write the failing test**

```ts
// lib/bookings/book-free-tickets.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()
let free: SeededEvent

beforeAll(async () => {
  free = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
})

afterAll(async () => {
  await cleanupEvent(db, free)
})

describe('book_free_tickets', () => {
  it('confirms the booking, records the name and issues one ticket per seat', async () => {
    const { data, error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: free.attendeeId,
      p_quantity: 3,
      p_attendee_name: '  Priya  ',
      p_attendee_note: null,
    })

    expect(error).toBeNull()
    // Trimmed on the way in: the host reads this at a door.
    expect(data).toMatchObject({ status: 'confirmed', quantity: 3, total_paise: 0, attendee_name: 'Priya' })
    expect((data as { hold_expires_at: string | null }).hold_expires_at).toBeNull()

    const bookingId = (data as { id: string }).id
    const { data: tickets } = await db.from('tickets').select('code').eq('booking_id', bookingId)
    expect(tickets).toHaveLength(3)
    // 16 random bytes as hex.
    expect(tickets![0].code).toMatch(/^[0-9a-f]{32}$/)

    const { data: tt } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', free.ticketTypeId)
      .single()
    expect(tt!.reserved_count).toBe(3)
  })

  it('refuses a paid event as EH010, taking no inventory', async () => {
    const paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.code).toBe('EH010')

    const { data: tt } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', paid.ticketTypeId)
      .single()
    expect(tt!.reserved_count).toBe(0)

    const { data: bookings } = await db.from('bookings').select('id').eq('event_id', paid.eventId)
    expect(bookings ?? []).toHaveLength(0)

    await cleanupEvent(db, paid)
  })

  it('refuses an approval-gated event as EH011', async () => {
    const gated = await seedEvent(db, {
      quantity: 10,
      pricePaise: 0,
      status: 'published',
      requiresApproval: true,
    })

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: gated.ticketTypeId,
      p_attendee_id: gated.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.code).toBe('EH011')

    await cleanupEvent(db, gated)
  })

  it('refuses a second active booking by the same attendee as EH012', async () => {
    // max_per_order bounds one order, not one person. Without this rule, ten
    // single-seat bookings take a ten-seat room.
    const solo = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })

    const first = await db.rpc('book_free_tickets', {
      p_ticket_type_id: solo.ticketTypeId,
      p_attendee_id: solo.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    expect(first.error).toBeNull()

    const second = await db.rpc('book_free_tickets', {
      p_ticket_type_id: solo.ticketTypeId,
      p_attendee_id: solo.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    expect(second.error?.code).toBe('EH012')

    // Exactly one seat moved, so the refusal rolled its reservation back.
    const { data: tt } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', solo.ticketTypeId)
      .single()
    expect(tt!.reserved_count).toBe(1)

    await cleanupEvent(db, solo)
  })

  it('lets an attendee rebook after cancelling', async () => {
    // The index predicate covers only active statuses, so cancelling frees the
    // slot. Without this the rule would be "one booking ever", which is not it.
    const again = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })

    const first = await db.rpc('book_free_tickets', {
      p_ticket_type_id: again.ticketTypeId,
      p_attendee_id: again.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    await db.rpc('cancel_booking', {
      p_booking_id: (first.data as { id: string }).id,
      p_reason: 'changed my mind',
    })

    const second = await db.rpc('book_free_tickets', {
      p_ticket_type_id: again.ticketTypeId,
      p_attendee_id: again.attendeeId,
      p_quantity: 4,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })
    expect(second.error).toBeNull()

    await cleanupEvent(db, again)
  })

  it('refuses an event that has already started as EH013', async () => {
    // reserve_tickets checks published status and the sales window; a finished
    // event passes both. Anyone scrolling back through WhatsApp could book it.
    const past = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    await db
      .from('events')
      .update({ starts_at: new Date(Date.now() - 3600_000).toISOString() })
      .eq('id', past.eventId)

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: past.ticketTypeId,
      p_attendee_id: past.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.code).toBe('EH013')

    await cleanupEvent(db, past)
  })

  it('passes through reserve_tickets\' own refusals', async () => {
    // Not remapped: "only N seats remain" is already a sentence for a human.
    // A fresh attendee, because `free.attendeeId` already booked above and
    // would now be refused by EH012 before availability was ever consulted.
    const { createTestUser } = await import('@/tests/helpers/db')
    const hopeful = await createTestUser(db)

    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: hopeful,
      p_quantity: 99,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.message).toContain('seats remain')
    await db.auth.admin.deleteUser(hopeful).catch(() => {})
  })

  it('is unreachable by a signed-in user over the public API', async () => {
    // Inventory functions are service-role only. This one joins them.
    const { userClient } = await import('@/tests/helpers/db')
    const { error } = await userClient(free.attendeeId).rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: free.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Priya',
      p_attendee_note: null,
    })

    expect(error?.message).toBe('permission denied for function book_free_tickets')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run lib/bookings/book-free-tickets.test.ts
```

Expected: FAIL, PostgREST `PGRST202` — `Could not find the function public.book_free_tickets`.

- [ ] **Step 3a: Write the schema migration**

```sql
-- supabase/migrations/20260810000001_bookings_attendee_name.sql

-- Who is coming, and how many times they may say so.
--
-- attendee_name: a host needs to know who is at the door, and cannot find out
-- any other way. profiles_select_own (20260808000003:61) is the entire SELECT
-- surface on profiles -- `id = auth.uid()`, own row only -- so an embed of
-- bookings.profiles(...) returns null for every attendee without erroring, and
-- a guest list built on one silently lists nobody. profiles.full_name is null
-- for every user in any case: handle_new_user() writes id and phone and nothing
-- else, and nothing in this repo has ever written full_name.
--
-- So the attendee types a name when booking and it lands here. The host sees
-- what the guest chose to be called; nobody's phone number moves. Nullable
-- because request_booking (Phase 5) and the payment path (Phase 3) do not
-- collect it.

alter table bookings add column attendee_name text;

-- One active booking per attendee per event.
--
-- max_per_order bounds a single order, not a person, so ten single-seat
-- bookings take a ten-seat supper club and every one of them is individually
-- within the rules. This is the rule that says otherwise.
--
-- A unique index rather than a check inside book_free_tickets, because the
-- check would race with itself: two concurrent requests both read "no existing
-- booking" and both insert. The index is decided by Postgres at write time and
-- cannot be lost that way. The function still pre-checks, so the common case
-- gets a sentence instead of a constraint name; this is the backstop.
--
-- Partial on the active statuses only. cancel_booking sets 'cancelled' and
-- release_expired_holds sets 'expired', both outside the predicate, so
-- cancelling frees the attendee to book again -- which is the difference
-- between this rule and "one booking ever".
create unique index bookings_one_active_per_attendee
  on bookings (event_id, attendee_id)
  where status in ('pending_approval', 'awaiting_payment', 'confirmed');
```

- [ ] **Step 3b: Write the function migration**

```sql
-- supabase/migrations/20260810000002_book_free_tickets.sql

-- Booking a free event, as one transaction.
--
-- A free booking is Phase 0's reserve_tickets followed immediately by
-- confirm_booking: there is no payment step to wait between them. Issued as two
-- RPCs those are two transactions, and a failure between them leaves a held
-- booking that only the sweeper cleans up. Nested plpgsql calls run inside the
-- caller's transaction, so joining them here makes the pair atomic without
-- touching either function -- and the 50-concurrent-booking test keeps guarding
-- exactly what it guards.
--
-- Same posture as the rest of 20260808000002: SECURITY DEFINER with EXECUTE
-- revoked from anon and authenticated, so it is unreachable over PostgREST.
-- It mutates reserved_count, and nothing a browser can call may do that. The
-- Server Action calls it as the service role, having authenticated the user
-- itself -- see lib/bookings/service.ts, which is the only place permitted to.
--
--   EH010  the ticket type is not free; payment is Phase 3
--   EH011  the event requires host approval; that flow is Phase 5
--   EH012  this attendee already has an active booking on this event
--   EH013  the event has already started
--
-- `extensions` on the search_path because confirm_booking needs pgcrypto's
-- gen_random_bytes for ticket codes, and it inherits this setting when called
-- from here.

create or replace function book_free_tickets(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text,
  p_attendee_note  text default null
)
returns bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tt      ticket_types%rowtype;
  ev      events%rowtype;
  booking bookings%rowtype;
begin
  select * into tt from ticket_types where id = p_ticket_type_id;

  if not found then
    raise exception 'ticket type % not found', p_ticket_type_id
      using errcode = 'no_data_found';
  end if;

  select * into ev from events where id = tt.event_id;

  -- Both guards run before any inventory moves. The transaction would roll a
  -- reservation back anyway; refusing first means the failure never depended on
  -- that, and it keeps the reason legible in a log.
  --
  -- In SQL rather than only in the Server Action because these are the
  -- conditions under which issuing a *confirmed* ticket is correct at all. A
  -- caller that forgets them is asking for something that should not be
  -- possible, and the answer should not depend on which caller asked.
  if tt.price_paise <> 0 then
    raise exception 'this event is not free (price %)', tt.price_paise
      using errcode = 'EH010';
  end if;

  if ev.requires_approval then
    raise exception 'this event requires host approval before booking'
      using errcode = 'EH011';
  end if;

  -- reserve_tickets checks published status and the sales window, and a
  -- finished event passes both -- sales_start and sales_end are null on every
  -- event this product creates. Without this, last month's supper club is still
  -- bookable by anyone scrolling back through a WhatsApp group.
  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH013';
  end if;

  -- The friendly half of the one-booking rule. bookings_one_active_per_attendee
  -- is the half that actually holds under concurrency; this exists so the
  -- ordinary case gets a sentence rather than an index name, and it is checked
  -- before inventory moves so the refusal costs nothing.
  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH012';
  end if;

  -- Everything else -- published status, sales window, max_per_order,
  -- availability under a row lock -- is already reserve_tickets' job, and its
  -- refusals are already sentences a person can read. They pass through.
  --
  -- Defaults left alone: zero fee, zero commission, payment_mode 'online', a
  -- ten-minute hold that confirm_booking clears microseconds later. A free
  -- booking therefore stores payment_mode 'online' with total_paise 0, which
  -- reads oddly and is correct: the column records how the attendee *would*
  -- pay, and 'cash' means something specific that Phase 5 introduces.
  booking := reserve_tickets(
    p_ticket_type_id => p_ticket_type_id,
    p_attendee_id    => p_attendee_id,
    p_quantity       => p_quantity,
    p_attendee_note  => p_attendee_note
  );

  -- reserve_tickets has no name parameter and should not grow one: it is the
  -- shared path for every booking kind, and only this one asks for a name.
  -- Written here instead, inside the same transaction.
  update bookings
     set attendee_name = nullif(btrim(p_attendee_name), '')
   where id = booking.id;

  return confirm_booking(booking.id);

exception
  -- The pre-check above loses the race sometimes; the index never does. Both
  -- must say the same thing to the attendee, or the same situation reads as a
  -- refusal one time and a database fault the next.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH012';
    end if;
    raise;
end;
$$;

-- EXECUTE on a new function is granted to PUBLIC by default. Revoking from
-- public also strips service_role, which is neither a superuser nor a member of
-- authenticated -- so the grant back is required, not decorative. anon is named
-- explicitly because a hosted project may carry default privileges that survive
-- a revoke from PUBLIC.
revoke execute on function book_free_tickets(uuid, uuid, integer, text, text)
  from public, anon, authenticated;

grant execute on function book_free_tickets(uuid, uuid, integer, text, text)
  to service_role;
```

**Two `text` arguments, not one** — `p_attendee_name` and `p_attendee_note`. A mismatched list fails with `function … does not exist`, which is the good failure, but count them against the definition rather than trusting the shape.

- [ ] **Step 4: Apply and regenerate types**

```bash
npm run db:reset
npm run db:types
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run lib/bookings/book-free-tickets.test.ts
```

Expected: PASS, 8 tests.

**If `booking := reserve_tickets(...)` fails to compile,** the composite assignment form is the problem, not the logic. Replace it with:

```sql
  select * into booking from reserve_tickets(
    p_ticket_type_id, p_attendee_id, p_quantity, 0, 0, 'online', 10, p_attendee_note
  ) as r;
```

and say in your report which form you used.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/ lib/supabase/types.ts lib/bookings/book-free-tickets.test.ts
git commit
```

Two commits if you prefer — schema, then function. One is acceptable here because the function's guards are meaningless without the index.

---

### Task 2: `Caller`, `mayCancel`, and the lint rule

**Files:**
- Create: `lib/bookings/caller.ts`, `lib/bookings/authorize.ts`, `lib/bookings/authorize.test.ts`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: `getCurrentUser()` from `@/lib/auth/session`
- Produces: `type Caller`, `currentCaller(): Promise<Caller | null>`, `mayCancel(caller: Caller, booking: CancellableBooking): boolean`, `interface CancellableBooking { attendee_id: string; event_host_profile_id: string }`

- [ ] **Step 1: Write the failing test**

```ts
// lib/bookings/authorize.test.ts
import { describe, expect, it } from 'vitest'
import { mayCancel } from '@/lib/bookings/authorize'
import type { Caller } from '@/lib/bookings/caller'

/**
 * Tests are the one place a Caller is fabricated. Application code cannot do
 * this — the brand is not exported — which is the entire point of the type.
 */
function callerOf(id: string): Caller {
  return { id } as Caller
}

const ATTENDEE = '11111111-1111-1111-1111-111111111111'
const HOST = '22222222-2222-2222-2222-222222222222'
const STRANGER = '33333333-3333-3333-3333-333333333333'

const booking = { attendee_id: ATTENDEE, event_host_profile_id: HOST }

describe('mayCancel', () => {
  it('lets the attendee cancel their own booking', () => {
    expect(mayCancel(callerOf(ATTENDEE), booking)).toBe(true)
  })

  it('lets the host of the event cancel it', () => {
    expect(mayCancel(callerOf(HOST), booking)).toBe(true)
  })

  it('refuses everyone else', () => {
    expect(mayCancel(callerOf(STRANGER), booking)).toBe(false)
  })

  it('refuses an empty caller id even against empty booking fields', () => {
    // Defensive. Without the guard, a caller whose id failed to resolve to a
    // string matches a booking whose columns also came back empty, and two
    // absent identities compare equal — a refusal that reads as an approval.
    expect(mayCancel(callerOf(''), { attendee_id: '', event_host_profile_id: '' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run lib/bookings/authorize.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/bookings/authorize"`.

- [ ] **Step 3: Write `lib/bookings/caller.ts`**

```ts
import 'server-only'
import { getCurrentUser } from '@/lib/auth/session'

declare const verified: unique symbol

/**
 * A user id that provably came from a validated session.
 *
 * This phase writes bookings as the service role, because `bookings` and
 * `tickets` are deliberately not writable by `authenticated`. RLS therefore
 * does not scope these writes, and every authorisation decision is ours to
 * make in TypeScript.
 *
 * The brand is what stops that being a matter of remembering. `bookFreeTickets`
 * takes a Caller, `verified` is not exported, and nothing here turns a string
 * into one — so `bookFreeTickets(formData.get('attendeeId'), …)` is a compile
 * error rather than an attacker booking under someone else's name. Identity can
 * only originate below.
 */
export type Caller = { readonly id: string; readonly [verified]: true }

/** The only way to obtain a Caller. Null when signed out. */
export async function currentCaller(): Promise<Caller | null> {
  const user = await getCurrentUser()
  return user ? ({ id: user.id } as Caller) : null
}
```

- [ ] **Step 4: Write `lib/bookings/authorize.ts`**

```ts
import type { Caller } from '@/lib/bookings/caller'

/** The fields of a booking that decide who may cancel it. */
export interface CancellableBooking {
  attendee_id: string
  /** `profiles.id` of the host who owns the event this booking is for. */
  event_host_profile_id: string
}

/**
 * Who may cancel a booking: the attendee who made it, or the host whose event
 * it is.
 *
 * Pure and separately tested because RLS does not enforce this — the write goes
 * through the service role, so this function is the whole of the rule. Both
 * call sites ask it rather than each writing the comparison out, so there is one
 * answer rather than two that can drift.
 */
export function mayCancel(caller: Caller, booking: CancellableBooking): boolean {
  // An absent id must never match an absent column. Two blanks are equal.
  if (!caller.id) return false
  return caller.id === booking.attendee_id || caller.id === booking.event_host_profile_id
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run lib/bookings/authorize.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Add the lint rule**

In `eslint.config.mjs`, append one config object after the `globalIgnores(...)` entry, inside the `defineConfig([...])` array:

```js
  // The service role bypasses RLS entirely. Phase 2 needs it, because bookings
  // and tickets are deliberately not writable by `authenticated` — but it needs
  // it in exactly one place, so that "did we check authorisation here?" has one
  // file as its answer rather than a grep.
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    ignores: ["lib/bookings/service.ts", "lib/supabase/admin.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@/lib/supabase/admin",
          message:
            "Only lib/bookings/service.ts may use the service role. Use @/lib/supabase/server, or add the write to that module.",
        }],
      }],
    },
  },
```

- [ ] **Step 7: Prove the rule fires**

```bash
printf "import { createAdminClient } from '@/lib/supabase/admin'\nexport const x = createAdminClient\n" > lib/bookings/lint-probe.ts
npx eslint lib/bookings/lint-probe.ts
```

Expected: an error naming `@/lib/supabase/admin`. Then:

```bash
rm lib/bookings/lint-probe.ts
npx eslint
```

Expected: clean. A lint rule nobody has seen fail is not known to work — record the probe output in your report.

- [ ] **Step 8: Commit**

```bash
git add lib/bookings/caller.ts lib/bookings/authorize.ts lib/bookings/authorize.test.ts eslint.config.mjs
git commit
```

---

### Task 3: The write service

**Files:**
- Create: `lib/bookings/rpc-errors.ts`, `lib/bookings/rpc-errors.test.ts`, `lib/bookings/service.ts`, `lib/bookings/service.test.ts`

**Interfaces:**
- Consumes: `book_free_tickets` (Task 1); `Caller`, `mayCancel`, `CancellableBooking` (Task 2); `cancel_booking(p_booking_id uuid, p_reason text)` from Phase 0
- Produces:
  - `mapBookingRpcError(error: PostgrestError): string`
  - `bookFreeTickets(caller: Caller, ticketTypeId: string, quantity: number, attendeeName: string, note?: string): Promise<BookingResult>` where `type BookingResult = { ok: true; reference: string } | { ok: false; error: string }`
  - `cancelBooking(caller: Caller, bookingId: string, reason?: string): Promise<CancelResult>` where `type CancelResult = { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the error-mapper test**

```ts
// lib/bookings/rpc-errors.test.ts
import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'

function pgError(overrides: Partial<PostgrestError>): PostgrestError {
  return {
    name: 'PostgrestError',
    message: 'something went wrong',
    details: '',
    hint: '',
    code: 'XX000',
    ...overrides,
  } as PostgrestError
}

describe('mapBookingRpcError', () => {
  it('explains EH010 without naming a column', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH010' }))).toBe(
      'This event is not free yet, so booking has not opened.',
    )
  })

  it('explains EH011 in the host\'s terms', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH011' }))).toBe(
      'This host approves guests before booking, which is not available yet.',
    )
  })

  it('tells an attendee who already booked what to do about it', () => {
    // Not "duplicate key value violates unique constraint". The attendee's
    // next move is in the sentence, because there is a screen for it.
    expect(mapBookingRpcError(pgError({ code: 'EH012' }))).toBe(
      'You have already booked this event. Cancel that booking first to change it.',
    )
  })

  it('explains EH013 without a timestamp', () => {
    expect(mapBookingRpcError(pgError({ code: 'EH013' }))).toBe('This event has already started.')
  })

  it('passes reserve_tickets\' own message through untouched', () => {
    // These are already written for a person: "only 3 seats remain",
    // "sales have closed". Remapping them would lose the number.
    expect(
      mapBookingRpcError(pgError({ code: '23514', message: 'only 3 seats remain' })),
    ).toBe('only 3 seats remain')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run lib/bookings/rpc-errors.test.ts
```

Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `lib/bookings/rpc-errors.ts`**

```ts
import type { PostgrestError } from '@supabase/supabase-js'

/** The ticket type is not free. Payment is Phase 3. */
const NOT_FREE = 'EH010'
/** The event requires host approval. That flow is Phase 5. */
const NEEDS_APPROVAL = 'EH011'
/** This attendee already holds an active booking on this event. */
const ALREADY_BOOKED = 'EH012'
/** The event has started. */
const STARTED = 'EH013'

/**
 * Turns a refusal from book_free_tickets into a sentence an attendee can read.
 *
 * Only the two guards this phase added are remapped. Everything reserve_tickets
 * raises — "only 3 seats remain", "sales have closed", "cannot book more than 10
 * per order" — is already written for a person and carries a number the
 * attendee needs, so it passes through rather than being flattened into
 * something generic.
 */
export function mapBookingRpcError(error: PostgrestError): string {
  if (error.code === NOT_FREE) return 'This event is not free yet, so booking has not opened.'
  if (error.code === NEEDS_APPROVAL) {
    return 'This host approves guests before booking, which is not available yet.'
  }
  if (error.code === ALREADY_BOOKED) {
    // Names the next move, because there is a screen for it: /bookings.
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
  if (error.code === STARTED) return 'This event has already started.'
  return error.message
}
```

- [ ] **Step 4: Write the service integration test**

```ts
// lib/bookings/service.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import { bookFreeTickets, cancelBooking } from '@/lib/bookings/service'

const db = adminClient()
let event: SeededEvent
let strangerId: string
/** Every attendee this file mints, so afterAll can clear them. */
const minted: string[] = []

/** Application code cannot fabricate a Caller; a test may. */
function callerOf(id: string): Caller {
  return { id } as Caller
}

/**
 * A brand-new attendee.
 *
 * One active booking per attendee per event is enforced by
 * bookings_one_active_per_attendee, so a test that reuses one attendee for two
 * bookings on the same event fails on the index rather than on what it meant to
 * assert. Every booking below therefore gets its own person.
 */
async function newAttendee(): Promise<string> {
  const { createTestUser } = await import('@/tests/helpers/db')
  const id = await createTestUser(db)
  minted.push(id)
  return id
}

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
  strangerId = await newAttendee()
})

afterAll(async () => {
  await cleanupEvent(db, event)
  for (const id of minted) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('bookFreeTickets', () => {
  it('returns the reference a host reads at the door', async () => {
    const result = await bookFreeTickets(
      callerOf(event.attendeeId),
      event.ticketTypeId,
      2,
      'Priya',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reference).toMatch(/^[0-9A-HJ-NP-TV-Z]{8}$/)
  })

  it('books for the caller, never for an id it was handed', async () => {
    // The signature has no attendee-id parameter at all. This asserts the row
    // that lands carries the caller's id, so a future refactor that adds one
    // and threads a form field through it fails here.
    const result = await bookFreeTickets(callerOf(strangerId), event.ticketTypeId, 1, 'Stranger')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { data } = await db
      .from('bookings')
      .select('attendee_id, attendee_name')
      .eq('reference', result.reference)
      .single()
    expect(data!.attendee_id).toBe(strangerId)
    expect(data!.attendee_name).toBe('Stranger')
  })

  it('reports a refusal as a sentence, not a constraint', async () => {
    const result = await bookFreeTickets(
      callerOf(await newAttendee()),
      event.ticketTypeId,
      99,
      'Hopeful',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('seats remain')
  })

  it('tells a repeat booker what to do instead of showing them an index name', async () => {
    const twice = await newAttendee()
    const first = await bookFreeTickets(callerOf(twice), event.ticketTypeId, 1, 'Priya')
    expect(first.ok).toBe(true)

    const second = await bookFreeTickets(callerOf(twice), event.ticketTypeId, 1, 'Priya')

    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error).toBe(
      'You have already booked this event. Cancel that booking first to change it.',
    )
  })
})

describe('cancelBooking', () => {
  /** A booking by a fresh attendee, so the one-active-booking rule is never in play. */
  async function freshBooking(): Promise<{ bookingId: string; attendeeId: string }> {
    const attendeeId = await newAttendee()
    const result = await bookFreeTickets(callerOf(attendeeId), event.ticketTypeId, 1, 'Guest')
    if (!result.ok) throw new Error(`setup booking failed: ${result.error}`)
    const { data } = await db
      .from('bookings')
      .select('id')
      .eq('reference', result.reference)
      .single()
    return { bookingId: data!.id, attendeeId }
  }

  it('lets the attendee cancel and returns the seat', async () => {
    const { bookingId, attendeeId } = await freshBooking()
    const { data: before } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', event.ticketTypeId)
      .single()

    const result = await cancelBooking(callerOf(attendeeId), bookingId)
    expect(result.ok).toBe(true)

    const { data: after } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', event.ticketTypeId)
      .single()
    expect(after!.reserved_count).toBe(before!.reserved_count - 1)
  })

  it('lets a cancelled attendee book again', async () => {
    // The rule is one *active* booking, not one ever. If this fails, the index
    // predicate is wider than the active statuses.
    const { bookingId, attendeeId } = await freshBooking()
    await cancelBooking(callerOf(attendeeId), bookingId)

    const again = await bookFreeTickets(callerOf(attendeeId), event.ticketTypeId, 2, 'Guest')
    expect(again.ok).toBe(true)
  })

  it('lets the host of the event cancel it', async () => {
    const { bookingId } = await freshBooking()

    const result = await cancelBooking(callerOf(event.hostProfileId), bookingId)

    expect(result.ok).toBe(true)
    const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
    expect(data!.status).toBe('cancelled')
  })

  it('refuses a stranger, writing nothing', async () => {
    // RLS is not in this path — the write goes through the service role — so
    // this assertion is the only thing standing between a stranger and someone
    // else's seat.
    const { bookingId, attendeeId } = await freshBooking()

    const result = await cancelBooking(callerOf(strangerId), bookingId)

    expect(result.ok).toBe(false)
    const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
    expect(data!.status).toBe('confirmed')

    await cancelBooking(callerOf(attendeeId), bookingId)
  })

  it('refuses a booking that does not exist without leaking that fact', async () => {
    const result = await cancelBooking(
      callerOf(event.attendeeId),
      '00000000-0000-0000-0000-000000000000',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('That booking is not yours to cancel.')
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

```bash
npx vitest run lib/bookings/service.test.ts
```

Expected: FAIL — unresolved import `@/lib/bookings/service`.

- [ ] **Step 6: Write `lib/bookings/service.ts`**

```ts
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { mayCancel } from '@/lib/bookings/authorize'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'
import type { Caller } from '@/lib/bookings/caller'

/**
 * Every booking write in the product, and the only file allowed to hold the
 * service role.
 *
 * `bookings` and `tickets` have no write grant to `authenticated` on purpose —
 * 20260808000003 says inventory and money "can never be mutated by a crafted
 * PostgREST call" — so the functions that write them are unreachable from a
 * browser and must be called as the service role instead.
 *
 * Which means RLS does not scope anything below. It filters reads; it does not
 * see these writes at all. Every authorisation decision in this file is the
 * whole of the rule, and a missing one is a stranger cancelling someone's seat
 * rather than an ordinary bug. eslint.config.mjs stops a second file joining
 * this one, so there is one place to audit rather than a grep.
 *
 * Identity is a `Caller`, never a string: nothing outside lib/bookings/caller.ts
 * can produce one, so a form field cannot become an attendee id.
 */

export type BookingResult = { ok: true; reference: string } | { ok: false; error: string }
export type CancelResult = { ok: true } | { ok: false; error: string }

/** Deliberately identical for "not yours" and "does not exist". */
const NOT_YOURS = 'That booking is not yours to cancel.'

export async function bookFreeTickets(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  note?: string,
): Promise<BookingResult> {
  const db = createAdminClient()

  const { data, error } = await db.rpc('book_free_tickets', {
    p_ticket_type_id: ticketTypeId,
    // The caller's own id. There is no parameter through which a request could
    // supply someone else's, and there must never be one.
    p_attendee_id: caller.id,
    p_quantity: quantity,
    // What the host will read at the door. Free text the attendee chose, not an
    // identity claim — profiles are unreadable to a host and full_name is null
    // for everyone, so this is the only name there is.
    p_attendee_name: attendeeName,
    p_attendee_note: note ?? null,
  })

  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: (data as unknown as { reference: string }).reference }
}

export async function cancelBooking(
  caller: Caller,
  bookingId: string,
  reason?: string,
): Promise<CancelResult> {
  const db = createAdminClient()

  const { data: booking } = await db
    .from('bookings')
    .select('id, attendee_id, events(hosts(profile_id))')
    .eq('id', bookingId)
    .maybeSingle()

  // Same answer for a booking that is not theirs and one that does not exist.
  // Distinguishing them turns this into an oracle for whether a given id is a
  // real booking, which is not something a stranger needs to know.
  if (!booking) return { ok: false, error: NOT_YOURS }

  const hostProfileId =
    (booking as unknown as { events: { hosts: { profile_id: string } | null } | null }).events
      ?.hosts?.profile_id ?? ''

  if (!mayCancel(caller, { attendee_id: booking.attendee_id, event_host_profile_id: hostProfileId })) {
    return { ok: false, error: NOT_YOURS }
  }

  const { error } = await db.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_reason: reason ?? null,
  })

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
```

- [ ] **Step 7: Run both tests**

```bash
npx vitest run lib/bookings/rpc-errors.test.ts lib/bookings/service.test.ts
```

Expected: PASS, 5 + 10 tests.

- [ ] **Step 8: Confirm the lint rule allows exactly this file**

```bash
npx eslint
```

Expected: clean. `lib/bookings/service.ts` is in the rule's `ignores`; nothing else imports `admin.ts`.

- [ ] **Step 9: Commit**

```bash
git add lib/bookings/rpc-errors.ts lib/bookings/rpc-errors.test.ts lib/bookings/service.ts lib/bookings/service.test.ts
git commit
```

---

### Task 4: Booking reads

**Files:**
- Create: `lib/bookings/queries.ts`, `lib/bookings/queries.test.ts`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server`; the RLS policies `bookings_select_own` and the host-side policy in `20260808000003_rls_policies.sql`
- Produces:
  - `interface MyBooking { id: string; reference: string; quantity: number; status: string; created_at: string; events: { slug: string; title: string; starts_at: string; city: string; venue_name: string | null } | null }`
  - `listMyBookings(): Promise<MyBooking[]>`
  - `getBookingByReference(reference: string): Promise<MyBooking | null>`
  - `interface EventAttendee { id: string; reference: string; attendee_name: string | null; quantity: number; status: string; created_at: string }`
  - `listEventAttendees(eventId: string): Promise<EventAttendee[]>`

**No `profiles` embed.** An earlier draft of this plan selected `profiles(full_name, phone)`; `profiles_select_own` is `id = auth.uid()` and the embed returns `null` for every attendee without erroring, so the guest list would have rendered "Guest" for everyone while passing every row-counting test. The name comes off the booking instead.

- [ ] **Step 1: Write the failing test**

```ts
// lib/bookings/queries.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock
import type { Caller } from '@/lib/bookings/caller'

const { listMyBookings, getBookingByReference, listEventAttendees } = await import(
  '@/lib/bookings/queries'
)
const { bookFreeTickets } = await import('@/lib/bookings/service')

const db = adminClient()
let event: SeededEvent
let strangerId: string
let reference: string

function callerOf(id: string): Caller {
  return { id } as Caller
}

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
  strangerId = await createTestUser(db)

  const result = await bookFreeTickets(callerOf(event.attendeeId), event.ticketTypeId, 2, 'Priya')
  if (!result.ok) throw new Error(`setup booking failed: ${result.error}`)
  reference = result.reference
})

afterAll(async () => {
  await cleanupEvent(db, event)
  await db.auth.admin.deleteUser(strangerId).catch(() => {})
})

describe('listMyBookings', () => {
  it('returns the attendee\'s own bookings with their event', async () => {
    signInAs(event.attendeeId)
    const bookings = await listMyBookings()

    expect(bookings).toHaveLength(1)
    expect(bookings[0].reference).toBe(reference)
    expect(bookings[0].events?.title).toBe('Test Supper Club')
  })

  it('returns nothing for someone else', async () => {
    // RLS, not a filter we wrote: bookings_select_own scopes on auth.uid().
    signInAs(strangerId)
    expect(await listMyBookings()).toHaveLength(0)
  })

  it('returns nothing when signed out', async () => {
    signInAs(null)
    expect(await listMyBookings()).toHaveLength(0)
  })
})

describe('getBookingByReference', () => {
  it('finds the attendee\'s own booking', async () => {
    signInAs(event.attendeeId)
    const booking = await getBookingByReference(reference)
    expect(booking?.quantity).toBe(2)
  })

  it('returns null for a stranger holding the reference', async () => {
    // The reference is short and quotable, so it will be overheard. It must not
    // be a password.
    signInAs(strangerId)
    expect(await getBookingByReference(reference)).toBeNull()
  })
})

describe('listEventAttendees', () => {
  it('lets the host see who is coming, by name', async () => {
    signInAs(event.hostProfileId)
    const attendees = await listEventAttendees(event.eventId)

    expect(attendees).toHaveLength(1)
    expect(attendees[0].quantity).toBe(2)
    // The assertion this file exists for. Counting rows cannot tell a working
    // guest list from one where every row reads "Guest" — which is exactly what
    // the profiles embed this replaced would have produced.
    expect(attendees[0].attendee_name).toBe('Priya')
  })

  it('shows another host nothing', async () => {
    signInAs(strangerId)
    expect(await listEventAttendees(event.eventId)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run lib/bookings/queries.test.ts
```

Expected: FAIL — unresolved import `@/lib/bookings/queries`.

- [ ] **Step 3: Write `lib/bookings/queries.ts`**

```ts
import 'server-only'
import { createClient } from '@/lib/supabase/server'

/**
 * Every booking read, on the RLS-scoped client.
 *
 * Deliberately not in lib/bookings/service.ts. Reads are the half of this
 * feature that RLS still protects — bookings_select_own scopes an attendee to
 * their own rows, and the host policy scopes a host to their own events — so
 * they have no business sharing a module with the service-role writes. Keeping
 * them apart is what makes "which of these bypasses RLS?" answerable by which
 * file you are in.
 */

const BOOKING_COLUMNS =
  'id, reference, quantity, status, created_at, events(slug, title, starts_at, city, venue_name)'

export interface MyBooking {
  id: string
  reference: string
  quantity: number
  status: string
  created_at: string
  events: {
    slug: string
    title: string
    starts_at: string
    city: string
    venue_name: string | null
  } | null
}

/** The signed-in attendee's bookings, newest first. Empty when signed out. */
export async function listMyBookings(): Promise<MyBooking[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Could not load your bookings: ${error.message}`)
  return (data ?? []) as unknown as MyBooking[]
}

/**
 * One booking by its reference.
 *
 * Scoped by RLS alone, which is the point: the reference is eight characters a
 * host reads aloud at a door, so it will be overheard. It identifies a booking;
 * it does not authorise seeing one.
 */
export async function getBookingByReference(reference: string): Promise<MyBooking | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_COLUMNS)
    .eq('reference', reference)
    .maybeSingle()

  if (error) throw new Error(`Could not load that booking: ${error.message}`)
  return (data as unknown as MyBooking | null) ?? null
}

export interface EventAttendee {
  id: string
  reference: string
  attendee_name: string | null
  quantity: number
  status: string
  created_at: string
}

/**
 * Who is coming to one event. Empty unless the caller hosts it.
 *
 * The name comes off the booking, not off `profiles`. `profiles_select_own` is
 * `id = auth.uid()`, so a host embedding `profiles(...)` here gets `null` on
 * every row and no error — a guest list that looks populated and identifies
 * nobody. `profiles.full_name` is also null for every user alive, since the
 * signup trigger writes only `id` and `phone`. `bookings.attendee_name` is what
 * the attendee typed, and it is the only name in the system.
 */
export async function listEventAttendees(eventId: string): Promise<EventAttendee[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('bookings')
    .select('id, reference, attendee_name, quantity, status, created_at')
    .eq('event_id', eventId)
    .eq('status', 'confirmed')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Could not load the guest list: ${error.message}`)
  return (data ?? []) as unknown as EventAttendee[]
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run lib/bookings/queries.test.ts
```

Expected: PASS, 7 tests.

**If `listEventAttendees` returns rows for the stranger,** the host-side booking policy is wider than assumed — stop and report it. That is a real RLS finding, not a test to adjust.

- [ ] **Step 5: Commit**

```bash
git add lib/bookings/queries.ts lib/bookings/queries.test.ts
git commit
```

---

### Task 5: The Book control on the public event page

**Files:**
- Create: `app/e/[slug]/book-panel.tsx`, `app/e/[slug]/actions.ts`
- Modify: `app/e/[slug]/page.tsx:322-347`

**Interfaces:**
- Consumes: `bookFreeTickets` (Task 3), `currentCaller` (Task 2), `loginPath()` from `@/lib/auth/session`
- Produces: Server Action `bookEvent(previous: BookState, formData: FormData): Promise<BookState>` where `interface BookState { error?: string }`

- [ ] **Step 1: Write the Server Action**

```tsx
// app/e/[slug]/actions.ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { currentCaller } from '@/lib/bookings/caller'
import { bookFreeTickets } from '@/lib/bookings/service'
import { loginPath } from '@/lib/auth/session'

export interface BookState {
  error?: string
}

/**
 * Note what this does not read from the form: who is booking. That comes from
 * currentCaller() and cannot come from anywhere else — see lib/bookings/caller.ts.
 */
export async function bookEvent(_previous: BookState, formData: FormData): Promise<BookState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const ticketTypeId = String(formData.get('ticketTypeId') ?? '')
  if (!ticketTypeId) return { error: 'Something went wrong. Reload the page and try again.' }

  // Parsed rather than trusted: the picker offers 1..max_per_order, but a
  // handcrafted POST is not obliged to. reserve_tickets enforces the real cap;
  // this only keeps a non-number from reaching Postgres as `NaN`.
  const quantity = Number(formData.get('quantity'))
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'Choose how many seats you need.' }
  }

  // The only name the host will ever see: profiles are unreadable to them and
  // full_name is null for everyone. Capped here as well as by maxLength on the
  // input, which a handcrafted POST ignores.
  const attendeeName = String(formData.get('attendeeName') ?? '').trim().slice(0, 80)
  if (!attendeeName) return { error: 'Tell the host who to expect.' }

  const result = await bookFreeTickets(caller, ticketTypeId, quantity, attendeeName)
  if (!result.ok) return { error: result.error }

  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`) // the seats-left count just moved
  redirect(`/bookings/${result.reference}`)
}
```

- [ ] **Step 2: Write the client panel**

```tsx
// app/e/[slug]/book-panel.tsx
'use client'

import { useActionState } from 'react'
import { bookEvent, type BookState } from './actions'

const MIST = '#E7E2D8'
const SLATE = '#6B6560'

interface Props {
  ticketTypeId: string
  slug: string
  /** Upper bound of the picker: min(seats left, max_per_order). */
  maxSeats: number
  priceLabel: string
  seatsLabel: string
}

/**
 * The bottom bar's live half. A Client Component because the quantity picker
 * and the pending state need state; the page around it stays a Server
 * Component, so the event itself is still server-rendered for the WhatsApp
 * crawler.
 */
export function BookPanel({ ticketTypeId, slug, maxSeats, priceLabel, seatsLabel }: Props) {
  const [state, action, pending] = useActionState<BookState, FormData>(bookEvent, {})

  return (
    <form action={action} className="mx-auto flex max-w-2xl items-center justify-between gap-3">
      <input type="hidden" name="ticketTypeId" value={ticketTypeId} />
      <input type="hidden" name="slug" value={slug} />

      <div className="min-w-0">
        <p className="font-mono text-[19px] leading-tight font-semibold">{priceLabel}</p>
        <p className="font-mono text-[12px]" style={{ color: SLATE }}>
          {state.error ?? seatsLabel}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <label className="sr-only" htmlFor="attendeeName">
          Your name
        </label>
        <input
          id="attendeeName"
          name="attendeeName"
          type="text"
          required
          maxLength={80}
          placeholder="Your name"
          disabled={pending}
          className="w-28 rounded-lg border px-3 py-3 text-[15px]"
          style={{ borderColor: MIST }}
        />

        <label className="sr-only" htmlFor="quantity">
          Seats
        </label>
        <select
          id="quantity"
          name="quantity"
          defaultValue="1"
          disabled={pending}
          className="rounded-lg border px-3 py-3 font-mono text-[15px]"
          style={{ borderColor: MIST }}
        >
          {Array.from({ length: maxSeats }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg px-5 py-3 text-[15px] font-medium text-white disabled:opacity-60"
          style={{ backgroundColor: '#1B1917' }}
        >
          {pending ? 'Booking…' : 'Book'}
        </button>
      </div>
    </form>
  )
}
```

- [ ] **Step 3: Wire it into the page**

In `app/e/[slug]/page.tsx`, add near the other derived values around line 162:

```tsx
  // Phase 2a books free, no-approval events only. Anything else keeps the inert
  // control Phase 1 shipped: a host who set a price or ticked approval has built
  // something this phase cannot honour, and saying so is better than confirming
  // strangers at their door or letting people in free.
  //
  // `finished` mirrors the EH013 guard in book_free_tickets. The feed already
  // hides past events, but this page is reached by a link in a WhatsApp group
  // that outlives the event, so it is the surface where a finished event is
  // actually met.
  const finished = new Date(event.starts_at).getTime() <= Date.now()
  const bookable =
    !!ticket && !soldOut && !finished && ticket.price_paise === 0 && !event.requires_approval
  const maxSeats = ticket ? Math.max(1, Math.min(remaining, ticket.max_per_order ?? 10)) : 1
```

Then replace the contents of the fixed bottom bar (`page.tsx:329-346`, the inner `<div className="mx-auto flex …">` through its closing tag) with:

```tsx
        {bookable && ticket ? (
          <BookPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={maxSeats}
            priceLabel="Free"
            seatsLabel={seatsLabel}
          />
        ) : (
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-[19px] leading-tight font-semibold">
                {ticket ? (ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)) : '—'}
              </p>
              <p className="font-mono text-[12px]" style={{ color: SLATE }}>
                {seatsLabel}
              </p>
            </div>
            <button
              type="button"
              disabled
              className="shrink-0 rounded-lg border px-5 py-3 text-[15px] font-medium"
              style={{ borderColor: MIST, backgroundColor: '#F2EFE9', color: SLATE }}
            >
              {finished ? 'This event has finished' : soldOut ? 'Sold out' : 'Booking opens soon'}
            </button>
          </div>
        )}
```

Add `import { BookPanel } from './book-panel'` to the page's imports. Delete the now-stale comment at `page.tsx:322-324` that says "Booking is Phase 2. The control is present but inert" — it describes half the branches now, and this repo treats a comment that no longer matches the code as a defect.

- [ ] **Step 4: `getPublishedEventBySlug` must return the fields the panel needs**

`lib/events/queries.ts`'s `FEED_COLUMNS` selects `ticket_types(price_paise, quantity, reserved_count)` — no `id`, no `max_per_order`. Add both, and extend the `FeedEvent` interface's `ticket_types` element type to match:

```ts
const FEED_COLUMNS =
  'id, slug, title, cover_image_url, city, venue_name, starts_at, ticket_types(id, price_paise, quantity, reserved_count, max_per_order)'
```

```ts
  ticket_types: Array<{
    id: string
    price_paise: number
    quantity: number
    reserved_count: number
    max_per_order: number
  }>
```

`HostEvent` and `OwnedEvent` declare their own `ticket_types` shape and their own column lists; leave those alone. Run `npx tsc --noEmit` and fix any call site the widened type breaks.

- [ ] **Step 5: Verify by hand in the browser**

```bash
npm run dev
```

Seed a free published event, open `/e/<slug>` signed out, and check: picker present, Book redirects to `/login?next=/e/<slug>`, and after signing in you land back on the event page. Then book and confirm the redirect to `/bookings/<reference>`. Record what you saw in your report — this is the first task with no automated coverage of its own, and the redirect chain is the part most likely to be subtly wrong.

- [ ] **Step 6: Run the full suite, typecheck and lint**

```bash
npm test && npm run typecheck && npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add app/e/ lib/events/queries.ts
git commit
```

---

### Task 6: Attendee pages

**Files:**
- Create: `app/bookings/page.tsx`, `app/bookings/[reference]/page.tsx`, `app/bookings/actions.ts`

**Interfaces:**
- Consumes: `listMyBookings`, `getBookingByReference` (Task 4); `cancelBooking` (Task 3); `currentCaller` (Task 2); `requireUser()` from `@/lib/auth/session`
- Produces: Server Action `cancelMyBooking(previous: CancelState, formData: FormData): Promise<CancelState>` where `interface CancelState { error?: string }`

- [ ] **Step 1: Write the cancel action**

```tsx
// app/bookings/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { cancelBooking } from '@/lib/bookings/service'
import { loginPath } from '@/lib/auth/session'

export interface CancelState {
  error?: string
}

export async function cancelMyBooking(
  _previous: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  if (!bookingId) return { error: 'Something went wrong. Reload the page and try again.' }

  // cancelBooking re-checks who the caller is against the booking. Being signed
  // in is not the same as being entitled to this row, and RLS is not in this
  // path to make the difference for us.
  const result = await cancelBooking(caller, bookingId, 'cancelled by attendee')
  if (!result.ok) return { error: result.error }

  revalidatePath('/bookings')
  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`) // the seat is back
  return {}
}
```

- [ ] **Step 2: Write the confirmation page**

```tsx
// app/bookings/[reference]/page.tsx
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { getBookingByReference } from '@/lib/bookings/queries'
import { formatIst } from '@/lib/events/datetime'

export default async function BookingPage(props: PageProps<'/bookings/[reference]'>) {
  const { reference } = await props.params
  await requireUser()

  const booking = await getBookingByReference(reference)
  // RLS already refused someone else's booking, so "not found" and "not yours"
  // arrive here as the same thing — which is what we want them to look like.
  if (!booking) notFound()

  const event = booking.events

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <p className="font-mono text-[13px] tracking-wide text-neutral-500">
        {booking.status === 'confirmed' ? "You're going" : `Booking ${booking.status}`}
      </p>

      <h1 className="mt-2 text-2xl font-semibold">{event?.title ?? 'Event'}</h1>

      <dl className="mt-8 space-y-4 font-mono text-[14px]">
        <div>
          <dt className="text-neutral-500">Reference</dt>
          {/* The string a host reads aloud at the door. Big, and selectable. */}
          <dd className="text-[22px] font-semibold tracking-[0.2em] select-all">
            {booking.reference}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Seats</dt>
          <dd>{booking.quantity}</dd>
        </div>
        {event && (
          <>
            <div>
              <dt className="text-neutral-500">When</dt>
              {/* formatIst takes a Date; starts_at arrives as an ISO string. */}
              <dd>{formatIst(new Date(event.starts_at))}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Where</dt>
              <dd>{[event.venue_name, event.city].filter(Boolean).join(', ')}</dd>
            </div>
          </>
        )}
      </dl>

      <div className="mt-10 flex gap-4 text-[14px]">
        <Link href="/bookings" className="underline">
          All your bookings
        </Link>
        {event && (
          <Link href={`/e/${event.slug}`} className="underline">
            Event page
          </Link>
        )}
      </div>
    </main>
  )
}
```

`lib/events/datetime.ts` exports `formatIst(date: Date)`, `formatIstDateOnly(date: Date)`, `istLocalToUtc` and `utcToIstLocal`. There is no string-taking formatter, which is why every call site above wraps `starts_at` in `new Date(...)`. Do not add a second formatter.

- [ ] **Step 3: Write the bookings list**

```tsx
// app/bookings/page.tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { listMyBookings } from '@/lib/bookings/queries'
import { formatIst } from '@/lib/events/datetime'
import { CancelButton } from './cancel-button'

export default async function BookingsPage() {
  await requireUser()
  const bookings = await listMyBookings()

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <h1 className="text-2xl font-semibold">Your bookings</h1>

      {bookings.length === 0 ? (
        <p className="mt-8 text-[15px] text-neutral-600">
          Nothing booked yet.{' '}
          <Link href="/" className="underline">
            Find something on
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-8 space-y-4">
          {bookings.map((booking) => (
            <li key={booking.id} className="rounded-xl border p-4">
              <Link href={`/bookings/${booking.reference}`} className="font-medium underline">
                {booking.events?.title ?? 'Event'}
              </Link>
              <p className="mt-1 font-mono text-[13px] text-neutral-600">
                {booking.events && formatIst(new Date(booking.events.starts_at))} ·{' '}
                {booking.quantity} {booking.quantity === 1 ? 'seat' : 'seats'} · {booking.status}
              </p>
              {booking.status === 'confirmed' && (
                <CancelButton bookingId={booking.id} slug={booking.events?.slug ?? ''} />
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 4: Write the cancel button**

```tsx
// app/bookings/cancel-button.tsx
'use client'

import { useActionState } from 'react'
import { cancelMyBooking, type CancelState } from './actions'

/**
 * Its own Client Component so one cancel's pending and error state belongs to
 * one row. A single form around the list would make every row spin when any one
 * of them was submitted.
 */
export function CancelButton({ bookingId, slug }: { bookingId: string; slug: string }) {
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelMyBooking, {})

  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="slug" value={slug} />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] underline disabled:opacity-60"
      >
        {pending ? 'Cancelling…' : 'Cancel booking'}
      </button>
      {state.error && <p className="mt-1 text-[13px] text-red-700">{state.error}</p>}
    </form>
  )
}
```

- [ ] **Step 5: Verify by hand**

```bash
npm run dev
```

Book two seats, open `/bookings`, cancel, and confirm the row's status changes and the event page's seats-left count goes back up. Report what you saw.

- [ ] **Step 6: Run the full suite, typecheck and lint**

```bash
npm test && npm run typecheck && npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add app/bookings/
git commit
```

---

### Task 7: The host's guest list

**Files:**
- Create: `app/host/events/[id]/attendees/page.tsx`, `app/host/events/[id]/attendees/actions.ts`, `app/host/events/[id]/attendees/cancel-attendee-button.tsx`
- Modify: `app/host/events/[id]/edit/page.tsx` — add a link to the guest list

**Interfaces:**
- Consumes: `listEventAttendees` (Task 4); `cancelBooking` (Task 3); `currentCaller` (Task 2); `getOwnedEvent` from `@/lib/events/queries`
- Produces: Server Action `cancelAttendeeBooking(previous: CancelState, formData: FormData): Promise<CancelState>`

- [ ] **Step 1: Write the action**

```tsx
// app/host/events/[id]/attendees/actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { cancelBooking } from '@/lib/bookings/service'
import { loginPath } from '@/lib/auth/session'

export interface CancelState {
  error?: string
}

export async function cancelAttendeeBooking(
  _previous: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  const eventId = String(formData.get('eventId') ?? '')
  if (!bookingId) return { error: 'Something went wrong. Reload the page and try again.' }

  // The same mayCancel() the attendee's own cancel goes through. A host is
  // entitled here only because they host *this* event, and `eventId` arrives
  // from a form — so it is used for revalidation and never for the decision.
  const result = await cancelBooking(caller, bookingId, 'cancelled by host')
  if (!result.ok) return { error: result.error }

  if (eventId) revalidatePath(`/host/events/${eventId}/attendees`)
  return {}
}
```

- [ ] **Step 2: Write the cancel button**

```tsx
// app/host/events/[id]/attendees/cancel-attendee-button.tsx
'use client'

import { useActionState } from 'react'
import { cancelAttendeeBooking, type CancelState } from './actions'

export function CancelAttendeeButton({
  bookingId,
  eventId,
}: {
  bookingId: string
  eventId: string
}) {
  const [state, action, pending] = useActionState<CancelState, FormData>(
    cancelAttendeeBooking,
    {},
  )

  return (
    <form action={action}>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="eventId" value={eventId} />
      <button type="submit" disabled={pending} className="text-[13px] underline disabled:opacity-60">
        {pending ? 'Cancelling…' : 'Cancel'}
      </button>
      {state.error && <p className="mt-1 text-[13px] text-red-700">{state.error}</p>}
    </form>
  )
}
```

- [ ] **Step 3: Write the page**

```tsx
// app/host/events/[id]/attendees/page.tsx
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { getOwnedEvent } from '@/lib/events/queries'
import { listEventAttendees } from '@/lib/bookings/queries'
import { CancelAttendeeButton } from './cancel-attendee-button'

export default async function AttendeesPage(
  props: PageProps<'/host/events/[id]/attendees'>,
) {
  const { id } = await props.params
  await requireUser()

  // getOwnedEvent scopes on host_id, so this is also the ownership check for
  // the page: a host who does not own this event gets a 404 rather than an
  // empty guest list, which would read as "nobody is coming".
  const event = await getOwnedEvent(id)
  if (!event) notFound()

  const attendees = await listEventAttendees(id)
  const seats = attendees.reduce((total, a) => total + a.quantity, 0)

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <Link href={`/host/events/${id}/edit`} className="font-mono text-[13px] underline">
        ← {event.title}
      </Link>

      <h1 className="mt-4 text-2xl font-semibold">Guest list</h1>
      <p className="mt-1 font-mono text-[13px] text-neutral-600">
        {seats} {seats === 1 ? 'seat' : 'seats'} taken by {attendees.length}{' '}
        {attendees.length === 1 ? 'booking' : 'bookings'}
      </p>

      {attendees.length === 0 ? (
        <p className="mt-8 text-[15px] text-neutral-600">Nobody has booked yet.</p>
      ) : (
        <ul className="mt-8 divide-y">
          {attendees.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                {/* What the attendee typed when booking. Nullable because
                    Phase 3 and Phase 5 booking paths do not collect it, so a
                    fallback is needed even though 2a always writes one.
                    No phone number: a host gets the name a guest chose to give,
                    and nothing they did not. */}
                <p className="truncate font-medium">{a.attendee_name ?? 'Guest'}</p>
                <p className="font-mono text-[12px] text-neutral-600">
                  {a.quantity} {a.quantity === 1 ? 'seat' : 'seats'} · {a.reference}
                </p>
              </div>
              <CancelAttendeeButton bookingId={a.id} eventId={id} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 4: Link to it from the edit page**

In `app/host/events/[id]/edit/page.tsx`, add a link to `/host/events/${id}/attendees` near the publish panel. Match the surrounding markup rather than inventing a style; read the file first.

- [ ] **Step 5: Verify by hand**

```bash
npm run dev
```

As the host, open the guest list, confirm the seat total matches the event page's "seats left", cancel one booking, and confirm both numbers move. Report what you saw.

- [ ] **Step 6: Run the full suite, typecheck and lint**

```bash
npm test && npm run typecheck && npm run lint
```

- [ ] **Step 7: Commit**

```bash
git add app/host/events/
git commit
```

---

### Task 8: The concurrency test, and `EH001` reached for the first time

**Files:**
- Create: `lib/bookings/concurrency.test.ts`
- Test: `lib/bookings/concurrency.test.ts`

**Interfaces:**
- Consumes: `bookFreeTickets` (Task 3); `updateEvent` from `@/app/host/events/actions`
- Produces: nothing further depends on this task

The v1 spec calls this test mandatory before Phase 3. It is written here because this is the first phase in which the real booking entry point exists to fire it at.

- [ ] **Step 1: Write the test**

```ts
// lib/bookings/concurrency.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import { bookFreeTickets } from '@/lib/bookings/service'

const db = adminClient()
let event: SeededEvent

function callerOf(id: string): Caller {
  return { id } as Caller
}

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published', maxPerOrder: 1 })
})

afterAll(async () => {
  await cleanupEvent(db, event)
})

describe('booking concurrency', () => {
  it('sells exactly ten seats to fifty simultaneous buyers', async () => {
    // The v1 spec's mandatory test. The row lock in reserve_tickets is what
    // makes this pass; without it, fifty readers all see ten seats free and
    // fifty bookings land on a ten-seat event.
    const buyers = await Promise.all(Array.from({ length: 50 }, () => createTestUser(db)))

    const results = await Promise.all(
      // Fifty distinct attendees, so the one-active-booking index is not what
      // limits this — the row lock in reserve_tickets is.
      buyers.map((id, i) => bookFreeTickets(callerOf(id), event.ticketTypeId, 1, `Buyer ${i}`)),
    )

    const won = results.filter((r) => r.ok)
    expect(won).toHaveLength(10)

    const { data: tt } = await db
      .from('ticket_types')
      .select('quantity, reserved_count')
      .eq('id', event.ticketTypeId)
      .single()
    expect(tt!.reserved_count).toBe(10)
    expect(tt!.reserved_count).toBeLessThanOrEqual(tt!.quantity)

    const { data: bookings } = await db
      .from('bookings')
      .select('id')
      .eq('event_id', event.eventId)
      .eq('status', 'confirmed')
    expect(bookings).toHaveLength(10)

    // One ticket row per seat sold, no more.
    const { count } = await db
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .in('booking_id', (bookings ?? []).map((b) => b.id))
    expect(count).toBe(10)

    for (const id of buyers) await db.auth.admin.deleteUser(id).catch(() => {})
  }, 60_000)
})
```

- [ ] **Step 2: Run it**

```bash
npx vitest run lib/bookings/concurrency.test.ts
```

Expected: PASS. **If more than 10 succeed, stop everything and report it** — that is an overselling bug in the inventory path, and nothing else in this plan matters until it is understood.

- [ ] **Step 3: Add the `EH001` reachability test**

Append to the same file, in its own `describe`:

```ts
describe('capacity below what is booked', () => {
  it('refuses a host cutting seats under the number already taken', async () => {
    // EH001 has existed since 2026-08-09 and could never fire: reserved_count
    // was always 0 because nothing could book. This is the first time the path
    // is reachable, and it goes through the host's real edit action.
    const seeded = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    const buyer = await createTestUser(db)

    const booked = await bookFreeTickets(callerOf(buyer), seeded.ticketTypeId, 4, 'Priya')
    expect(booked.ok).toBe(true)

    const { signInAs } = await import('@/tests/helpers/session')
    const { updateEvent } = await import('@/app/host/events/actions')
    signInAs(seeded.hostProfileId)

    const fd = new FormData()
    fd.set('eventId', seeded.eventId)
    fd.set('title', 'Test Supper Club')
    fd.set('city', 'Indore')
    fd.set('venueName', 'The Terrace')
    fd.set('startsAtLocal', '2026-11-14T19:30')
    fd.set('seats', '2') // below the 4 already taken
    fd.set('priceRupees', '0')
    fd.set('hostDisplayName', 'Test Host')

    const state = await updateEvent({}, fd)

    expect(state.blockers ?? []).toHaveLength(1)
    expect(state.blockers![0]).toContain('4')

    const { data } = await db
      .from('ticket_types')
      .select('quantity')
      .eq('id', seeded.ticketTypeId)
      .single()
    expect(data!.quantity).toBe(10) // untouched

    await db.auth.admin.deleteUser(buyer).catch(() => {})
    await cleanupEvent(db, seeded)
  })
})
```

This file needs the same mocks `lib/events/actions.test.ts` uses for `next/cache`, `next/navigation` and `next/headers` — copy that block from the top of that file. Import `@/tests/helpers/session` statically so its `vi.mock` hoists, and bring in `updateEvent` with a top-level `await import`.

- [ ] **Step 4: Run it**

```bash
npx vitest run lib/bookings/concurrency.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Full verification**

```bash
npm test && npm run typecheck && npm run lint
```

- [ ] **Step 6: Update the README's phase state**

`README.md` describes the project as Phase 1. Update the one or two lines that say what is built to mention free bookings, and leave the QR and scanner described as not yet built. Read the file first; do not restructure it.

- [ ] **Step 7: Commit**

```bash
git add lib/bookings/concurrency.test.ts README.md
git commit
```

---

### Task 9: A way to reach `/bookings`

**Files:**
- Modify: `app/page.tsx:57`
- Modify: `app/e/[slug]/actions.ts`, `app/bookings/actions.ts`, `app/host/events/[id]/attendees/actions.ts` — add `revalidatePath('/')`

**Interfaces:**
- Consumes: everything above
- Produces: nothing further depends on this task

This app has no navigation. `app/layout.tsx:58` is `<body className="min-h-full">{children}</body>` — no header, no shell, and `app/_components/` holds one card component. Every link in the product is hard-coded into the page that needs it. Without this task `/bookings` is reachable only by typing the URL, which makes Task 6 dead code the moment the confirmation page is closed.

- [ ] **Step 1: Add the link**

`app/page.tsx:57` already carries a link in the feed header:

```tsx
<Link href="/host" className="shrink-0 text-sm underline">Host an event</Link>
```

Add a sibling immediately before or after it, matching that markup exactly:

```tsx
<Link href="/bookings" className="shrink-0 text-sm underline">Your bookings</Link>
```

Read the surrounding flex container first and keep its spacing; if the two links crowd the title on a narrow phone, wrap them in a `flex gap-4` rather than restyling either one.

Shown to signed-out visitors as well, which is deliberate and matches "Host an event" — that link is unconditional too. `requireUser()` on `/bookings` sends a signed-out visitor to `/login?next=/bookings`, and `safeNextPath` (`lib/auth/next-path.ts`) already accepts that path, so the return trip works with no new code.

- [ ] **Step 2: Revalidate the feed after a booking**

The feed card prints a seat count derived from `reserved_count`, so a booking or a cancellation moves it. Add `revalidatePath('/')` alongside the existing calls in all three actions.

Server rendering is not the reason — every page in this app is dynamic, because `lib/supabase/server.ts:13` awaits `cookies()` on every query path, so a fresh request always reads the truth. The reason is Next's client Router Cache: without the call, a back navigation to the feed shows the RSC payload from before the booking. `updateEvent` and `publishEvent` already set this precedent.

- [ ] **Step 3: Verify by hand**

```bash
npm run dev
```

Signed out on `/`, click "Your bookings" → `/login?next=/bookings` → sign in → land on `/bookings`. Then book from the feed, navigate back with the browser button, and confirm the seat count on the card has moved.

- [ ] **Step 4: Run the full suite, typecheck and lint**

```bash
npm test && npm run typecheck && npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx app/e/ app/bookings/ app/host/events/
git commit
```

---

## Self-review notes

**Spec coverage.** Trust boundary and its mitigations → Tasks 2 and 3 (branded `Caller`, `mayCancel`, the lint rule with a probe that proves it fires). `book_free_tickets` and its four guards → Task 1. Error mapping → Task 3. The four screens → Tasks 5, 6, 7, reachable via Task 9. Concurrency, authorisation-as-failed-attempts, cancellation returning inventory, the guards, `mayCancel` unit tests, and `EH001` becoming reachable → Tasks 1, 3, 4 and 8. The migrations and `db:types` → Task 1. The 2b notes are deliberately unimplemented.

**Where this plan now diverges from the spec, and why.** The spec was written before the audit recorded above. Four things here are not in it: `bookings.attendee_name` and the guest list reading it instead of `profiles`; the one-active-booking index and `EH012`; the `starts_at` guard and `EH013`; and Task 9's navigation link. Each exists because the spec's version could not work — the first silently, which is the dangerous kind. `docs/specs/2026-08-09-phase-2a-bookings-design.md` should be amended to match before this plan is executed, or read alongside this section.

**Known gap between spec and plan.** The spec names `lib/bookings/service.ts` as the only `admin.ts` importer and does not mention `lib/bookings/queries.ts`. The plan splits reads out into that second module, on the RLS-scoped client, so the quarantined file contains only writes. This narrows the service-role surface rather than widening it, and it is the split that makes the lint rule meaningful.

**Naming consistency.** `Caller` and `currentCaller()` (Task 2) are used in Tasks 3, 5, 6, 7. `mayCancel(caller, booking)` with `CancellableBooking { attendee_id, event_host_profile_id }` (Task 2) is called only in Task 3. `bookFreeTickets(caller, ticketTypeId, quantity, attendeeName, note?)` and `cancelBooking(caller, bookingId, reason?)` (Task 3) are used in Tasks 5, 6, 7, 8 — every call site passes a name, including the fifty in Task 8's concurrency test. `MyBooking` and `EventAttendee` (Task 4) are used in Tasks 6 and 7. Every Server Action state type is named `BookState` or `CancelState` and declared beside its action.

**The four SQLSTATEs are declared once and mapped once.** `EH010`/`EH011`/`EH012`/`EH013` are raised in Task 1's function and mapped in Task 3's `mapBookingRpcError`, with a test per code. `EH012` has two producers — the pre-check and the unique index caught in the `exception` block — that deliberately raise the same code, because a race must not read differently from the ordinary case.

**One correction made during review.** The plan first called a `formatIstDateTime(starts_at)` that does not exist. `lib/events/datetime.ts` exports `formatIst(date: Date)`, which takes a `Date` and not the ISO string `starts_at` is. Both call sites in Task 6 now read `formatIst(new Date(...))`. Verified against the module rather than assumed.

**Still unverified, and cheap to get wrong.** Task 4's `listEventAttendees` assumes the host-side booking policy in `20260808000003_rls_policies.sql` scopes a host to bookings on events they own. Task 4 Step 4 says explicitly: if the stranger case returns rows, that is an RLS finding to report, not a test to adjust.
