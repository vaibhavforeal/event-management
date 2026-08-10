# Phase 2b — QR Tickets and the Door Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every ticket renders as a signed QR on the booking page; the host checks guests in by camera at `/host/events/[id]/scan` or by tap on the guest list, with each check-in one atomic database write.

**Architecture:** Two new `SECURITY DEFINER` functions do the check-in writes, service-role only, mirroring `book_free_tickets`' posture exactly. `lib/checkin/` mirrors `lib/bookings/` — a service module (the second and last file allowed to import `admin.ts`), a pure authorizer, an SQLSTATE mapper. The QR payload is `EH1.<code>.<sig>` from the already-built-and-tested `lib/tickets/signing.ts`; the signature is derived per event and never stored. The scanner verifies the HMAC locally for an instant red, then a Server Action does the authoritative write.

**Tech Stack:** Postgres 17 (local Supabase), plpgsql, Next.js 16.3 App Router, React 19.2, TypeScript, Tailwind 4 (paper-palette tokens in `globals.css`), supabase-js 2.x, Vitest 4, `qrcode` (the phase's one new runtime dependency), native `BarcodeDetector`.

**Spec:** [`docs/specs/2026-08-09-phase-2b-qr-scanner-design.md`](../specs/2026-08-09-phase-2b-qr-scanner-design.md)

## Global Constraints

- **Identity never comes from a form.** Every write takes a `Caller` from `lib/bookings/caller.ts` (reused, not re-branded); only `currentCaller()` can produce one.
- **`lib/supabase/admin.ts` may be imported by exactly two files:** `lib/bookings/service.ts` and (from Task 3) `lib/checkin/service.ts`. The ESLint rule enforces it; extending the allowlist is part of Task 3, not a thing any other task may do.
- **RLS does not protect service-role writes.** Every authorisation decision in `lib/checkin/service.ts` is the whole of the rule.
- **"Already checked in" is an outcome, not an error.** Refusals are `EH020`/`EH021`/`EH022`; a duplicate scan returns a row.
- **The server never trusts the client's verdict.** Its authority is the code lookup; the signature exists for the instant local red and Phase 7 offline.
- **Colours come from the `globals.css` tokens** (`paper/ink/muted/line/accent/raised`); semantic green/amber/red stay Tailwind hues, per the status badges in `app/host/page.tsx`. No hex literals in components, no `zinc-*`/`neutral-*`.
- **`params` and `searchParams` are Promises** in Next.js 16 — use generated `PageProps<'/route'>`. **`cookies()` is async.**
- **Run `npm run db:types` after the migration.** `lib/supabase/types.ts` is committed, never hand-edited. Note: generated RPC arg types call every `text` argument non-nullable `string`; that is fine here since all args are required.
- **`npm test` needs `npm run db:start`,** which needs Docker Desktop, which starts only via PowerShell: `powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`. A `createTestUser failed: fetch failed` error means the stack is down, not an app bug.
- **Dev server: `localhost:3100`, never `127.0.0.1:3100`** (the IP form 403s dev chunks and React never hydrates).
- **Subagents dispatched with `model: "sonnet"` fail on this Foundry deployment.** Use the inherited session model or `haiku`.
- **`lib/events/actions.test.ts` is order-dependent; do not append to it.** New tests go in new files.
- **Baseline suite is 332 tests across 25 files, all green.** Never finish a task with a red suite.
- **`C:` is ~98% full.** `npm run db:stop` when the session ends.
- **Work on branch `phase-2b-qr-scanner`** (created in Task 1, merged after the final review).

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260811000001_ticket_checkin.sql` | **New.** `check_in_ticket()`, `check_in_next_ticket()`, revoke/grant pairs. |
| `lib/supabase/types.ts` | **Regenerated.** Gains both functions' `Args`/`Returns`. |
| `lib/checkin/authorize.ts` | **New.** Pure. `mayCheckIn()`. |
| `lib/checkin/rpc-errors.ts` | **New.** Pure. Maps `EH020`–`EH022` to sentences. |
| `lib/checkin/service.ts` | **New.** The only new `admin.ts` importer. `checkInTicket()`, `checkInNextTicket()`. |
| `eslint.config.mjs` | **Modified.** The `no-restricted-imports` ignore list gains `lib/checkin/service.ts`; the message names both files. |
| `lib/tickets/queries.ts` | **New.** RLS reads: `listBookingTickets()`. |
| `lib/tickets/qr.ts` | **New.** `ticketQrSvg(rootSecret, eventId, code)` — payload via `signing.ts`, SVG via `qrcode`. |
| `lib/env.ts` | **Modified.** `TICKET_SIGNING_SECRET` loses `.optional()`. |
| `.env.local` | **Modified (untracked).** Gains a generated `TICKET_SIGNING_SECRET`. |
| `lib/bookings/queries.ts` | **Modified.** `BOOKING_COLUMNS` embed gains `events.id`; `listEventAttendees` embed gains per-booking tickets. |
| `app/bookings/[reference]/page.tsx` | **Modified.** Tickets section: one QR per ticket. |
| `app/host/events/[id]/attendees/page.tsx` | **Modified.** "n of q in" per row, Check in +1 button, link to `/scan`. |
| `app/host/events/[id]/attendees/actions.ts` | **Modified.** Gains `checkInAttendee` Server Action. |
| `app/host/events/[id]/attendees/check-in-button.tsx` | **New.** Client component, mirrors the cancel buttons. |
| `app/host/events/[id]/scan/page.tsx` | **New.** Host-only; derives the event key; renders the scanner. |
| `app/host/events/[id]/scan/scanner.tsx` | **New.** Client: camera + `BarcodeDetector` loop + verdict card. |
| `app/host/events/[id]/scan/scan-state.ts` | **New.** Pure session reducer the scanner drives. |
| `app/host/events/[id]/scan/actions.ts` | **New.** `checkInByCode` Server Action. |
| `package.json` | **Modified.** `qrcode` dep, `@types/qrcode` dev dep. |

---

### Task 1: The check-in functions

**Files:**
- Create: `supabase/migrations/20260811000001_ticket_checkin.sql`
- Create: `lib/checkin/check-in-functions.test.ts`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Consumes: `tickets`, `bookings` tables; `book_free_tickets` (test setup); `tests/helpers/db.ts` (`adminClient`, `createTestUser` — read that file's exports before writing setup).
- Produces (later tasks call these over `.rpc()` as the service role):
  - `check_in_ticket(p_event_id uuid, p_code text, p_checked_in_by uuid)`
  - `check_in_next_ticket(p_event_id uuid, p_booking_id uuid, p_checked_in_by uuid)`
  - Both return one row: `(outcome text, attendee_name text, checked_in_at timestamptz, reference text, tickets_total integer, tickets_in integer)` with `outcome ∈ {'checked_in','already_checked_in'}`.
  - SQLSTATEs: `EH020` (no such ticket/booking on this event), `EH021` (booking not confirmed), `EH022` (next-ticket: nothing left to check in).

- [ ] **Step 1: Branch**

```bash
git checkout -b phase-2b-qr-scanner
```

- [ ] **Step 2: Write the failing integration test**

`lib/checkin/check-in-functions.test.ts`. Model the setup on `lib/bookings/book-free-tickets.test.ts` (read it first): create a host user + event + free ticket type via `adminClient()`, book with `book_free_tickets` as a second user, collect the issued ticket codes. Remember teardown order — bookings before users (`ON DELETE RESTRICT`) — and use distinct users per booking (the one-active-booking index).

Test cases (each asserts by SQLSTATE via `error.code`, or on the returned row):

```ts
it('checks a ticket in and reports the counts', async () => {
  const { data, error } = await admin
    .rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[0], p_checked_in_by: hostId })
    .single()
  expect(error).toBeNull()
  expect(data!.outcome).toBe('checked_in')
  expect(data!.attendee_name).toBe('Asha')       // what book_free_tickets stored
  expect(data!.tickets_total).toBe(2)
  expect(data!.tickets_in).toBe(1)
  expect(data!.checked_in_at).toBeTruthy()
})

