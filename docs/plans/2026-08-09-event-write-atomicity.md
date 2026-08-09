# Atomic Event Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One save of an event is one transaction, so a host is never told "failed" and left with half of what they typed already written.

**Architecture:** Two `SECURITY INVOKER` plpgsql functions called over PostgREST RPC by the existing RLS-scoped user client. PostgREST runs one RPC in one transaction, so the event write and the ticket-type write commit together or not at all. Invoker means every policy Phase 0 wrote still evaluates inside the function body, so nothing new is authorised.

**Tech Stack:** Postgres 17 (local Supabase), plpgsql, Next.js 16.3 Server Actions, TypeScript, supabase-js 2.x, Vitest 4.

**Spec:** [`docs/specs/2026-08-09-event-write-atomicity-design.md`](../specs/2026-08-09-event-write-atomicity-design.md)

## Global Constraints

- **Money is always integer paise.** `rupeesToPaise()` / `formatPaise()` from `lib/money.ts`. Never floats, never rupees in the database.
- **Never use `lib/supabase/admin.ts` in application code.** Server Actions use `@/lib/supabase/server`. The service role appears in tests only.
- **The slug is written once at insert and never updated.** Neither function takes a slug parameter on the update path.
- **Run `npm run db:types` after the migration.** `lib/supabase/types.ts` is committed.
- **`npm test` needs `npm run db:start`,** which needs Docker Desktop, which on this machine starts only via PowerShell: `powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`. Ready in ~10s. Without it, `npm test` fails with `createTestUser failed: fetch failed`, which reads like an app bug and is not one.
- **`lib/events/actions.test.ts` is order-dependent.** `eventId` and `slug` are set by earlier tests and later tests mutate the same event. Do not append tests to it; do not reorder it. New tests go in new files.
- **Existing suite is 205 tests across 14 files, all green.** Never finish a task with a red suite.
- **`C:` is ~98% full (~12 GB).** Run `npm run db:stop` when the session ends.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260809000001_event_write_transactions.sql` | **New.** Both functions, their `revoke`/`grant` pair, and the header explaining why the posture inverts `20260808000002`. |
| `lib/supabase/types.ts` | **Regenerated.** Gains typed `Args` for both functions. |
| `lib/events/rpc-errors.ts` | **New.** Pure. Maps a `PostgrestError` to the failure half of `EventFormState`. No imports from `actions.ts`. |
| `lib/events/rpc-errors.test.ts` | **New.** Unit, no database. |
| `lib/events/atomicity.test.ts` | **New.** Integration. Calls both RPCs directly and asserts the transaction boundary. Seeds and cleans up its own rows. |
| `app/host/events/actions.ts` | **Modified.** `createEvent` and `updateEvent` each become one `rpc()` call plus error mapping. The compensating `delete` and its failure branch are removed. |
| `lib/events/actions.test.ts` | **Modified.** Two tests replaced, one deleted, one adapted. Detailed per task. |

---

### Task 1: Observe the partial write

**This task produces no commit.** It exists so the change is made against measured behaviour rather than a comment's claim, and so the evidence can be quoted in Task 5's commit message.

**Files:**
- Create: `lib/events/probe.throwaway.test.ts` — **deleted at the end of this task, never committed**

**Interfaces:**
- Consumes: nothing
- Produces: an observation recorded in this document's "Evidence" section below

- [ ] **Step 1: Start the stack**

```bash
powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"
sleep 15
npm run db:start
```

- [ ] **Step 2: Write the probe**

This does not go through `updateEvent`. It cannot: `lib/events/validation.ts:117` refuses any form where `endsAtLocal <= startsAtLocal`, and the Zod length caps mirror the database's CHECK constraints, so **no input a host can submit makes the `events` write fail**. What the probe demonstrates is the mechanism — the same two writes, on the same two tables, in the same order the action makes them, showing that two PostgREST calls are two transactions.

```ts
// lib/events/probe.throwaway.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, userClient, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()
let seed: SeededEvent

beforeAll(async () => {
  seed = await seedEvent(db, { quantity: 20, status: 'draft' })
})

afterAll(async () => {
  await cleanupEvent(db, seed)
})

