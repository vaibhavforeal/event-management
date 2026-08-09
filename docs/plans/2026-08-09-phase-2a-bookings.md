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
- **Only free, no-approval events are bookable.** `price_paise = 0` and `requires_approval = false`. Enforced in SQL, not only in the action.
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
| `supabase/migrations/20260810000001_book_free_tickets.sql` | **New.** `book_free_tickets()`, its guards, its revoke/grant pair. |
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

Reads and writes are split into two modules on purpose: `queries.ts` runs under RLS like every other read in this repo, and `service.ts` is the single quarantined place where RLS does not apply.

---

### Task 1: `book_free_tickets()`

**Files:**
- Create: `supabase/migrations/20260810000001_book_free_tickets.sql`
- Modify: `lib/supabase/types.ts` (regenerated, never hand-edited)
- Test: `lib/bookings/book-free-tickets.test.ts`

**Interfaces:**
- Consumes: `reserve_tickets`, `confirm_booking` from `20260808000002_reservation_functions.sql`
- Produces: `book_free_tickets(p_ticket_type_id uuid, p_attendee_id uuid, p_quantity integer, p_attendee_note text) returns bookings`; SQLSTATE `EH010` (not free), `EH011` (requires approval)

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
  it('confirms the booking and issues one ticket per seat', async () => {
    const { data, error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: free.attendeeId,
      p_quantity: 3,
      p_attendee_note: null,
    })

    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'confirmed', quantity: 3, total_paise: 0 })
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
      p_attendee_note: null,
    })

    expect(error?.code).toBe('EH011')

    await cleanupEvent(db, gated)
  })

  it('passes through reserve_tickets\' own refusals', async () => {
    // Not remapped: "only N seats remain" is already a sentence for a human.
    const { error } = await db.rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: free.attendeeId,
      p_quantity: 99,
      p_attendee_note: null,
    })

    expect(error?.message).toContain('seats remain')
  })

  it('is unreachable by a signed-in user over the public API', async () => {
    // Inventory functions are service-role only. This one joins them.
    const { userClient } = await import('@/tests/helpers/db')
    const { error } = await userClient(free.attendeeId).rpc('book_free_tickets', {
      p_ticket_type_id: free.ticketTypeId,
      p_attendee_id: free.attendeeId,
      p_quantity: 1,
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

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260810000001_book_free_tickets.sql

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
--
-- `extensions` on the search_path because confirm_booking needs pgcrypto's
-- gen_random_bytes for ticket codes, and it inherits this setting when called
-- from here.

create or replace function book_free_tickets(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
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

  return confirm_booking(booking.id);
end;
$$;

-- EXECUTE on a new function is granted to PUBLIC by default. Revoking from
-- public also strips service_role, which is neither a superuser nor a member of
-- authenticated -- so the grant back is required, not decorative. anon is named
-- explicitly because a hosted project may carry default privileges that survive
-- a revoke from PUBLIC.
revoke execute on function book_free_tickets(uuid, uuid, integer, text)
  from public, anon, authenticated;

grant execute on function book_free_tickets(uuid, uuid, integer, text)
  to service_role;
```

- [ ] **Step 4: Apply and regenerate types**

```bash
npm run db:reset
npm run db:types
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run lib/bookings/book-free-tickets.test.ts
```

Expected: PASS, 5 tests.

**If `booking := reserve_tickets(...)` fails to compile,** the composite assignment form is the problem, not the logic. Replace it with:

```sql
  select * into booking from reserve_tickets(
    p_ticket_type_id, p_attendee_id, p_quantity, 0, 0, 'online', 10, p_attendee_note
  ) as r;
```

and say in your report which form you used.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260810000001_book_free_tickets.sql lib/supabase/types.ts lib/bookings/book-free-tickets.test.ts
git commit
```

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
  - `bookFreeTickets(caller: Caller, ticketTypeId: string, quantity: number, note?: string): Promise<BookingResult>` where `type BookingResult = { ok: true; reference: string } | { ok: false; error: string }`
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

/** Application code cannot fabricate a Caller; a test may. */
function callerOf(id: string): Caller {
  return { id } as Caller
}

beforeAll(async () => {
  event = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
  const { createTestUser } = await import('@/tests/helpers/db')
  strangerId = await createTestUser(db)
})

afterAll(async () => {
  await cleanupEvent(db, event)
  await db.auth.admin.deleteUser(strangerId).catch(() => {})
})

describe('bookFreeTickets', () => {
  it('returns the reference a host reads at the door', async () => {
    const result = await bookFreeTickets(callerOf(event.attendeeId), event.ticketTypeId, 2)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reference).toMatch(/^[0-9A-HJ-NP-TV-Z]{8}$/)
  })

  it('books for the caller, never for an id it was handed', async () => {
    // The signature has no attendee-id parameter at all. This asserts the row
    // that lands carries the caller's id, so a future refactor that adds one
    // and threads a form field through it fails here.
    const result = await bookFreeTickets(callerOf(strangerId), event.ticketTypeId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { data } = await db
      .from('bookings')
      .select('attendee_id')
      .eq('reference', result.reference)
      .single()
    expect(data!.attendee_id).toBe(strangerId)
  })

  it('reports a refusal as a sentence, not a constraint', async () => {
    const result = await bookFreeTickets(callerOf(event.attendeeId), event.ticketTypeId, 99)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('seats remain')
  })
})

describe('cancelBooking', () => {
  async function freshBooking(): Promise<string> {
    const result = await bookFreeTickets(callerOf(event.attendeeId), event.ticketTypeId, 1)
    if (!result.ok) throw new Error(`setup booking failed: ${result.error}`)
    const { data } = await db
      .from('bookings')
      .select('id')
      .eq('reference', result.reference)
      .single()
    return data!.id
  }

  it('lets the attendee cancel and returns the seat', async () => {
    const bookingId = await freshBooking()
    const { data: before } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', event.ticketTypeId)
      .single()

    const result = await cancelBooking(callerOf(event.attendeeId), bookingId)
    expect(result.ok).toBe(true)

    const { data: after } = await db
      .from('ticket_types')
      .select('reserved_count')
      .eq('id', event.ticketTypeId)
      .single()
    expect(after!.reserved_count).toBe(before!.reserved_count - 1)
  })

  it('lets the host of the event cancel it', async () => {
    const bookingId = await freshBooking()

    const result = await cancelBooking(callerOf(event.hostProfileId), bookingId)

    expect(result.ok).toBe(true)
    const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
    expect(data!.status).toBe('cancelled')
  })

  it('refuses a stranger, writing nothing', async () => {
    // RLS is not in this path — the write goes through the service role — so
    // this assertion is the only thing standing between a stranger and someone
    // else's seat.
    const bookingId = await freshBooking()

    const result = await cancelBooking(callerOf(strangerId), bookingId)

    expect(result.ok).toBe(false)
    const { data } = await db.from('bookings').select('status').eq('id', bookingId).single()
    expect(data!.status).toBe('confirmed')

    await cancelBooking(callerOf(event.attendeeId), bookingId)
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
  note?: string,
): Promise<BookingResult> {
  const db = createAdminClient()

  const { data, error } = await db.rpc('book_free_tickets', {
    p_ticket_type_id: ticketTypeId,
    // The caller's own id. There is no parameter through which a request could
    // supply someone else's, and there must never be one.
    p_attendee_id: caller.id,
    p_quantity: quantity,
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

Expected: PASS, 3 + 8 tests.

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
  - `interface EventAttendee { id: string; reference: string; quantity: number; status: string; created_at: string; profiles: { full_name: string | null; phone: string } | null }`
  - `listEventAttendees(eventId: string): Promise<EventAttendee[]>`

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

  const result = await bookFreeTickets(callerOf(event.attendeeId), event.ticketTypeId, 2)
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
  it('lets the host see who is coming', async () => {
    signInAs(event.hostProfileId)
    const attendees = await listEventAttendees(event.eventId)

    expect(attendees).toHaveLength(1)
    expect(attendees[0].quantity).toBe(2)
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
  quantity: number
  status: string
  created_at: string
  profiles: { full_name: string | null; phone: string } | null
}

/** Who is coming to one event. Empty unless the caller hosts it. */
export async function listEventAttendees(eventId: string): Promise<EventAttendee[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('bookings')
    .select('id, reference, quantity, status, created_at, profiles(full_name, phone)')
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

  const result = await bookFreeTickets(caller, ticketTypeId, quantity)
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
  const bookable =
    !!ticket && !soldOut && ticket.price_paise === 0 && !event.requires_approval
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
              {soldOut ? 'Sold out' : 'Booking opens soon'}
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
                {/* full_name is nullable — nothing writes it yet — so the phone
                    is the fallback a host can actually use to find someone. */}
                <p className="truncate font-medium">{a.profiles?.full_name ?? 'Guest'}</p>
                <p className="font-mono text-[12px] text-neutral-600">
                  {a.profiles?.phone ?? ''} · {a.quantity}{' '}
                  {a.quantity === 1 ? 'seat' : 'seats'} · {a.reference}
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
      buyers.map((id) => bookFreeTickets(callerOf(id), event.ticketTypeId, 1)),
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

    const booked = await bookFreeTickets(callerOf(buyer), seeded.ticketTypeId, 4)
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

## Self-review notes

**Spec coverage.** Trust boundary and its mitigations → Tasks 2 and 3 (branded `Caller`, `mayCancel`, the lint rule with a probe that proves it fires). `book_free_tickets` and its guards → Task 1. Error mapping → Task 3. The four screens → Tasks 5, 6, 7. Concurrency, authorisation-as-failed-attempts, cancellation returning inventory, the guards, `mayCancel` unit tests, and `EH001` becoming reachable → Tasks 1, 3, 4 and 8. The migration and `db:types` → Task 1. The 2b notes are deliberately unimplemented.

**Known gap between spec and plan.** The spec names `lib/bookings/service.ts` as the only `admin.ts` importer and does not mention `lib/bookings/queries.ts`. The plan splits reads out into that second module, on the RLS-scoped client, so the quarantined file contains only writes. This narrows the service-role surface rather than widening it, and it is the split that makes the lint rule meaningful.

**Naming consistency.** `Caller` and `currentCaller()` (Task 2) are used in Tasks 3, 5, 6, 7. `mayCancel(caller, booking)` with `CancellableBooking { attendee_id, event_host_profile_id }` (Task 2) is called only in Task 3. `bookFreeTickets(caller, ticketTypeId, quantity, note?)` and `cancelBooking(caller, bookingId, reason?)` (Task 3) are used in Tasks 5, 6, 7, 8. `MyBooking` and `EventAttendee` (Task 4) are used in Tasks 6 and 7. Every Server Action state type is named `BookState` or `CancelState` and declared beside its action.

**One correction made during review.** The plan first called a `formatIstDateTime(starts_at)` that does not exist. `lib/events/datetime.ts` exports `formatIst(date: Date)`, which takes a `Date` and not the ISO string `starts_at` is. Both call sites in Task 6 now read `formatIst(new Date(...))`. Verified against the module rather than assumed.

**Still unverified, and cheap to get wrong.** Task 4's `listEventAttendees` assumes the host-side booking policy in `20260808000003_rls_policies.sql` scopes a host to bookings on events they own. Task 4 Step 4 says explicitly: if the stranger case returns rows, that is an RLS finding to report, not a test to adjust.