it('reports a second scan as already checked in, with the original time', async () => {
  const first = await admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[0], p_checked_in_by: hostId }).single()
  const again = await admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[0], p_checked_in_by: hostId }).single()
  expect(again.data!.outcome).toBe('already_checked_in')
  expect(again.data!.checked_in_at).toBe(first.data!.checked_in_at)
})

it('refuses a code that belongs to a different event with EH020', async () => {
  // otherEventId: a second event created in setup, hosted by the same host
  const { error } = await admin.rpc('check_in_ticket', { p_event_id: otherEventId, p_code: codes[0], p_checked_in_by: hostId }).single()
  expect(error?.code).toBe('EH020')
})

it('refuses an unknown code with EH020', async () => {
  const { error } = await admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: 'f'.repeat(32), p_checked_in_by: hostId }).single()
  expect(error?.code).toBe('EH020')
})

it('exactly one of two simultaneous scans wins', async () => {
  const scans = await Promise.all([
    admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[1], p_checked_in_by: hostId }).single(),
    admin.rpc('check_in_ticket', { p_event_id: eventId, p_code: codes[1], p_checked_in_by: hostId }).single(),
  ])
  const outcomes = scans.map((s) => s.data!.outcome).sort()
  expect(outcomes).toEqual(['already_checked_in', 'checked_in'])
})

it('next-ticket picks unchecked tickets until none remain, then EH022', async () => {
  // freshBookingId: a 2-seat booking left untouched by earlier tests
  const one = await admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single()
  expect(one.data!.outcome).toBe('checked_in')
  expect(one.data!.tickets_in).toBe(1)
  const two = await admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single()
  expect(two.data!.tickets_in).toBe(2)
  const dry = await admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single()
  expect(dry.error?.code).toBe('EH022')
})

it('two simultaneous next-ticket taps take two different tickets', async () => {
  // pairBookingId: another untouched 2-seat booking
  const taps = await Promise.all([
    admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: pairBookingId, p_checked_in_by: hostId }).single(),
    admin.rpc('check_in_next_ticket', { p_event_id: eventId, p_booking_id: pairBookingId, p_checked_in_by: hostId }).single(),
  ])
  expect(taps.every((t) => t.data?.outcome === 'checked_in')).toBe(true)
  const { count } = await admin.from('tickets').select('*', { count: 'exact', head: true })
    .eq('booking_id', pairBookingId).not('checked_in_at', 'is', null)
  expect(count).toBe(2)
})

it('refuses a booking id from a different event with EH020', async () => {
  const { error } = await admin.rpc('check_in_next_ticket', { p_event_id: otherEventId, p_booking_id: freshBookingId, p_checked_in_by: hostId }).single()
  expect(error?.code).toBe('EH020')
})
```

- [ ] **Step 3: Run it, confirm it fails on the missing functions**

Run: `npx vitest run lib/checkin/check-in-functions.test.ts`
Expected: FAIL — PostgREST "Could not find the function public.check_in_ticket".

- [ ] **Step 4: Write the migration**

`supabase/migrations/20260811000001_ticket_checkin.sql`:

```sql
-- Ticket check-in, as one atomic decision per scan.
--
-- Same posture as every inventory write in this repo: SECURITY DEFINER with
-- EXECUTE revoked, callable only as the service role from
-- lib/checkin/service.ts, which authenticates the host itself. RLS grants no
-- ticket UPDATE to clients at all -- 20260808000003's comment on the tickets
-- policies says check-in "goes through a server function so a guest cannot
-- mark themselves admitted", and these are that function.
--
--   EH020  no ticket with this code -- or booking with this id -- on this event
--   EH021  the ticket's booking is not confirmed
--   EH022  (next_ticket only) every ticket on the booking is already in
--
-- "Already checked in" is deliberately NOT an error. A door sees it hourly --
-- the same QR shown twice, a screenshot forwarded to the friend who arrives
-- second -- so it comes back as a row with outcome = 'already_checked_in' and
-- the ORIGINAL checked_in_at, which is what lets the scanner say "at 8:14 pm".
--
-- p_event_id is matched in the lookup, not trusted from context: codes are
-- globally unique, so without the match a host could check in another event's
-- ticket by posting its code to their own door's action. With it, that scan is
-- EH020, which is true from that host's doorway.
--
-- attendee_name in the return is bookings.attendee_name -- the name typed at
-- booking. tickets.attendee_name is null on every row 2a created; reading it
-- would print "Guest" at every door.