it('PROBE: the first write survives when the second is refused', async () => {
  const user = userClient(seed.hostProfileId)

  const { data: before } = await db
    .from('events')
    .select('starts_at, title')
    .eq('id', seed.eventId)
    .single()

  // Write one: seats. Exactly what updateEvent does first, and it succeeds.
  const { error: seatsError } = await user
    .from('ticket_types')
    .update({ quantity: 33, price_paise: 12_300 })
    .eq('id', seed.ticketTypeId)
  expect(seatsError).toBeNull()

  // Write two: the event row, made to fail on events_end_after_start.
  const badEnd = new Date(new Date(before!.starts_at).getTime() - 3600_000).toISOString()
  const { error: eventError } = await user
    .from('events')
    .update({ title: 'Probe Renamed', ends_at: badEnd })
    .eq('id', seed.eventId)
  expect(eventError).not.toBeNull()
  console.log('events write refused with:', eventError!.code, eventError!.message)

  const { data: after } = await db
    .from('ticket_types')
    .select('quantity, price_paise')
    .eq('id', seed.ticketTypeId)
    .single()
  const { data: event } = await db.from('events').select('title').eq('id', seed.eventId).single()

  console.log('AFTER  quantity:', after!.quantity, 'price:', after!.price_paise)
  console.log('AFTER  title:', event!.title, '(unchanged:', event!.title === before!.title, ')')

  // The gap, stated as an assertion. This SHOULD FAIL today.
  expect(after!.quantity).toBe(20)
})
```

- [ ] **Step 3: Run it and read the output**

```bash
npx vitest run lib/events/probe.throwaway.test.ts
```

Expected: **FAIL** on `expected 33 to be 20`, with the console lines showing `quantity: 33` and the title unchanged. That is the partial write: seats moved, nothing else did.

- [ ] **Step 4: Record the evidence**

Paste the three `console.log` lines and the failure line into the "Evidence" section at the bottom of this plan. They are quoted in Task 5's commit message.

- [ ] **Step 5: Delete the probe**

```bash
rm lib/events/probe.throwaway.test.ts
```

Confirm `git status` is clean apart from this plan file.

---

### Task 2: The migration

**Files:**
- Create: `supabase/migrations/20260809000001_event_write_transactions.sql`
- Modify: `lib/supabase/types.ts` (regenerated, not hand-edited)
- Test: `lib/events/atomicity.test.ts`

**Interfaces:**
- Consumes: `current_host_id()` from `20260808000003_rls_policies.sql`
- Produces, for Tasks 4 and 5:
  - `create_event_with_ticket_type(p_host_id uuid, p_slug text, p_title text, p_description text, p_city text, p_venue_name text, p_venue_address text, p_cover_image_url text, p_starts_at timestamptz, p_ends_at timestamptz, p_requires_approval boolean, p_allows_cash boolean, p_hide_venue_until_approved boolean, p_price_paise bigint, p_quantity integer) returns events`
  - `update_event_with_ticket_type(p_event_id uuid, p_title text, p_description text, p_city text, p_venue_name text, p_venue_address text, p_cover_image_url text, p_starts_at timestamptz, p_ends_at timestamptz, p_requires_approval boolean, p_allows_cash boolean, p_hide_venue_until_approved boolean, p_price_paise bigint, p_quantity integer) returns events`
  - SQLSTATE `EH001` — capacity below reserved; reserved count in `DETAIL`
  - SQLSTATE `EH002` — event not the caller's

- [ ] **Step 1: Write the failing test**

```ts
// lib/events/atomicity.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, userClient, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()
let seed: SeededEvent

/** Every parameter the update function takes, with sane values. */
function updateArgs(overrides: Record<string, unknown> = {}) {
  return {
    p_event_id: seed.eventId,
    p_title: 'Atomicity Probe Supper Club',
    p_description: null,
    p_city: 'Indore',
    p_venue_name: 'The Terrace',
    p_venue_address: null,
    p_cover_image_url: null,
    p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    p_ends_at: null,
    p_requires_approval: false,
    p_allows_cash: false,
    p_hide_venue_until_approved: false,
    p_price_paise: 50_000,
    p_quantity: 20,
    ...overrides,
  }
}

beforeAll(async () => {
  seed = await seedEvent(db, { quantity: 20, pricePaise: 50_000, status: 'draft' })
})

afterAll(async () => {
  await cleanupEvent(db, seed)
})