create or replace function check_in_ticket(
  p_event_id      uuid,
  p_code          text,
  p_checked_in_by uuid
)
returns table (
  outcome        text,
  attendee_name  text,
  checked_in_at  timestamptz,
  reference      text,
  tickets_total  integer,
  tickets_in     integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  t tickets%rowtype;
  b bookings%rowtype;
begin
  -- FOR UPDATE OF t: the second of two simultaneous scans blocks here until
  -- the first commits, then reads the committed checked_in_at and reports
  -- 'already_checked_in'. The database decides the race, not timing.
  select tk.* into t
    from tickets tk
    join bookings bk on bk.id = tk.booking_id
   where tk.code = p_code
     and bk.event_id = p_event_id
     for update of tk;

  if not found then
    raise exception 'no ticket with this code on event %', p_event_id
      using errcode = 'EH020';
  end if;

  select * into b from bookings where id = t.booking_id;

  -- Believed unreachable today: tickets only exist for confirmed bookings and
  -- cancel_booking deletes the un-scanned ones. It is one predicate, and it is
  -- the safety net under Phase 3's paid states and Phase 5's approval states,
  -- both of which will create ticket-bearing bookings that are not confirmed.
  if b.status <> 'confirmed' then
    raise exception 'booking % is %, not confirmed', b.id, b.status
      using errcode = 'EH021';
  end if;

  if t.checked_in_at is null then
    update tickets
       set checked_in_at = now(), checked_in_by = p_checked_in_by
     where id = t.id;
    outcome := 'checked_in';
  else
    outcome := 'already_checked_in';
  end if;

  return query
    select outcome,
           b.attendee_name,
           tk.checked_in_at,
           b.reference,
           (select count(*)::integer from tickets x where x.booking_id = b.id),
           (select count(*)::integer from tickets x
             where x.booking_id = b.id and x.checked_in_at is not null)
      from tickets tk
     where tk.id = t.id;
end;
$$;

-- The guest-list tap: admit the next person on a booking without asking which.
-- Tickets on a free booking are interchangeable (no per-ticket names yet), so
-- "next unchecked, oldest first" is the whole selection rule. FOR UPDATE SKIP
-- LOCKED means two racing taps pick two DIFFERENT tickets rather than fighting
-- over one; the corner where the race empties the pool -- one unchecked ticket,
-- two taps, the loser sees nothing unlocked -- lands on EH022, which is morally
-- right from the loser's side of the desk.

create or replace function check_in_next_ticket(
  p_event_id      uuid,
  p_booking_id    uuid,
  p_checked_in_by uuid
)
returns table (
  outcome        text,
  attendee_name  text,
  checked_in_at  timestamptz,
  reference      text,
  tickets_total  integer,
  tickets_in     integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  t tickets%rowtype;
  b bookings%rowtype;
begin
  select bk.* into b
    from bookings bk
   where bk.id = p_booking_id
     and bk.event_id = p_event_id;

  if not found then
    raise exception 'no booking % on event %', p_booking_id, p_event_id
      using errcode = 'EH020';
  end if;

  if b.status <> 'confirmed' then
    raise exception 'booking % is %, not confirmed', b.id, b.status
      using errcode = 'EH021';
  end if;

  select tk.* into t
    from tickets tk
   where tk.booking_id = b.id
     and tk.checked_in_at is null
   order by tk.created_at, tk.id
   limit 1
   for update skip locked;

  if not found then
    raise exception 'every ticket on booking % is already checked in', b.id
      using errcode = 'EH022';
  end if;

  update tickets
     set checked_in_at = now(), checked_in_by = p_checked_in_by
   where id = t.id;

  outcome := 'checked_in';

  return query
    select outcome,
           b.attendee_name,
           tk.checked_in_at,
           b.reference,
           (select count(*)::integer from tickets x where x.booking_id = b.id),
           (select count(*)::integer from tickets x
             where x.booking_id = b.id and x.checked_in_at is not null)
      from tickets tk
     where tk.id = t.id;
end;
$$;

-- Revoking from public also strips service_role -- neither a superuser nor a
-- member of authenticated -- so the grant back is required, not decorative.
revoke execute on function check_in_ticket(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function check_in_ticket(uuid, text, uuid)
  to service_role;

revoke execute on function check_in_next_ticket(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function check_in_next_ticket(uuid, uuid, uuid)
  to service_role;
```

- [ ] **Step 5: Apply and regenerate types**

```bash
npm run db:reset
npm run db:types
```

- [ ] **Step 6: Run the test, expect green**

Run: `npx vitest run lib/checkin/check-in-functions.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 332 + new tests green.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260811000001_ticket_checkin.sql lib/checkin/check-in-functions.test.ts lib/supabase/types.ts
git commit -m "Add the check-in functions: one atomic decision per scan"
```

---

### Task 2: The pure modules — `mayCheckIn` and the error map

**Files:**
- Create: `lib/checkin/authorize.ts`, `lib/checkin/authorize.test.ts`
- Create: `lib/checkin/rpc-errors.ts`, `lib/checkin/rpc-errors.test.ts`

**Interfaces:**
- Consumes: `Caller` type from `@/lib/bookings/caller` (type-only).
- Produces:
  - `mayCheckIn(caller: Caller, event: { host_profile_id: string }): boolean`
  - `mapCheckinRpcError(error: PostgrestError): string`

- [ ] **Step 1: Write the failing tests**

`lib/checkin/authorize.test.ts` — model on `lib/bookings/authorize.test.ts` (read it for how a test builds a `Caller` despite the brand — `{ id } as Caller`):

```ts
import { describe, expect, it } from 'vitest'
import type { Caller } from '@/lib/bookings/caller'
import { mayCheckIn } from '@/lib/checkin/authorize'

const HOST = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const caller = (id: string) => ({ id }) as Caller

describe('mayCheckIn', () => {
  it('allows the host of the event', () => {
    expect(mayCheckIn(caller(HOST), { host_profile_id: HOST })).toBe(true)
  })
  it('refuses anyone else — attendees included; holding a ticket is not hosting', () => {
    expect(mayCheckIn(caller(OTHER), { host_profile_id: HOST })).toBe(false)
  })
  it('never lets two blanks match', () => {
    expect(mayCheckIn(caller(''), { host_profile_id: '' })).toBe(false)
  })
})
```

`lib/checkin/rpc-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapCheckinRpcError } from '@/lib/checkin/rpc-errors'

const err = (code: string, message = 'raw database text'): PostgrestError =>
  ({ code, message, details: '', hint: '', name: 'PostgrestError' }) as PostgrestError

describe('mapCheckinRpcError', () => {
  it('maps EH020 without distinguishing wrong-event from cancelled', () => {
    expect(mapCheckinRpcError(err('EH020'))).toBe(
      'No such ticket for this event. It may be for a different event, or its booking was cancelled.',
    )
  })
  it('maps EH021', () => {
    expect(mapCheckinRpcError(err('EH021'))).toBe('This booking is not confirmed.')
  })
  it('maps EH022', () => {
    expect(mapCheckinRpcError(err('EH022'))).toBe('All seats on this booking are already checked in.')
  })
  it('passes anything else through as its own message', () => {
    expect(mapCheckinRpcError(err('23505', 'duplicate key'))).toBe('duplicate key')
  })
})
```

- [ ] **Step 2: Run both, expect module-not-found failures**

Run: `npx vitest run lib/checkin/authorize.test.ts lib/checkin/rpc-errors.test.ts`

- [ ] **Step 3: Implement**

`lib/checkin/authorize.ts`:

```ts
import type { Caller } from '@/lib/bookings/caller'

/** The fields of an event that decide who may check its tickets in. */
export interface CheckInEvent {
  /** `profiles.id` of the host who owns the event. */
  host_profile_id: string
}

/**
 * Who may check a ticket in: the event's host, and nobody else. An attendee
 * holding a valid ticket is a guest, not a doorkeeper.
 *
 * Pure and separately tested because RLS does not enforce this — the write
 * goes through the service role, so this function is the whole of the rule.
 * Same shape as lib/bookings/authorize.ts for the same reason.
 */
export function mayCheckIn(caller: Caller, event: CheckInEvent): boolean {
  // An absent id must never match an absent column. Two blanks are equal.
  if (!caller.id) return false
  return caller.id === event.host_profile_id
}
```

`lib/checkin/rpc-errors.ts`:

```ts
import type { PostgrestError } from '@supabase/supabase-js'

/** No ticket with this code — or booking with this id — on this event. */
const NOT_HERE = 'EH020'
/** The ticket's booking is not confirmed. Unreachable today; Phase 3/5 net. */
const NOT_CONFIRMED = 'EH021'
/** next_ticket only: every ticket on the booking is already in. */
const ALL_IN = 'EH022'

/**
 * Turns a check-in refusal into a sentence for the host at the door.
 *
 * EH020 deliberately does not distinguish "wrong event" from "cancelled
 * booking" from "never existed": the function cannot tell them apart either
 * (the row simply is not there from this event's doorway), and the host's next
 * move — turn to the guest list — is the same in every case.
 */
export function mapCheckinRpcError(error: PostgrestError): string {
  if (error.code === NOT_HERE) {
    return 'No such ticket for this event. It may be for a different event, or its booking was cancelled.'
  }
  if (error.code === NOT_CONFIRMED) return 'This booking is not confirmed.'
  if (error.code === ALL_IN) return 'All seats on this booking are already checked in.'
  return error.message
}
```

- [ ] **Step 4: Run both, expect green**

- [ ] **Step 5: Commit**

```bash
git add lib/checkin/authorize.ts lib/checkin/authorize.test.ts lib/checkin/rpc-errors.ts lib/checkin/rpc-errors.test.ts
git commit -m "Add the check-in rule and its error vocabulary, both pure"
```

---

### Task 3: `lib/checkin/service.ts` and the widened lint fence

**Files:**
- Create: `lib/checkin/service.ts`, `lib/checkin/service.test.ts`
- Modify: `eslint.config.mjs:40-47`

**Interfaces:**
- Consumes: Task 1's RPCs, Task 2's `mayCheckIn`/`mapCheckinRpcError`, `Caller`, `createAdminClient` from `@/lib/supabase/admin`.
- Produces (Server Actions in Tasks 6 and 8 call these):

```ts
export type CheckInResult =
  | {
      ok: true
      outcome: 'checked_in' | 'already_checked_in'
      attendeeName: string | null
      checkedInAt: string
      reference: string
      ticketsTotal: number
      ticketsIn: number
    }
  | { ok: false; error: string }

export async function checkInTicket(caller: Caller, eventId: string, code: string): Promise<CheckInResult>
export async function checkInNextTicket(caller: Caller, eventId: string, bookingId: string): Promise<CheckInResult>
```

- [ ] **Step 1: Write the failing integration test**

`lib/checkin/service.test.ts` — integration, against the real stack, same setup shape as Task 1 (host, second host, attendee, event, booking, codes). The service reads the session? No — it takes a `Caller`; build one per test with `{ id } as Caller`. Import via top-level `await import` after `tests/helpers/db` side effects, following `lib/bookings/service.test.ts` (read it first and copy its import order).

```ts
it('checks in by code for the event host', async () => {
  const result = await checkInTicket(caller(hostId), eventId, codes[0])
  expect(result).toMatchObject({ ok: true, outcome: 'checked_in', ticketsIn: 1 })
})

it('refuses a caller who does not host the event, with one flat sentence', async () => {
  const result = await checkInTicket(caller(otherHostId), eventId, codes[1])
  expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
  // and nothing moved:
  const { data } = await admin.from('tickets').select('checked_in_at').eq('code', codes[1]).single()
  expect(data!.checked_in_at).toBeNull()
})

it('gives an unknown event the same sentence as someone else’s event', async () => {
  const result = await checkInTicket(caller(hostId), '00000000-0000-4000-8000-00000000dead', codes[1])
  expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
})

it('maps EH020 to the host sentence', async () => {
  const result = await checkInTicket(caller(hostId), eventId, 'f'.repeat(32))
  expect(result).toEqual({
    ok: false,
    error: 'No such ticket for this event. It may be for a different event, or its booking was cancelled.',
  })
})

it('checks in the next ticket by booking id', async () => {
  const result = await checkInNextTicket(caller(hostId), eventId, bookingId)
  expect(result).toMatchObject({ ok: true, outcome: 'checked_in' })
})

it('refuses next-ticket for a non-host too', async () => {
  const result = await checkInNextTicket(caller(otherHostId), eventId, bookingId)
  expect(result).toEqual({ ok: false, error: 'That is not your event to check tickets in for.' })
})
```

- [ ] **Step 2: Run, expect module-not-found**

Run: `npx vitest run lib/checkin/service.test.ts`

- [ ] **Step 3: Implement the service**

`lib/checkin/service.ts`:

```ts
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { mayCheckIn } from '@/lib/checkin/authorize'
import { mapCheckinRpcError } from '@/lib/checkin/rpc-errors'
import type { Caller } from '@/lib/bookings/caller'

/**
 * Every check-in write in the product. The second — and last — file permitted
 * to import lib/supabase/admin.ts; eslint.config.mjs names both.
 *
 * Same contract as lib/bookings/service.ts: RLS does not see these writes, so
 * the authorisation below is the whole of the rule, and identity is a Caller
 * that only lib/bookings/caller.ts can mint. The Caller brand is reused rather
 * than re-declared because a second brand would mean a second thing to audit.
 */

export type CheckInResult =
  | {
      ok: true
      outcome: 'checked_in' | 'already_checked_in'
      attendeeName: string | null
      checkedInAt: string
      reference: string
      ticketsTotal: number
      ticketsIn: number
    }
  | { ok: false; error: string }

/**
 * One sentence for "not your event", "no such event" and "the lookup failed",
 * for the same reason cancelBooking has NOT_YOURS: every path that fails to
 * establish the caller's right refuses identically, so there is nothing an
 * outsider can tell apart.
 */
const NOT_YOUR_DOOR = 'That is not your event to check tickets in for.'

/** Loads the event's host and applies mayCheckIn. Null means refuse. */
async function authorizedEventHost(caller: Caller, eventId: string): Promise<boolean> {
  const db = createAdminClient()
  const { data: event, error } = await db
    .from('events')
    .select('hosts(profile_id)')
    .eq('id', eventId)
    .maybeSingle()

  if (error) {
    console.error('[checkin] could not read event for authorisation', error)
    return false
  }
  if (!event) return false
  return mayCheckIn(caller, { host_profile_id: event.hosts.profile_id })
}

export async function checkInTicket(
  caller: Caller,
  eventId: string,
  code: string,
): Promise<CheckInResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const { data, error } = await db
    .rpc('check_in_ticket', {
      p_event_id: eventId,
      p_code: code,
      // The verified caller, never a form field: who admitted this guest.
      p_checked_in_by: caller.id,
    })
    .single()

  if (error) return { ok: false, error: mapCheckinRpcError(error) }
  return {
    ok: true,
    outcome: data.outcome as 'checked_in' | 'already_checked_in',
    attendeeName: data.attendee_name,
    checkedInAt: data.checked_in_at,
    reference: data.reference,
    ticketsTotal: data.tickets_total,
    ticketsIn: data.tickets_in,
  }
}

export async function checkInNextTicket(
  caller: Caller,
  eventId: string,
  bookingId: string,
): Promise<CheckInResult> {
  if (!(await authorizedEventHost(caller, eventId))) {
    return { ok: false, error: NOT_YOUR_DOOR }
  }

  const db = createAdminClient()
  const { data, error } = await db
    .rpc('check_in_next_ticket', {
      p_event_id: eventId,
      p_booking_id: bookingId,
      p_checked_in_by: caller.id,
    })
    .single()

  if (error) return { ok: false, error: mapCheckinRpcError(error) }
  return {
    ok: true,
    outcome: data.outcome as 'checked_in' | 'already_checked_in',
    attendeeName: data.attendee_name,
    checkedInAt: data.checked_in_at,
    reference: data.reference,
    ticketsTotal: data.tickets_total,
    ticketsIn: data.tickets_in,
  }
}
```

Note: if the generated embed type for `events.hosts` is nullable or an array in `select('hosts(profile_id)')`, do what `lib/bookings/service.ts:99-111` does — check what the generated type actually infers and keep it *checked*, never `as unknown as`. `events.host_id` is NOT NULL with a foreign key, so PostgREST returns the object.

- [ ] **Step 4: Widen the lint fence**

In `eslint.config.mjs`, change the override block:

```js
    ignores: ["lib/bookings/service.ts", "lib/checkin/service.ts", "lib/supabase/admin.ts"],
```

and the message:

```js
          message:
            "Only lib/bookings/service.ts and lib/checkin/service.ts may use the service role. Use @/lib/supabase/server, or add the write to one of those modules.",
```

- [ ] **Step 5: Prove the fence still bites**

Add `import '@/lib/supabase/admin'` to the top of `lib/tickets/signing.ts`, run `npm run lint`, watch it fail with the new message, then **delete the probe line**. Do not skip the watch-it-fail step; a fence that was never seen failing is a hope, not a fence.

- [ ] **Step 6: Run tests, expect green**

Run: `npx vitest run lib/checkin/service.test.ts && npm run lint`

- [ ] **Step 7: Commit**

```bash
git add lib/checkin/service.ts lib/checkin/service.test.ts eslint.config.mjs
git commit -m "Add the check-in service, the second and last holder of the service role"
```

---

### Task 4: Ticket reads — `lib/tickets/queries.ts` and the widened booking embeds

**Files:**
- Create: `lib/tickets/queries.ts`, `lib/tickets/queries.test.ts`
- Modify: `lib/bookings/queries.ts` (`BOOKING_COLUMNS`, `MyBooking`, `listEventAttendees`, `EventAttendee`)

**Interfaces:**
- Consumes: existing RLS policies `tickets_select_own` / `tickets_select_for_host`; `tests/helpers/db.ts` (`userClient` or equivalent — read the helper for how existing query tests get a signed-in client).
- Produces:

```ts
// lib/tickets/queries.ts
export interface BookingTicket {
  id: string
  code: string
  checked_in_at: string | null
}
export async function listBookingTickets(bookingId: string): Promise<BookingTicket[]>
```

- `MyBooking.events` gains `id: string` (the QR page derives the per-event key from it).
- `EventAttendee` gains `tickets: { id: string; checked_in_at: string | null }[]` (the guest list counts them).

- [ ] **Step 1: Write the failing tests**

`lib/tickets/queries.test.ts` — integration. Setup: host + attendee + stranger users, event, 2-seat booking. Model the signed-in-client mechanics on `lib/bookings/queries.test.ts` (read it first — it shows how a test authenticates as a specific user against the local stack).

```ts
it('returns the booker their own tickets, codes included', async () => {
  const tickets = await asUser(attendeeId, () => listBookingTickets(bookingId))
  expect(tickets).toHaveLength(2)
  expect(tickets[0].code).toMatch(/^[0-9a-f]{32}$/)
})

it('returns the event host the same tickets', async () => {
  const tickets = await asUser(hostId, () => listBookingTickets(bookingId))
  expect(tickets).toHaveLength(2)
})

it('returns a stranger nothing — RLS filters, it does not refuse', async () => {
  const tickets = await asUser(strangerId, () => listBookingTickets(bookingId))
  expect(tickets).toEqual([])
})

it('returns nobody anything when signed out', async () => {
  const tickets = await listBookingTickets(bookingId) // no session installed
  expect(tickets).toEqual([])
})
```

Also extend `lib/bookings/queries.test.ts`'s *own new file* — `lib/bookings/queries-embeds.test.ts` (do not append to an order-dependent suite; this one is a new file regardless):

```ts
it('MyBooking carries the event id for the QR page', async () => {
  const bookings = await asUser(attendeeId, () => listMyBookings())
  expect(bookings[0].events?.id).toBe(eventId)
})

it('each attendee row carries its ticket check-in states', async () => {
  const attendees = await asUser(hostId, () => listEventAttendees(eventId))
  expect(attendees[0].tickets).toHaveLength(2)
  expect(attendees[0].tickets.every((t) => t.checked_in_at === null)).toBe(true)
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run lib/tickets/queries.test.ts lib/bookings/queries-embeds.test.ts`

- [ ] **Step 3: Implement**

`lib/tickets/queries.ts`:

```ts
import 'server-only'
import { createClient } from '@/lib/supabase/server'

/**
 * Every ticket read, on the RLS-scoped client — the mirror of
 * lib/bookings/queries.ts one table down, and under the same warning from that
 * module's header: RLS here is the protection, not the scoping.
 * tickets_select_own and tickets_select_for_host OR together, so "tickets on
 * this booking" is already scoped to a booking the caller may see — the
 * bookingId filter is what makes the answer THIS booking's tickets, and the
 * caller's entitlement to the booking was settled by whoever loaded it
 * (getBookingByReference, which deliberately resolves for the host too).
 */

export interface BookingTicket {
  id: string
  code: string
  checked_in_at: string | null
}

/** Tickets on one booking, oldest first — the order the door admits them in. */
export async function listBookingTickets(bookingId: string): Promise<BookingTicket[]> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  // Signed out reads nothing. tickets has no anon SELECT grant, so without
  // this the query would throw 42501 rather than return zero rows — same
  // grant-versus-policy distinction lib/bookings/queries.ts documents.
  if (!auth.user) return []

  const { data, error } = await supabase
    .from('tickets')
    .select('id, code, checked_in_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Could not load the tickets: ${error.message}`)
  return (data ?? []) as BookingTicket[]
}
```

In `lib/bookings/queries.ts`:
- `BOOKING_COLUMNS`: `events(slug, title, starts_at, city, venue_name)` → `events(id, slug, title, starts_at, city, venue_name)`; add `id: string` to `MyBooking['events']`.
- `listEventAttendees` select: add `, tickets(id, checked_in_at)` to the select string (a plain embed, NOT `!inner` — a zero-ticket booking must keep its row; only the hosts hop filters).
- `EventAttendee`: add `tickets: { id: string; checked_in_at: string | null }[]`.

- [ ] **Step 4: Run, expect green; then the full suite**

Run: `npx vitest run lib/tickets/queries.test.ts lib/bookings/queries-embeds.test.ts && npm test`

- [ ] **Step 5: Commit**

```bash
git add lib/tickets/queries.ts lib/tickets/queries.test.ts lib/bookings/queries.ts lib/bookings/queries-embeds.test.ts
git commit -m "Read tickets under RLS, and carry event id and check-in state in the embeds"
```

---

### Task 5: QR rendering on the booking page

**Files:**
- Create: `lib/tickets/qr.ts`, `lib/tickets/qr.test.ts`
- Modify: `lib/env.ts` (drop `.optional()` from `TICKET_SIGNING_SECRET`), `.env.local` (add a value), `app/bookings/[reference]/page.tsx`, `package.json`

**Interfaces:**
- Consumes: `deriveEventKey`, `buildQrPayload`, `verifyQrPayload` from `@/lib/tickets/signing`; `listBookingTickets` from Task 4; `serverEnv()` from `@/lib/env`.
- Produces: `ticketQrSvg(rootSecret: string, eventId: string, code: string): Promise<string>` — an SVG string.

- [ ] **Step 1: Install the dependency and the secret**

```bash
npm install qrcode && npm install -D @types/qrcode
node -e "console.log('TICKET_SIGNING_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env.local
```

In `lib/env.ts`, change `TICKET_SIGNING_SECRET: z.string().min(32).optional(),` to `TICKET_SIGNING_SECRET: z.string().min(32),` — this phase is what the `.optional()` was waiting for. (serverEnv validates the whole schema at once, so this is the step that would break every server page if the `.env.local` line above were skipped — which is why they share a step.)

- [ ] **Step 2: Write the failing test**

`lib/tickets/qr.test.ts` — unit, no database; the secret is an argument, not an env read:

```ts
import { describe, expect, it } from 'vitest'
import { deriveEventKey, verifyQrPayload } from '@/lib/tickets/signing'
import { ticketQrPayload, ticketQrSvg } from '@/lib/tickets/qr'

const SECRET = 's'.repeat(64)
const EVENT = '00000000-0000-4000-8000-0000000000e1'
const CODE = 'a'.repeat(32)

describe('ticketQrSvg', () => {
  it('renders an SVG', async () => {
    const svg = await ticketQrSvg(SECRET, EVENT, CODE)
    expect(svg.trimStart()).toMatch(/^<svg/)
  })

  it('encodes a payload that verifies under the same event key and fails under another', async () => {
    // The QR content is not inspectable from the SVG, so prove the pipeline by
    // construction: the payload the module builds must round-trip through
    // verifyQrPayload. This is the whole security property the page relies on.
    const key = await deriveEventKey(SECRET, EVENT)
    const payload = await ticketQrPayload(SECRET, EVENT, CODE)
    expect(await verifyQrPayload(key, payload)).toEqual({ valid: true, code: CODE })
    const otherKey = await deriveEventKey(SECRET, '00000000-0000-4000-8000-0000000000e2')
    expect(await verifyQrPayload(otherKey, payload)).toEqual({ valid: false, reason: 'bad_signature' })
  })
})
```

- [ ] **Step 3: Run, expect failure**

Run: `npx vitest run lib/tickets/qr.test.ts`

- [ ] **Step 4: Implement**

`lib/tickets/qr.ts`:

```ts
import 'server-only'
import QRCode from 'qrcode'
import { buildQrPayload, deriveEventKey } from '@/lib/tickets/signing'

/**
 * The QR an attendee holds up at the door.
 *
 * Server-only on purpose: building a payload requires the per-event key, which
 * requires the root secret, and neither may reach an attendee's browser. The
 * page embeds the finished SVG; the only secret-derived thing in it is the
 * 80-bit signature inside the payload, which is exactly what a QR is for.
 */

/** The signed payload string — split out so a test can verify the round trip. */
export async function ticketQrPayload(
  rootSecret: string,
  eventId: string,
  code: string,
): Promise<string> {
  const key = await deriveEventKey(rootSecret, eventId)
  return buildQrPayload(key, code)
}

/** The payload as an SVG. Margin 1 module; the page supplies visual padding. */
export async function ticketQrSvg(
  rootSecret: string,
  eventId: string,
  code: string,
): Promise<string> {
  const payload = await ticketQrPayload(rootSecret, eventId, code)
  return QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
}
```

- [ ] **Step 5: Run, expect green**

- [ ] **Step 6: Render the tickets on the booking page**

In `app/bookings/[reference]/page.tsx`, after the `<dl>` and before the links `<div>`, add a Tickets section. New imports: `listBookingTickets` from `@/lib/tickets/queries`, `ticketQrSvg` from `@/lib/tickets/qr`, `serverEnv` from `@/lib/env`. Load after the booking resolves:

```tsx
const tickets = booking.events
  ? await listBookingTickets(booking.id)
  : [] // no event id → no key to derive; the reference is still the fallback
const qrs = await Promise.all(
  tickets.map((t) => ticketQrSvg(serverEnv().TICKET_SIGNING_SECRET, booking.events!.id, t.code)),
)
```

```tsx
{tickets.length > 0 && (
  <section className="mt-10">
    <h2 className="text-muted font-mono text-[13px]">
      {tickets.length === 1 ? 'Your ticket' : `Your tickets — one per person`}
    </h2>
    <ul className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
      {tickets.map((ticket, index) => (
        <li key={ticket.id} className="border-line rounded-xl border bg-white p-3">
          {/* dangerouslySetInnerHTML is safe here by construction: the SVG is
              generated by the qrcode library from a payload this server built
              out of hex and dots. Nothing user-authored is in it. */}
          <div aria-hidden dangerouslySetInnerHTML={{ __html: qrs[index] }} />
          <p className="mt-2 font-mono text-[12px]">
            Ticket {index + 1} of {tickets.length}
          </p>
          {/* The tail lets a host eyeball-match a screenshot to a row without
              scanning. Six characters of a 32-char code identify without
              admitting: admission needs the signature, which only a scan reads. */}
          <p className="text-muted font-mono text-[11px]">…{ticket.code.slice(-6)}</p>
          {ticket.checked_in_at && (
            <p className="text-muted mt-1 font-mono text-[11px]">Checked in</p>
          )}
        </li>
      ))}
    </ul>
    <p className="text-muted mt-3 text-[13px]">
      Going as a group? Send each person a screenshot of their own ticket.
    </p>
  </section>
)}
```

`bg-white` behind the QR is deliberate — quiet-zone contrast for camera reads on the paper background; it is the one place white is the functional colour rather than chrome.

- [ ] **Step 7: Verify in the browser**

`npm run dev` → book a seat (or open an existing booking) → `localhost:3100/bookings/<reference>` shows one QR per seat. Confirm typecheck and the suite: `npm run typecheck && npm test`.

- [ ] **Step 8: Commit**

```bash
git add lib/tickets/qr.ts lib/tickets/qr.test.ts lib/env.ts app/bookings/[reference]/page.tsx package.json package-lock.json
git commit -m "Render each ticket as a signed QR on the booking page"
```

---

### Task 6: The guest list checks people in

**Files:**
- Modify: `app/host/events/[id]/attendees/page.tsx`, `app/host/events/[id]/attendees/actions.ts`
- Create: `app/host/events/[id]/attendees/check-in-button.tsx`
- Create: `app/host/events/[id]/attendees/check-in-action.test.ts`

**Interfaces:**
- Consumes: `checkInNextTicket` from Task 3; `EventAttendee.tickets` from Task 4; `currentCaller`, `loginPath`, `UUID_PATTERN` (already in `actions.ts`).
- Produces: `checkInAttendee(previous: CheckInState, formData: FormData): Promise<CheckInState>` where `CheckInState = { error?: string }`.

- [ ] **Step 1: Write the failing action tests**

`check-in-action.test.ts`, mirroring `actions.test.ts`'s mocks exactly (same `RedirectSignal`, same `x-pathname` header, same mocked `currentCaller`) but mocking `@/lib/checkin/service`:

```ts
const checkInNextTicket = vi.fn<(...args: unknown[]) => Promise<CheckInResult>>()
vi.mock('@/lib/checkin/service', () => ({
  checkInNextTicket: (...args: unknown[]) => checkInNextTicket(...args),
}))

it('redirects a signed-out host to login', async () => {
  caller = null
  expect(await captureRedirect(form())).toBe(`/login?next=${encodeURIComponent(ATTENDEES_PATH)}`)
  expect(checkInNextTicket).not.toHaveBeenCalled()
})

it('refuses a missing booking id without calling the service', async () => {
  const state = await checkInAttendee({}, form({ bookingId: undefined }))
  expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
  expect(checkInNextTicket).not.toHaveBeenCalled()
})

it('refuses an event id that is not uuid-shaped, because the service scopes by it', async () => {
  // Unlike the cancel action, eventId here is not merely a revalidation path —
  // it is the scope the service authorises against. Still safe if lied about
  // (wrong host → refused; wrong event → EH020), but a junk shape stops here.
  const state = await checkInAttendee({}, form({ eventId: 'not-a-uuid' }))
  expect(state).toEqual({ error: 'Something went wrong. Reload the page and try again.' })
  expect(checkInNextTicket).not.toHaveBeenCalled()
})

it('checks in under the caller’s identity and revalidates the list', async () => {
  checkInNextTicket.mockResolvedValue({ ok: true, outcome: 'checked_in', attendeeName: 'Asha',
    checkedInAt: 'now', reference: 'ABCD1234', ticketsTotal: 2, ticketsIn: 1 })
  const state = await checkInAttendee({}, form())
  expect(state).toEqual({})
  expect(checkInNextTicket).toHaveBeenCalledWith({ id: CALLER_ID }, EVENT_ID, BOOKING_ID)
  expect(revalidatePath).toHaveBeenCalledWith(ATTENDEES_PATH)
})

it('returns the service refusal verbatim and revalidates nothing', async () => {
  checkInNextTicket.mockResolvedValue({ ok: false, error: 'All seats on this booking are already checked in.' })
  const state = await checkInAttendee({}, form())
  expect(state).toEqual({ error: 'All seats on this booking are already checked in.' })
  expect(revalidatePath).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run, expect failure** — `npx vitest run "app/host/events/[id]/attendees/check-in-action.test.ts"`

- [ ] **Step 3: Implement the action**

Append to `app/host/events/[id]/attendees/actions.ts`:

```ts
export interface CheckInState {
  error?: string
}

/**
 * Admits the next person on a booking — the tap fallback for a guest with no
 * QR, no camera, or no Chrome. The service re-checks that the caller hosts
 * this event; eventId arriving from a hidden input is safe for the same
 * reason the cancel action's is — lying about it changes which door you are
 * refused at, not what you may do — but unlike the cancel action it IS passed
 * to the service, as the scope to authorise against, so a junk shape stops
 * here rather than travelling.
 */
export async function checkInAttendee(
  _previous: CheckInState,
  formData: FormData,
): Promise<CheckInState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  const eventId = String(formData.get('eventId') ?? '')
  if (!bookingId || !UUID_PATTERN.test(eventId)) {
    return { error: 'Something went wrong. Reload the page and try again.' }
  }

  const result = await checkInNextTicket(caller, eventId, bookingId)
  if (!result.ok) return { error: result.error }

  revalidatePath(`/host/events/${eventId}/attendees`)
  return {}
}
```

(Import `checkInNextTicket` from `@/lib/checkin/service` at the top.)

- [ ] **Step 4: The button and the row**

`check-in-button.tsx` — clone the shape of `cancel-attendee-button.tsx` (own `useActionState`, hidden `bookingId`/`eventId`, `aria-live` error region), button label `Check in +1`, `disabled={pending}`, plus `disabled` with a `title` when `remaining === 0` (the page passes `remaining`).

In `page.tsx`, per row: compute `const ticketsIn = a.tickets.filter((t) => t.checked_in_at).length` and render beside the seat count:

```tsx
<p className="text-muted font-mono text-[12px]">
  {a.quantity} {a.quantity === 1 ? 'seat' : 'seats'} · {ticketsIn} of {a.tickets.length} in · {a.reference}
</p>
```

and `<CheckInButton bookingId={a.id} eventId={id} remaining={a.tickets.length - ticketsIn} />` next to the cancel button. At the top, under the heading, a link to the scanner:

```tsx
<Link href={`/host/events/${id}/scan`} className="font-mono text-[13px] underline">
  Scan tickets →
</Link>
```

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run lint`

- [ ] **Step 6: Verify in the browser** — guest list shows "0 of 2 in", the button moves it to "1 of 2 in", a third tap on a 2-seat booking shows the EH022 sentence under the button.

- [ ] **Step 7: Commit**

```bash
git add "app/host/events/[id]/attendees/"
git commit -m "Let the guest list admit people, one tap per seat"
```

---

### Task 7: The scan session reducer

**Files:**
- Create: `app/host/events/[id]/scan/scan-state.ts`, `app/host/events/[id]/scan/scan-state.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (the scanner component drives this):

```ts
export type ScanVerdict =
  | { kind: 'in'; name: string | null; ticketsIn: number; ticketsTotal: number }
  | { kind: 'already'; name: string | null; checkedInAt: string }
  | { kind: 'refused'; message: string }
  | { kind: 'invalid'; reason: 'malformed' | 'unsupported_version' | 'bad_signature' }

export interface ScanSession {
  current: { payload: string; verdict: ScanVerdict | 'pending' } | null
}

export const IDLE: ScanSession

export type ScanEvent =
  | { type: 'detected'; payload: string }
  | { type: 'verdict'; payload: string; verdict: ScanVerdict }
  | { type: 'dismiss' }

/** True when a 'detected' payload should start verification. */
export function wantsProcessing(before: ScanSession, after: ScanSession, payload: string): boolean

export function reduceScan(session: ScanSession, event: ScanEvent): ScanSession
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { IDLE, reduceScan, type ScanSession, type ScanVerdict } from './scan-state'

const IN: ScanVerdict = { kind: 'in', name: 'Asha', ticketsIn: 1, ticketsTotal: 2 }

describe('reduceScan', () => {
  it('a detection from idle becomes pending', () => {
    const s = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    expect(s.current).toEqual({ payload: 'EH1.a.b', verdict: 'pending' })
  })

  it('the same payload detected again changes nothing — one QR held up is one scan', () => {
    const s1 = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    const s2 = reduceScan(s1, { type: 'detected', payload: 'EH1.a.b' })
    expect(s2).toBe(s1)
  })

  it('a different payload is ignored while a verdict is pending — one flight at a time', () => {
    const s1 = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    const s2 = reduceScan(s1, { type: 'detected', payload: 'EH1.c.d' })
    expect(s2).toBe(s1)
  })

  it('a verdict lands only on the payload it was computed for', () => {
    const s1 = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    const stale = reduceScan(s1, { type: 'verdict', payload: 'EH1.zzz.q', verdict: IN })
    expect(stale).toBe(s1)
    const landed = reduceScan(s1, { type: 'verdict', payload: 'EH1.a.b', verdict: IN })
    expect(landed.current?.verdict).toEqual(IN)
  })

  it('after a verdict, the same payload still changes nothing, but a new one replaces the card', () => {
    let s = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    s = reduceScan(s, { type: 'verdict', payload: 'EH1.a.b', verdict: IN })
    expect(reduceScan(s, { type: 'detected', payload: 'EH1.a.b' })).toBe(s)
    const next = reduceScan(s, { type: 'detected', payload: 'EH1.c.d' })
    expect(next.current).toEqual({ payload: 'EH1.c.d', verdict: 'pending' })
  })

  it('dismiss clears everything, and the same QR can then be scanned again', () => {
    let s = reduceScan(IDLE, { type: 'detected', payload: 'EH1.a.b' })
    s = reduceScan(s, { type: 'verdict', payload: 'EH1.a.b', verdict: IN })
    s = reduceScan(s, { type: 'dismiss' })
    expect(s).toEqual(IDLE)
    expect(reduceScan(s, { type: 'detected', payload: 'EH1.a.b' }).current?.verdict).toBe('pending')
  })
})
```

- [ ] **Step 2: Run, expect failure** — `npx vitest run "app/host/events/[id]/scan/scan-state.test.ts"`

- [ ] **Step 3: Implement**

```ts
/**
 * The scanner's session state, pure so the camera loop can stay dumb.
 *
 * The properties the tests pin, in order of what they cost the door if lost:
 * a QR held steady in front of the camera fires 'detected' several times a
 * second and must cost ONE server action; a verdict computed for one payload
 * must never label another; and while one scan is in flight, nothing else
 * gets started — a door admits one person at a time.
 */
export type ScanVerdict =
  | { kind: 'in'; name: string | null; ticketsIn: number; ticketsTotal: number }
  | { kind: 'already'; name: string | null; checkedInAt: string }
  | { kind: 'refused'; message: string }
  | { kind: 'invalid'; reason: 'malformed' | 'unsupported_version' | 'bad_signature' }

export interface ScanSession {
  current: { payload: string; verdict: ScanVerdict | 'pending' } | null
}

export const IDLE: ScanSession = { current: null }

export type ScanEvent =
  | { type: 'detected'; payload: string }
  | { type: 'verdict'; payload: string; verdict: ScanVerdict }
  | { type: 'dismiss' }

export function reduceScan(session: ScanSession, event: ScanEvent): ScanSession {
  switch (event.type) {
    case 'detected': {
      if (session.current) {
        // Same QR still in frame, or a different one while a scan is in
        // flight: either way, not a new scan. Returning the SAME object is
        // what lets the component use identity to skip re-processing.
        if (session.current.payload === event.payload) return session
        if (session.current.verdict === 'pending') return session
      }
      return { current: { payload: event.payload, verdict: 'pending' } }
    }
    case 'verdict': {
      if (session.current?.payload !== event.payload) return session // stale flight
      if (session.current.verdict !== 'pending') return session
      return { current: { payload: event.payload, verdict: event.verdict } }
    }
    case 'dismiss':
      return IDLE
  }
}
```

(Drop `wantsProcessing` from the interface block if unused — the component can compare `before !== after && after.current?.verdict === 'pending'`. If kept, it is that comparison, named.)

- [ ] **Step 4: Run, expect green**

- [ ] **Step 5: Commit**

```bash
git add "app/host/events/[id]/scan/scan-state.ts" "app/host/events/[id]/scan/scan-state.test.ts"
git commit -m "Add the scan session reducer: one QR, one flight, one verdict"
```

---

### Task 8: The scanner

**Files:**
- Create: `app/host/events/[id]/scan/page.tsx`, `app/host/events/[id]/scan/scanner.tsx`, `app/host/events/[id]/scan/actions.ts`, `app/host/events/[id]/scan/actions.test.ts`

**Interfaces:**
- Consumes: `checkInTicket` (Task 3), `reduceScan`/`ScanVerdict` (Task 7), `verifyQrPayload`/`eventKeyFromHex`/`deriveEventKeyHex` from `@/lib/tickets/signing`, `getOwnedEvent`, `requireUser`, `serverEnv`, `currentCaller`.
- Produces: `checkInByCode(eventId: string, code: string): Promise<CheckInResult>` — a Server Action the scanner calls imperatively (no form).

- [ ] **Step 1: Write the failing action tests**

`actions.test.ts` — same mock kit as the other action suites (`RedirectSignal`, mocked `currentCaller`, mocked `@/lib/checkin/service`):

```ts
it('redirects a signed-out caller to login carrying the scanner path', async () => {
  caller = null
  expect(await captureRedirect(() => checkInByCode(EVENT_ID, CODE))).toBe(
    `/login?next=${encodeURIComponent(`/host/events/${EVENT_ID}/scan`)}`,
  )
})

it('refuses junk before the service sees it', async () => {
  expect(await checkInByCode('not-a-uuid', CODE)).toEqual({ ok: false, error: GENERIC })
  expect(await checkInByCode(EVENT_ID, 'not-hex')).toEqual({ ok: false, error: GENERIC })
  expect(checkInTicket).not.toHaveBeenCalled()
})

it('passes a well-shaped scan through under the caller’s identity', async () => {
  checkInTicket.mockResolvedValue({ ok: true, outcome: 'checked_in', attendeeName: 'Asha',
    checkedInAt: 'now', reference: 'ABCD1234', ticketsTotal: 2, ticketsIn: 1 })
  const result = await checkInByCode(EVENT_ID, CODE)
  expect(checkInTicket).toHaveBeenCalledWith({ id: CALLER_ID }, EVENT_ID, CODE)
  expect(result.ok).toBe(true)
})

it('returns the service refusal untouched', async () => {
  checkInTicket.mockResolvedValue({ ok: false, error: 'This booking is not confirmed.' })
  expect(await checkInByCode(EVENT_ID, CODE)).toEqual({ ok: false, error: 'This booking is not confirmed.' })
})
```

with `const GENERIC = 'Something went wrong. Rescan the ticket.'` and `CODE = 'a'.repeat(32)`.

- [ ] **Step 2: Run, expect failure** — `npx vitest run "app/host/events/[id]/scan/actions.test.ts"`

- [ ] **Step 3: Implement the action**

`app/host/events/[id]/scan/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { checkInTicket, type CheckInResult } from '@/lib/checkin/service'
import { loginPath } from '@/lib/auth/session'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_PATTERN = /^[0-9a-f]{32}$/

/**
 * The scanner's write. Called imperatively from the client after a local
 * signature check — which the server does NOT rely on: authorisation is the
 * service's host check, and authenticity is the code lookup. A forged-but-
 * well-shaped payload that somehow passed the local verify still admits
 * nobody, because its code matches no row.
 */
export async function checkInByCode(eventId: string, code: string): Promise<CheckInResult> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  if (!UUID_PATTERN.test(eventId) || !CODE_PATTERN.test(code)) {
    // Junk shapes stop here. One sentence, because the scanner's next move is
    // the same regardless: scan again.
    return { ok: false, error: 'Something went wrong. Rescan the ticket.' }
  }

  return checkInTicket(caller, eventId, code)
}
```

(`loginPath()` reads the request path via headers, as the other actions' test mocks assume — keep the same `x-pathname` mock.)

- [ ] **Step 4: Run, expect green**

- [ ] **Step 5: The page**

`app/host/events/[id]/scan/page.tsx`:

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { getOwnedEvent } from '@/lib/events/queries'
import { deriveEventKeyHex } from '@/lib/tickets/signing'
import { serverEnv } from '@/lib/env'
import { Scanner } from './scanner'

export const metadata = { title: 'Scan tickets' }

export default async function ScanPage(props: PageProps<'/host/events/[id]/scan'>) {
  const { id } = await props.params
  await requireUser()

  // Ownership check, same as the guest list: a host who does not own this
  // event gets a 404, not a scanner.
  const event = await getOwnedEvent(id)
  if (!event) notFound()

  // The per-event key, derived on the server and handed to this host's
  // browser for this door only. That containment is the threat model in
  // lib/tickets/signing.ts: a compromised device at one door cannot forge
  // tickets for another event.
  const eventKeyHex = await deriveEventKeyHex(serverEnv().TICKET_SIGNING_SECRET, id)

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <Link href={`/host/events/${id}/attendees`} className="font-mono text-[13px] underline">
        ← Guest list
      </Link>
      <h1 className="mt-4 text-2xl font-semibold break-words">Scan tickets — {event.title}</h1>
      <Scanner eventId={id} eventKeyHex={eventKeyHex} />
    </main>
  )
}
```

- [ ] **Step 6: The scanner component**

`app/host/events/[id]/scan/scanner.tsx`. `'use client'`. The camera loop stays dumb; every decision lives in `reduceScan` (tested) or on the server. Structure:

```tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { eventKeyFromHex, verifyQrPayload } from '@/lib/tickets/signing'
import { checkInByCode } from './actions'
import { IDLE, reduceScan, type ScanSession, type ScanVerdict } from './scan-state'

/** How often the detector looks. Detection is cheap; admitting people is not a
 *  frame-rate problem. */
const DETECT_INTERVAL_MS = 300

// Minimal type for the native detector; TS has no built-in lib entry for it.
interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>
}
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => BarcodeDetectorLike
  }
}

export function Scanner({ eventId, eventKeyHex }: { eventId: string; eventKeyHex: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const sessionRef = useRef<ScanSession>(IDLE)
  const [session, setSession] = useState<ScanSession>(IDLE)
  const [camera, setCamera] = useState<'starting' | 'on' | 'unsupported' | 'denied'>('starting')

  // One dispatcher: applies the reducer, and if this event opened a new
  // pending flight, runs verification for it.
  const dispatch = useCallback(/* apply reduceScan to sessionRef, setSession,
    and when a 'detected' transition returns a NEW session with verdict
    'pending': verify locally with verifyQrPayload(eventKeyFromHex(eventKeyHex), payload);
    invalid → dispatch verdict {kind:'invalid', reason}; valid → await
    checkInByCode(eventId, result.code) → dispatch the mapped verdict
    ('checked_in' → 'in', 'already_checked_in' → 'already', !ok → 'refused'). */)

  useEffect(() => {
    // No detector → no camera. The guest list is the fallback and the page
    // says so; do not request camera permission for a screen that cannot use it.
    if (!window.BarcodeDetector) { setCamera('unsupported'); return }
    // getUserMedia({ video: { facingMode: 'environment' } }) → videoRef; on
    // rejection setCamera('denied'). Start an interval: detector.detect(video)
    // → first barcode's rawValue → dispatch({ type: 'detected', payload }).
    // Cleanup: clear interval, stop all tracks.
  }, [eventId, eventKeyHex, dispatch])

  // Render:
  // camera === 'unsupported' → "Point-and-scan needs Chrome on Android. Use
  //   the guest list to check people in." + link back.
  // camera === 'denied' → "Camera permission was refused." + retry note.
  // otherwise <video autoPlay muted playsInline> full-width, and beneath it
  //   the verdict card for session.current?.verdict:
  //   'pending'  → muted "Checking…"
  //   'in'       → green card: name ?? 'Guest', `${ticketsIn} of ${ticketsTotal} in`
  //   'already'  → amber card: "Already checked in", formatIst(new Date(checkedInAt))
  //   'refused'  → red card: the message
  //   'invalid'  → red card: "Not a ticket for this event."
  //   plus a Dismiss button → dispatch({ type: 'dismiss' })
}
```

The implementer writes the real component from this skeleton — the comments are the requirements. Verdict cards use the semantic hues the repo already uses for statuses (`bg-green-100 text-green-800`, `bg-amber-50 text-amber-800`, `bg-red-50 text-red-700`), sized for arm's length: name at `text-2xl`, one glance.

Note on `formatIst`: import from `@/lib/events/datetime` — the amber card's timestamp must read as IST like every other time in the product.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

- [ ] **Step 8: Verify in the browser (the degrade path is CI-testable, the camera is not)**

Desktop Chromium has no `BarcodeDetector`, so `localhost:3100/host/events/<id>/scan` must show the guest-list fallback message — that is the honest automated check. The camera path is verified on a physical Android phone against a QR on the booking page; record the result in the task report rather than pretending CI covered it.

- [ ] **Step 9: Commit**

```bash
git add "app/host/events/[id]/scan/"
git commit -m "Add the door scanner: local red, server truth"
```

---

### Task 9: Whole-branch verification

**Files:** none new.

- [ ] **Step 1: Full gates**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: everything green; test count strictly above 332 + (Task counts).

- [ ] **Step 2: End-to-end in a real browser**

1. Book 2 seats on a fresh free event as an attendee.
2. `/bookings/<reference>` shows 2 QRs labelled 1 of 2, 2 of 2.
3. Guest list shows "0 of 2 in"; Check in +1 → "1 of 2 in"; again → "2 of 2 in"; again → the EH022 sentence.
4. `/scan` as the host on desktop → fallback message (no BarcodeDetector).
5. `/scan` under a user who does not host the event → 404.
6. Phone-if-available: camera scan of QR 1 → green with name; rescan → amber with time. If no phone is at hand, write that down in the handoff — do not claim it verified.

- [ ] **Step 3: Update the lint-fence comment if stale, sweep `.superpowers/`/scratch files, then merge**

```bash
git checkout master
git merge --no-ff phase-2b-qr-scanner -m "Merge Phase 2b: QR tickets and the door scanner"
git push origin master
```

(`--no-ff` because that is the phase-branch convention — 2a merged as `da054f8`. Keep the `phase-2b-qr-scanner` branch afterwards, as `phase-0-foundations` and `phase-1-events` are kept as the phase record.)

---

## Self-review (run after writing, fixed inline)

- **Spec coverage:** migration+functions (T1), pure modules (T2), service+lint (T3), RLS reads+embeds (T4), QR page+env+dep (T5), guest-list check-in (T6), reducer (T7), scanner+action (T8), verification (T9). Spec's "known limitations" need no tasks. ✓
- **Type consistency:** `CheckInResult` defined once in T3, consumed in T6/T8 test mocks; reducer types defined in T7, consumed in T8; `BookingTicket` in T4, consumed in T5. `p_*` argument names match between T1 SQL and T3 `.rpc()` calls. ✓
- **Placeholders:** T8's scanner component is deliberately a commented skeleton rather than full JSX — the comments carry the complete requirements and every decision point is either in the tested reducer or the tested action. Everything else is verbatim.