describe('update_event_with_ticket_type', () => {
  it('rolls the seats back when the event write is refused', async () => {
    const user = userClient(seed.hostProfileId)
    const starts = new Date(Date.now() + 7 * 24 * 3600 * 1000)

    // Seats change AND an ends_at that trips events_end_after_start. The seats
    // write happens first inside the function, so without a transaction it
    // would already have committed by the time the event write is refused.
    const { error } = await user.rpc(
      'update_event_with_ticket_type',
      updateArgs({
        p_quantity: 99,
        p_starts_at: starts.toISOString(),
        p_ends_at: new Date(starts.getTime() - 3600_000).toISOString(),
      }),
    )

    expect(error).not.toBeNull()

    const { data } = await db
      .from('ticket_types')
      .select('quantity')
      .eq('id', seed.ticketTypeId)
      .single()
    expect(data!.quantity).toBe(20) // never moved
  })

  it('reports the reserved count as EH001 rather than a constraint name', async () => {
    await db.from('ticket_types').update({ reserved_count: 5 }).eq('id', seed.ticketTypeId)
    const user = userClient(seed.hostProfileId)

    const { error } = await user.rpc('update_event_with_ticket_type', updateArgs({ p_quantity: 2 }))

    // This assertion pins the wire contract the mapper in Task 3 is built on:
    // the custom SQLSTATE reaches supabase-js as `code`, and DETAIL as `details`.
    expect(error?.code).toBe('EH001')
    expect(error?.details).toBe('5')

    await db.from('ticket_types').update({ reserved_count: 0 }).eq('id', seed.ticketTypeId)
  })

  it('refuses an event belonging to another host as EH002', async () => {
    const stranger = await seedEvent(db, { status: 'draft' })
    const user = userClient(stranger.hostProfileId)

    const { error } = await user.rpc('update_event_with_ticket_type', updateArgs())

    expect(error?.code).toBe('EH002')

    await cleanupEvent(db, stranger)
  })

  it('refuses a caller with no host row even when RLS is not in the picture', async () => {
    // The service role bypasses RLS entirely and carries no auth.uid(), so
    // current_host_id() is null. This is what proves the function's own host_id
    // scoping refuses a caller the policies would not have stopped — the same
    // defence in depth the `.eq('host_id', hostId)` in the TypeScript carried.
    const { error } = await db.rpc('update_event_with_ticket_type', updateArgs())

    expect(error?.code).toBe('EH002')
  })

  it('creates a ticket type when the event has none', async () => {
    const bare = await seedEvent(db, { status: 'draft' })
    await db.from('ticket_types').delete().eq('id', bare.ticketTypeId)
    const user = userClient(bare.hostProfileId)

    const { error } = await user.rpc('update_event_with_ticket_type', {
      ...updateArgs({ p_event_id: bare.eventId }),
      p_price_paise: 25_000,
      p_quantity: 7,
    })
    expect(error).toBeNull()

    const { data } = await db
      .from('ticket_types')
      .select('name, price_paise, quantity')
      .eq('event_id', bare.eventId)
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ name: 'General', price_paise: 25_000, quantity: 7 })

    await cleanupEvent(db, bare)
  })
})

describe('create_event_with_ticket_type', () => {
  it('leaves no event behind when the ticket type is invalid', async () => {
    const user = userClient(seed.hostProfileId)
    const slug = `atomicity-create-${crypto.randomUUID().slice(0, 8)}`

    // quantity 0 trips ticket_types' `check (quantity > 0)` on the second
    // insert. Note this same postcondition holds under the old compensating
    // delete, so it is a regression guard, not mutation evidence — see the spec.
    const { error } = await user.rpc('create_event_with_ticket_type', {
      p_host_id: seed.hostId,
      p_slug: slug,
      p_title: 'Create Atomicity Probe',
      p_description: null,
      p_city: 'Indore',
      p_venue_name: null,
      p_venue_address: null,
      p_cover_image_url: null,
      p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      p_ends_at: null,
      p_requires_approval: false,
      p_allows_cash: false,
      p_hide_venue_until_approved: false,
      p_price_paise: 50_000,
      p_quantity: 0,
    })

    expect(error).not.toBeNull()

    const { data } = await db.from('events').select('id').eq('slug', slug)
    expect(data ?? []).toHaveLength(0)
  })

  it('returns the event row so the caller can redirect to it', async () => {
    const user = userClient(seed.hostProfileId)
    const slug = `atomicity-ok-${crypto.randomUUID().slice(0, 8)}`

    const { data, error } = await user.rpc('create_event_with_ticket_type', {
      p_host_id: seed.hostId,
      p_slug: slug,
      p_title: 'Create Success Probe',
      p_description: null,
      p_city: 'Indore',
      p_venue_name: null,
      p_venue_address: null,
      p_cover_image_url: null,
      p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      p_ends_at: null,
      p_requires_approval: false,
      p_allows_cash: false,
      p_hide_venue_until_approved: false,
      p_price_paise: 50_000,
      p_quantity: 12,
    })

    expect(error).toBeNull()
    // `returns events` (not `setof events`), so PostgREST hands back one object.
    expect(data).toMatchObject({ slug, status: 'draft' })
    expect((data as { id: string }).id).toBeTruthy()

    await db.from('events').delete().eq('slug', slug)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run lib/events/atomicity.test.ts
```

Expected: FAIL on every test with PostgREST `PGRST202` — `Could not find the function public.update_event_with_ticket_type`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20260809000001_event_write_transactions.sql

-- Transactional event writes.
--
-- Saving an event means two writes: the events row and its ticket type. Two
-- PostgREST calls are two transactions, so before this file the second could be
-- refused with the first already committed — seats moved and nothing else, or an
-- event with no inventory that can never be published and no screen can repair.
-- These functions exist so that one save is one transaction.
--
-- Why this file inverts the posture of 20260808000002_reservation_functions.sql:
-- that file is SECURITY DEFINER with EXECUTE revoked from anon and
-- authenticated, because it guards inventory and money, which must be
-- unreachable from a crafted PostgREST call. These two guard a write the caller
-- is already entitled to make. Phase 0 granted `authenticated` scoped
-- insert/update on events and ticket_types, narrowed by current_host_id(), and
-- the RLS tests prove that model. SECURITY INVOKER -- the default, and stated
-- here by its absence -- runs the body as the calling role with the caller's
-- auth.uid(), so events_insert_own, events_update_own and ticket_types_write_own
-- evaluate on every statement inside exactly as they do today. Nothing new is
-- authorised. The statements only move into one transaction.
--
-- Custom SQLSTATEs, so the Server Action can turn a refusal into a sentence a
-- host can read rather than a constraint name:
--   EH001  capacity below reserved_count; DETAIL carries the reserved count
--   EH002  the event is not the caller's

-- ---------------------------------------------------------------------------
-- create_event_with_ticket_type
-- ---------------------------------------------------------------------------
-- The slug is generated in TypeScript (lib/events/slug.ts, unit-tested) and
-- passed in. Status is always 'draft': publishing is a separate, validated step.

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
  p_quantity                  integer
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
    hide_venue_until_approved, status
  )
  values (
    p_host_id, p_slug, p_title, p_description, p_city, p_venue_name,
    p_venue_address, p_cover_image_url, p_starts_at, p_ends_at,
    p_requires_approval, p_allows_cash, p_hide_venue_until_approved, 'draft'
  )
  returning * into ev;

  -- No compensating delete. If this raises, the insert above is rolled back by
  -- the transaction PostgREST opened for this call.
  insert into ticket_types (event_id, name, price_paise, quantity)
  values (ev.id, 'General', p_price_paise, p_quantity);

  return ev;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_event_with_ticket_type
-- ---------------------------------------------------------------------------
-- Deliberately takes no slug. The link may already be in a WhatsApp group.

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
  p_quantity                  integer
)
returns events
language plpgsql
set search_path = public
as $$
declare
  ev     events%rowtype;
  ticket ticket_types%rowtype;
begin
  -- Ownership settled before anything is written. Scoped on host_id as well as
  -- RLS: events_update_own would refuse a stranger anyway, and this is the
  -- statement that rewrites the row, so it carries its own scope -- the same
  -- defence in depth the `.eq('host_id', hostId)` in the TypeScript carried.
  -- It is also what refuses a service-role caller, for whom RLS does not apply
  -- and current_host_id() is null.
  select * into ev
    from events
   where id = p_event_id
     and host_id = current_host_id()
   for update;

  if ev.id is null then
    raise exception 'event % is not yours to edit', p_event_id
      using errcode = 'EH002';
  end if;

  -- The one the form is editing, not every one the event has. Ordered the way
  -- every read orders embedded ticket types -- see TICKET_TYPE_ORDER in
  -- lib/events/queries.ts -- so this is the row the edit form printed from.
  --
  -- `for update` serialises against a concurrent booking, which is what makes
  -- the check below still true at commit rather than merely true when read.
  select * into ticket
    from ticket_types
   where event_id = p_event_id
   order by sort_order, created_at
   limit 1
   for update;

  -- `ticket.id is null` rather than `found`: every statement resets `found`, so
  -- reading it after the branch below would be reading the wrong statement.
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
    -- An event with no ticket type is no longer reachable through this app, but
    -- rows predating this migration can be in that state. Inserting rather than
    -- writing nothing, because the alternative is accepting the host's seats and
    -- price, reporting "Saved." and discarding both.
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
         hide_venue_until_approved = p_hide_venue_until_approved
   where id = p_event_id
  returning * into ev;

  return ev;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reachability
-- ---------------------------------------------------------------------------
-- EXECUTE on a new function is granted to PUBLIC by default, which would put
-- both of these within reach of anon. Revoke first, then grant to the one role
-- that has any business calling them.

revoke execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) from public;

revoke execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) from public;

grant execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) to authenticated;

grant execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) to authenticated;
```

> **Watch the argument lists in the `revoke`/`grant` block.** `create_…` has one more `text` than `update_…` (it takes `p_slug`; `update_…` does not, and neither takes `p_host_id` on the update side). Getting these wrong fails loudly with `function … does not exist`, which is the good case — but the counts must match the definitions above exactly.

- [ ] **Step 4: Apply the migration and regenerate types**

```bash
npm run db:reset
npm run db:types
```

`db:reset` reruns every migration from scratch. Confirm it prints no error for the new file.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run lib/events/atomicity.test.ts
```

Expected: PASS, all 7 tests.

**If `expect(error?.details).toBe('5')` fails,** the `DETAIL` field does not survive to supabase-js as `details`. Do not work around it in the mapper yet — first log the whole error object (`console.log(JSON.stringify(error))`) and see which field carries `5`. If none does, change the `raise` to put the count in the message (`using errcode = 'EH001'` and message `'capacity below reserved:5'`) and parse it in Task 3, and record the change in that task's commit message. The spec anticipates this.

- [ ] **Step 6: Verify anon cannot call either function**

```bash
npx vitest run lib/events/atomicity.test.ts -t 'refuses a caller with no host'
```

Then confirm the revoke landed, by hand:

```bash
npx supabase db reset --debug 2>&1 | grep -i "event_write_transactions"
```

Expected: the migration name appears with no error.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260809000001_event_write_transactions.sql lib/supabase/types.ts lib/events/atomicity.test.ts
git commit
```

Message body should say: two functions, why invoker rather than definer, and that `EXECUTE` defaults to `PUBLIC` so the revoke is load-bearing rather than decorative.

---

### Task 3: The error mapper

**Files:**
- Create: `lib/events/rpc-errors.ts`
- Test: `lib/events/rpc-errors.test.ts`

**Interfaces:**
- Consumes: SQLSTATEs `EH001` and `EH002` from Task 2
- Produces: `mapEventRpcError(error: PostgrestError, seats: number): EventRpcFailure`, where `interface EventRpcFailure { error?: string; blockers?: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// lib/events/rpc-errors.test.ts
import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapEventRpcError } from '@/lib/events/rpc-errors'

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

describe('mapEventRpcError', () => {
  it('turns EH001 into the blocker a host can act on', () => {
    const state = mapEventRpcError(pgError({ code: 'EH001', details: '12' }), 8)

    // Word for word what the TypeScript pre-check used to return, so a host
    // sees no change and the assertion in actions.test.ts keeps meaning what
    // it meant.
    expect(state.blockers).toEqual([
      '12 of those seats are already taken, so capacity cannot go down to 8',
    ])
    expect(state.error).toBeUndefined()
  })

  it('puts oversell in blockers, never in error', () => {
    // The form renders the two differently: blockers are a fixable condition,
    // error is a fault. Collapsing them would show a host a red failure for
    // something they can correct by typing a bigger number.
    const state = mapEventRpcError(pgError({ code: 'EH001', details: '3' }), 1)
    expect(state.error).toBeUndefined()
    expect(state.blockers).toHaveLength(1)
  })

  it('turns EH002 into the ownership refusal', () => {
    const state = mapEventRpcError(pgError({ code: 'EH002' }), 20)
    expect(state).toEqual({ error: 'That event is not yours to edit' })
  })

  it('passes an unrecognised error through by message', () => {
    const state = mapEventRpcError(
      pgError({ code: '23514', message: 'new row violates check constraint' }),
      20,
    )
    expect(state).toEqual({ error: 'new row violates check constraint' })
  })

  it('does not print "null" when EH001 arrives without a detail', () => {
    // Defensive: if DETAIL is ever dropped in transit the host must still get a
    // sentence, not "null of those seats are already taken".
    const state = mapEventRpcError(pgError({ code: 'EH001', details: '' }), 8)
    expect(state.blockers![0]).toBe('Some of those seats are already taken, so capacity cannot go down to 8')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run lib/events/rpc-errors.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/events/rpc-errors"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/events/rpc-errors.ts
import type { PostgrestError } from '@supabase/supabase-js'

/**
 * The failure half of EventFormState.
 *
 * Declared here rather than imported from app/host/events/actions.ts, which is
 * a 'use server' module: this one is pure and unit-tested, and importing across
 * that boundary to reach a type would drag a server module into a test that
 * needs no server.
 */
export interface EventRpcFailure {
  error?: string
  blockers?: string[]
}

/** Capacity below reserved_count. DETAIL carries the reserved count. */
const OVERSELL = 'EH001'
/** The event is not the caller's — wrong id, or RLS refused it. */
const NOT_YOURS = 'EH002'

/**
 * Turns a refusal from the event-write functions into something a host can read.
 *
 * The wording is copied verbatim from the TypeScript checks these functions
 * replaced, so moving the logic into Postgres changed no sentence any host has
 * ever seen — and so the assertions in lib/events/actions.test.ts still test the
 * copy rather than being quietly rewritten to match whatever came out.
 *
 * Anything unrecognised falls through to the raw message. That is deliberate:
 * inventing a friendly sentence for an error nobody anticipated hides which one
 * it was, and this is a product whose failures reach a host by way of a form,
 * not a log.
 */
export function mapEventRpcError(error: PostgrestError, seats: number): EventRpcFailure {
  if (error.code === OVERSELL) {
    const reserved = error.details?.trim() || 'Some'
    return {
      blockers: [
        `${reserved} of those seats are already taken, so capacity cannot go down to ${seats}`,
      ],
    }
  }

  if (error.code === NOT_YOURS) return { error: 'That event is not yours to edit' }

  return { error: error.message }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run lib/events/rpc-errors.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/events/rpc-errors.ts lib/events/rpc-errors.test.ts
git commit
```

---

### Task 4: Rewire `createEvent`

**Files:**
- Modify: `app/host/events/actions.ts` — replace the body of `createEvent` from the `.from('events').insert(...)` call to the `redirect(...)`
- Modify: `lib/events/actions.test.ts` — replace one test, delete another, remove two now-unused helpers

**Interfaces:**
- Consumes: `create_event_with_ticket_type` (Task 2), `mapEventRpcError` (Task 3)
- Produces: no change to `createEvent`'s signature or its success behaviour

- [ ] **Step 1: Replace the write in `createEvent`**

Everything from `const { data: event, error } = await supabase` down to the final `redirect(...)` becomes:

```ts
  const { data: event, error } = await supabase.rpc('create_event_with_ticket_type', {
    p_host_id: hostId,
    p_slug: buildSlug(input.title), // written once, never updated
    p_title: input.title,
    p_description: input.description ?? null,
    p_city: input.city,
    p_venue_name: input.venueName ?? null,
    p_venue_address: input.venueAddress ?? null,
    p_cover_image_url: input.coverImageUrl ?? null,
    p_starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
    p_ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
    p_requires_approval: input.requiresApproval,
    p_allows_cash: input.allowsCash,
    p_hide_venue_until_approved: input.hideVenueUntilApproved,
    p_price_paise: rupeesToPaise(input.priceRupees),
    p_quantity: input.seats,
  })

  // One call, one transaction. The event and its ticket type land together or
  // not at all, which is why there is no compensating delete here any more --
  // and no branch for that delete having failed, which used to be the only
  // thing standing between a host and an event that could never be published.
  if (error) return { ...mapEventRpcError(error, input.seats), values: submittedValues(formData) }

  redirect(`/host/events/${event.id}/edit`)
```

Add `import { mapEventRpcError } from '@/lib/events/rpc-errors'` to the imports.

- [ ] **Step 2: Replace the rollback test**

In `lib/events/actions.test.ts`, replace the whole of `it('deletes the event again when its ticket type cannot be created', …)` (currently lines 244–264) with:

```ts
  it('surfaces a refused save without creating anything', async () => {
    // The rollback this used to test no longer exists: one RPC is one
    // transaction, so there is nothing to compensate for. What still has to
    // hold is that the host is told, and that nothing survives. The seam moved
    // from from() to rpc(), so the injection moved with it.
    const failing = clientWithRpc(userClient(aliceId), () => ({
      data: null,
      error: { code: '23514', message: 'simulated ticket_types rejection', details: '', hint: '' },
    }))

    const state = await actionsWith(failing, (actions) =>
      actions.createEvent({}, form({ title: ROLLBACK_TITLE })),
    )

    expect(state.error).toBe('simulated ticket_types rejection')

    const { data } = await db.from('events').select('id').eq('title', ROLLBACK_TITLE)
    expect(data ?? []).toHaveLength(0)
  })
```

- [ ] **Step 3: Delete the stranded-event test**

Delete `it('names the stranded event when the rollback itself fails', …)` in its entirety (currently lines 266–289), and the now-unused `STRANDED_TITLE`, `insertFails`, `deleteFails` and `updateFails` helpers — but only once Task 5 has also stopped using `updateFails`; if doing this task alone, leave `updateFails` and remove it in Task 5.

This is a deliberate deletion of a passing test, and the commit message must say so. The behaviour it pinned — naming the stranded event id in the error so a human can clean it up by hand — is being removed on purpose, because the state it described is no longer reachable. A test kept for a branch that no longer exists is worse than no test: it would have to be rewritten to assert something the code does not do.

- [ ] **Step 4: Add the `clientWithRpc` helper**

Next to `clientWithFrom` in `lib/events/actions.test.ts`:

```ts
/**
 * A real client with `rpc()` redirected. The mirror of clientWithFrom, for the
 * seam the event writes moved to. Everything else -- `auth` above all -- stays
 * real, so the action still resolves a real session and a real host id.
 */
function clientWithRpc(
  base: SupabaseClient,
  override: (fn: string) => { data: unknown; error: unknown },
): SupabaseClient {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'rpc') return async (fn: string) => override(fn)
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
```

- [ ] **Step 5: Run the createEvent tests**

```bash
npx vitest run lib/events/actions.test.ts -t createEvent
```

Expected: PASS. The five surviving `createEvent` tests — the Postgres-columns rejection, implicit host creation, the display-name floor, IST conversion, and the paise-priced ticket type — must all still pass untouched, because none of them depends on how the two writes were issued.

- [ ] **Step 6: Commit**

```bash
git add app/host/events/actions.ts lib/events/actions.test.ts
git commit
```

Say in the message that a test was deleted and why.

---

### Task 5: Rewire `updateEvent`

**Files:**
- Modify: `app/host/events/actions.ts` — replace the body of `updateEvent` between the `parseEventForm` block and the host-rename block
- Modify: `lib/events/actions.test.ts` — adapt two tests

**Interfaces:**
- Consumes: `update_event_with_ticket_type` (Task 2), `mapEventRpcError` (Task 3)
- Produces: no change to `updateEvent`'s signature or its success behaviour

- [ ] **Step 1: Replace the reads and writes**

Everything from `// Ownership is settled before anything is written` down to the line before `// Last, and on its own row` becomes:

```ts
  // One call, one transaction. Ownership, the oversell check, the seats write
  // and the event write all happen under it -- so the check that refuses a
  // capacity cut is still true when the write lands, rather than merely true
  // when it was read. See supabase/migrations/20260809000001.
  const { data: event, error } = await supabase.rpc('update_event_with_ticket_type', {
    p_event_id: eventId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_city: input.city,
    p_venue_name: input.venueName ?? null,
    p_venue_address: input.venueAddress ?? null,
    p_cover_image_url: input.coverImageUrl ?? null,
    p_starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
    p_ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
    p_requires_approval: input.requiresApproval,
    p_allows_cash: input.allowsCash,
    p_hide_venue_until_approved: input.hideVenueUntilApproved,
    p_price_paise: rupeesToPaise(input.priceRupees),
    p_quantity: input.seats,
  })

  // Especially on the oversell path: the host may have just typed the venue
  // that clears a publish blocker, and this refusal must not take it away.
  if (error) return { ...mapEventRpcError(error, input.seats), values: submittedValues(formData) }
```

The `revalidatePath` at the end changes from `existing.slug` to `event.slug`. The function never writes the slug, so the returned value is the stored one.

Note that `hostId` is still needed — the host-rename block below uses it — so keep the `getCurrentHost()` call and its comment.

- [ ] **Step 2: Adapt the injected-failure test**

Replace `it('surfaces a rejected seats write and leaves the event alone', …)` (currently lines 474–491) with:

```ts
  it('surfaces a refused save and leaves the event alone', async () => {
    // The pre-check cannot catch a booking that lands between the read and the
    // write, so ticket_types_no_oversell is still the backstop and the action
    // must not swallow it. Injected, because that race cannot be staged here.
    //
    // The message is now the database's own rather than the old
    // "Could not update seats: ..." prefix. That prefix named which of two
    // writes failed, and there are no longer two writes to distinguish.
    const failing = clientWithRpc(userClient(aliceId), () => ({
      data: null,
      error: { code: '23514', message: 'simulated no_oversell rejection', details: '', hint: '' },
    }))

    const fd = form({ title: 'Half-saved', city: 'Bhopal' })
    fd.set('eventId', eventId)

    const state = await actionsWith(failing, (actions) => actions.updateEvent({}, fd))
    expect(state.error).toBe('simulated no_oversell rejection')

    const { data } = await db.from('events').select('title, city').eq('id', eventId).single()
    expect(data).toMatchObject({ title: 'Diwali Supper Club (fixed typo)', city: 'Indore' })
  })
```

- [ ] **Step 3: Adapt the RLS-free ownership test**

`it('refuses that same edit with RLS taken out of the picture', …)` (currently lines 412–443) builds a client that authenticates as Bob but reaches **tables** as the service role, via `clientWithFrom`. `updateEvent` no longer calls `from()` for these writes, so that proxy now intercepts nothing and the test would pass without testing anything.

Replace its client and its comment with:

```ts
  it('refuses that same edit with RLS taken out of the picture', async () => {
    // The test above cannot tell the function's own host_id scoping from the
    // events_update_own policy: both refuse Bob. So run it once more on a
    // client that reaches the RPC as the service role, for which RLS does not
    // apply at all -- leaving `host_id = current_host_id()` inside the function
    // as the only thing between a caller and Alice's event. current_host_id()
    // reads auth.uid(), which the service role does not carry, so it is null
    // and the scoping refuses.
    //
    // Nothing in the app builds such a client -- lib/supabase/server always
    // returns an RLS-scoped one. This exists so the defence in depth is a
    // tested claim rather than a comment.
    // Values that differ from the stored ones on every writable table, so an
    // unowned edit that got past the scoping would leave a visible mark.
    const fd = form({ title: 'Defaced without RLS', seats: '3', priceRupees: '1' })
    fd.set('eventId', eventId)

    const serviceRoleRpc = new Proxy(userClient(bobId), {
      get(target, prop) {
        if (prop === 'rpc') return db.rpc.bind(db)
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SupabaseClient

    const state = await actionsWith(serviceRoleRpc, (actions) => actions.updateEvent({}, fd))
    expect(state.error).toBe('That event is not yours to edit')
    expect(state.ok).toBeUndefined()

    const { data } = await db.from('events').select('title').eq('id', eventId).single()
    expect(data!.title).toBe('Diwali Supper Club (fixed typo)')

    const { data: tickets } = await db
      .from('ticket_types')
      .select('price_paise, quantity')
      .eq('event_id', eventId)
      .single()
    expect(tickets).toMatchObject({ price_paise: 50_000, quantity: 20 })
  })
```

Note this test builds its proxy inline rather than using `clientWithRpc`: it needs the *real* service-role `rpc`, not a canned response, so the two are not interchangeable.

- [ ] **Step 4: Remove the now-dead helpers**

`insertFails`, `updateFails` and `deleteFails` have no remaining callers. Delete all three, and `STRANDED_TITLE` if Task 4 left it. Keep `clientWithFrom`: the publish and unpublish tests still use it.

Verify with:

```bash
grep -n "insertFails\|updateFails\|deleteFails\|STRANDED_TITLE" lib/events/actions.test.ts
```

Expected: no output.

- [ ] **Step 5: Run the whole file**

```bash
npx vitest run lib/events/actions.test.ts
```

Expected: PASS. In particular `'refuses to cut seats below what is already reserved, writing nothing'` must pass **unmodified** — it is the test that proves `EH001` maps back to the same sentence the TypeScript pre-check produced.

- [ ] **Step 6: Commit**

```bash
git add app/host/events/actions.ts lib/events/actions.test.ts
git commit
```

Quote the Task 1 evidence in the body: the observed `quantity: 33` against an unchanged title is what this commit makes impossible.

---

### Task 6: Verify and tidy

**Files:**
- Modify: `app/host/events/actions.ts` — the module-level comment block, if it still describes the old shape
- Modify: `docs/specs/2026-08-09-event-write-atomicity-design.md` — correct the "byte-identical wording" claim

**Interfaces:**
- Consumes: everything above
- Produces: a green suite and no stale comments

- [ ] **Step 1: Full suite**

```bash
npm test
```

Expected: all files green. Count should be 205 − 2 deleted + 12 added = **215**, though treat the arithmetic as a sanity check, not a gate.

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Both must be clean. `next typegen` runs as part of `typecheck`.

- [ ] **Step 3: Re-read the comments in `actions.ts`**

Every comment that describes two statements, a rollback, or an ordering chosen because there is no transaction is now wrong. Specifically check:
- the long comment above `const seatValues` (deleted with the code it described)
- the "Seats first, deliberately" paragraph
- any remaining mention of "not atomic"

A comment left describing a mechanism that no longer exists is the failure mode this repo's own handoff warns about. Remove or rewrite each.

- [ ] **Step 4: Correct the spec**

The spec says the mapped wording is "identical to the current strings". That holds for `EH001` and `EH002`, and does **not** hold for the removed `Could not update seats: …` prefix or the removed "quote event id …" sentence. Add a line under "Errors" saying which two strings ceased to exist and why: both named which of two writes had failed, and there are no longer two writes to name.

- [ ] **Step 5: Stop the stack**

```bash
npm run db:stop
```

`C:` is ~98% full; leaving it running is what the last handoff asked the next session to fix.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit
```

---

## Evidence

_Filled in by Task 1, Step 4. Quoted by Task 5's commit._

```
(paste the probe output here)
```

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task: the two functions and the invoker rationale to Task 2; the error table to Task 3; `createEvent`'s removal of the compensating delete to Task 4; `updateEvent`'s ordering and `for update` to Tasks 2 and 5; the `npm run db:types` and Docker constraints to Global Constraints; the "no mutation evidence for createEvent" caveat to Task 2 Step 1's inline comment. The spec's "Noted, not fixed" item is deliberately unimplemented.

**Known gap between spec and plan.** The spec's testing section implies the committed atomicity test drives the action. It cannot — `lib/events/validation.ts:117` rejects every form input that would make the `events` write fail, so the failure is unreachable from a form. The plan drives the RPC directly instead and adds Task 1 to capture the mutation evidence separately. Task 6 Step 4 corrects the spec.

**Naming consistency.** `mapEventRpcError(error, seats)` is used with that signature in Tasks 3, 4 and 5. `clientWithRpc(base, override)` is defined in Task 4 Step 4 and used in Tasks 4 and 5. `updateArgs(overrides)` is local to `atomicity.test.ts`. Parameter names are `p_`-prefixed in SQL and in every `rpc()` call.
