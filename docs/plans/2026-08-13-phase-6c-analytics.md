# Phase 6c — See the Business: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator's numbers — money, cash ratio, events & attendance — as a server-rendered strip on `/admin`, computed by one admin-gated SQL aggregate plus the settlement statements the page already holds.

**Architecture:** A new `admin_business_snapshot(p_event_ids uuid[] default null)` SQL function (SECURITY DEFINER, `is_platform_admin()` gate, EH071) returns one row of raw counts and paise sums; `lib/analytics/rates.ts` is pure math from that row (and the page's `SettleableEvent[]`) to display values; `lib/analytics/queries.ts` is the fail-closed read; `app/admin/business-strip.tsx` renders it. The owed/settled numbers are summed from `listSettleableEvents` rows — `settle()` stays the only interpreter of owed money; those two numbers never enter SQL.

**Tech Stack:** Next.js server components, Supabase (PostgREST + plpgsql), Vitest, the session-mock test seam (`tests/helpers/session.ts`).

**Spec:** `docs/specs/2026-08-13-phase-6c-analytics-design.md`. Read it first; the metric-definitions table is the contract.

## Global Constraints

- Money is integer paise everywhere; guard derived sums with `assertPaise` (`lib/money.ts:13`).
- A failed money/business read THROWS — pages fail to render rather than show wrong numbers. Never render a failed read as zero.
- Mutation checks are full-file runs, live, never `-t`-filtered; SQL mutants are applied with `docker exec -i supabase_db_Event_Hoster psql -U postgres -d postgres < file.sql` and restored by re-running the real migration file afterwards.
- Apply the migration with `npx supabase migration up` — NOT `npm run db:reset` (it destroys dev walkthrough data; there is no seed.sql).
- In the new SQL function, every column reference must be table-qualified (`b.commission_paise`, never bare `commission_paise`) — the OUT-parameter names shadow real column names and plpgsql errors on ambiguity.
- Migration style: prose docblock naming its EH codes, `revoke … from public, anon;` then `grant … to authenticated, service_role;` tail.
- Error code EH071 ("not a platform admin") is reused; no new codes. EH001–EH077 are taken.
- Work on branch `phase-6c-analytics` off master. Commit per task. Merge/push happens in Task 6 only.
- `p_event_ids` scoping exists FOR TESTS (deterministic numbers under a parallel suite writing to the same DB); production always calls it with no argument. Task 5 amends the spec with one sentence recording this.

---

### Task 1: Migration + snapshot RPC tests

**Files:**
- Create: `supabase/migrations/20260813000002_admin_business_snapshot.sql`
- Create: `lib/analytics/snapshot-rpc.test.ts`

**Interfaces:**
- Produces: SQL function `admin_business_snapshot(p_event_ids uuid[] default null)` returning one row with columns (all bigint): `gmv_paise, refunds_processed_paise, commission_paise, cash_confirmed_paise, online_confirmed_paise, cash_confirmed_count, confirmed_count, events_live, events_ended, capacity_seats, confirmed_seats, tickets_issued, tickets_checked_in, waitlisted_count`. Task 2's `BusinessSnapshot` interface mirrors these names exactly (as `number`).

- [ ] **Step 1: Create the branch**

```bash
git checkout master && git checkout -b phase-6c-analytics
```

- [ ] **Step 2: Write the migration**

`supabase/migrations/20260813000002_admin_business_snapshot.sql`:

```sql
-- The operator's numbers: one admin-gated aggregate over the platform.
--
-- Error codes in this file:
--   EH071  not a platform admin (reused from 20260812000003)
--
-- One function, no tables, no stored state — every number is derived on
-- read, like drift. The two settlement numbers (owed to hosts, settled to
-- date) are deliberately NOT here: TypeScript settle() is the only
-- interpreter of owed money, and the console sums those from the
-- statements it already computes.
--
-- Definitions come from docs/specs/2026-08-13-phase-6c-analytics-design.md:
--  * Money facts are platform-wide whatever the event's status — money
--    that moved, moved. GMV counts captured AND refunded payments (a
--    refunded payment was captured first; a capture never un-refunds).
--    Refunds count only status = 'processed' — pending money has not
--    returned yet.
--  * Fill is scoped to published events; check-ins to ENDED published
--    events (an ongoing event's unscanned tickets are not no-shows yet).
--    "Ended" is 6a's coalesce(ends_at, starts_at) < now(), mirroring
--    lib/events/datetime.ts hasEnded.
--  * The waitlist is a booking status, not a table.
--
-- p_event_ids scopes every aggregate to those events, joined through
-- bookings.event_id. It exists for the tests: the suite runs files in
-- parallel against one database, so platform-wide totals are moving
-- targets, but numbers scoped to a test's own events are exact.
-- Production always calls this with no argument.

create or replace function admin_business_snapshot(p_event_ids uuid[] default null)
returns table (
  gmv_paise               bigint,
  refunds_processed_paise bigint,
  commission_paise        bigint,
  cash_confirmed_paise    bigint,
  online_confirmed_paise  bigint,
  cash_confirmed_count    bigint,
  confirmed_count         bigint,
  events_live             bigint,
  events_ended            bigint,
  capacity_seats          bigint,
  confirmed_seats         bigint,
  tickets_issued          bigint,
  tickets_checked_in      bigint,
  waitlisted_count        bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- First statement, before anything is read.
  if not is_platform_admin() then
    raise exception 'not a platform admin' using errcode = 'EH071';
  end if;

  return query
  select
    coalesce((select sum(p.amount_paise)::bigint
       from payments p
       join bookings b on b.id = p.booking_id
      where p.status in ('captured', 'refunded')
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(r.amount_paise)::bigint
       from refunds r
       join payments p on p.id = r.payment_id
       join bookings b on b.id = p.booking_id
      where r.status = 'processed'
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(b.commission_paise)::bigint
       from bookings b
      where exists (select 1 from payments p
                     where p.booking_id = b.id
                       and p.status in ('captured', 'refunded'))
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(b.subtotal_paise)::bigint
       from bookings b
      where b.status = 'confirmed' and b.payment_mode = 'cash'
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(b.subtotal_paise)::bigint
       from bookings b
      where b.status = 'confirmed' and b.payment_mode = 'online'
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    (select count(*)
       from bookings b
      where b.status = 'confirmed' and b.payment_mode = 'cash'
        and (p_event_ids is null or b.event_id = any (p_event_ids))),
    (select count(*)
       from bookings b
      where b.status = 'confirmed'
        and (p_event_ids is null or b.event_id = any (p_event_ids))),
    (select count(*)
       from events e
      where e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) >= now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    (select count(*)
       from events e
      where e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) < now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    coalesce((select sum(tt.quantity)::bigint
       from ticket_types tt
       join events e on e.id = tt.event_id
      where e.status = 'published'
        and (p_event_ids is null or e.id = any (p_event_ids))), 0),
    coalesce((select sum(b.quantity)::bigint
       from bookings b
       join events e on e.id = b.event_id
      where b.status = 'confirmed' and e.status = 'published'
        and (p_event_ids is null or e.id = any (p_event_ids))), 0),
    (select count(*)
       from tickets t
       join bookings b on b.id = t.booking_id
       join events e on e.id = b.event_id
      where e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) < now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    (select count(*)
       from tickets t
       join bookings b on b.id = t.booking_id
       join events e on e.id = b.event_id
      where t.checked_in_at is not null
        and e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) < now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    (select count(*)
       from bookings b
      where b.status = 'waitlisted'
        and (p_event_ids is null or b.event_id = any (p_event_ids)));
end;
$$;

revoke execute on function admin_business_snapshot(uuid[]) from public, anon;
grant execute on function admin_business_snapshot(uuid[]) to authenticated, service_role;
```

- [ ] **Step 3: Apply it**

Run: `npx supabase migration up`
Expected: `Applying migration 20260813000002_admin_business_snapshot.sql... Migrations applied`

- [ ] **Step 4: Write the RPC tests**

`lib/analytics/snapshot-rpc.test.ts`. Fixture notes the numbers depend on:
`seedCapturedBooking` always writes `quantity: 1`; when `refunded: true` it
creates a `processed` refund of the full subtotal and the payment row STAYS
`captured`; each booking on the same event needs a distinct `attendeeId`
(one-active-booking-per-attendee index).

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  anonClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  seedPlatformAdmin,
  userClient,
  type SeededEvent,
} from '@/tests/helpers/db'

/**
 * admin_business_snapshot(), called the way the app will — as a signed-in
 * user through PostgREST. Every numeric assertion is SCOPED via p_event_ids
 * to this file's own fixtures: the suite runs files in parallel against one
 * database, so platform-wide totals are moving targets, but our own events'
 * numbers are exact.
 */

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let endedFx: SeededEvent
let liveFx: SeededEvent
let cancelledFx: SeededEvent
const extraUsers: string[] = []

const ticketCode = () => crypto.randomUUID().replace(/-/g, '')

async function scoped(caller: string) {
  return userClient(caller).rpc('admin_business_snapshot', {
    p_event_ids: [endedFx.eventId, liveFx.eventId, cancelledFx.eventId],
  })
}

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)

  endedFx = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  liveFx = await seedEvent(db, { startsAt: new Date(Date.now() + 24 * HOUR).toISOString() })
  // Ended by time AND cancelled: its money still counts (money that moved,
  // moved — the spec's scoping rule), but it is neither live nor ended in
  // the event counts, and its capacity/seats stay out of fill.
  cancelledFx = await seedEvent(db, {
    startsAt: new Date(Date.now() - 30 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 29 * HOUR).toISOString(),
  })
  for (let i = 0; i < 4; i += 1) extraUsers.push(await createTestUser(db))

  // The money story:
  //   b1  endedFx     confirmed online ₹500 captured, ₹50 commission → GMV, online gross, take rate
  //   b2  endedFx     refunded ₹400, processed refund; its payment row is
  //       flipped to 'refunded' below — GMV must still count it (the refunded arm)
  //   b3  endedFx     confirmed cash ₹250, no payment                → cash gross + count
  //   b4  endedFx     waitlisted, no payment                         → waitlist depth
  //   b5  endedFx     refunded ₹100, refund flipped to 'pending'     → in GMV, NOT in refunds returned
  //   b6  liveFx      confirmed online ₹200 captured, one UNSCANNED ticket
  //       → in GMV and fill, but its ticket must stay OUT of tickets_issued
  //         (check-ins are ended-events-only: not a no-show yet)
  //   b7  cancelledFx confirmed online ₹150 captured → in GMV and confirmed
  //       counts (money facts ignore event status), out of everything
  //       event-scoped
  const b1 = await seedCapturedBooking(db, endedFx, { subtotalPaise: 50_000, commissionPaise: 5_000 })
  const b2 = await seedCapturedBooking(db, endedFx, {
    status: 'refunded', refunded: true, subtotalPaise: 40_000, attendeeId: extraUsers[0],
  })
  const b3 = await seedCapturedBooking(db, endedFx, {
    paymentMode: 'cash', captured: false, subtotalPaise: 25_000, attendeeId: extraUsers[1],
  })
  await seedCapturedBooking(db, endedFx, {
    status: 'waitlisted', captured: false, subtotalPaise: 50_000, attendeeId: extraUsers[2],
  })
  const b5 = await seedCapturedBooking(db, endedFx, {
    status: 'refunded', refunded: true, subtotalPaise: 10_000, attendeeId: extraUsers[3],
  })
  const b6 = await seedCapturedBooking(db, liveFx, { subtotalPaise: 20_000 })
  await seedCapturedBooking(db, cancelledFx, { subtotalPaise: 15_000 })
  await db.from('events').update({ status: 'cancelled' }).eq('id', cancelledFx.eventId)

  // Production shapes the fixtures can't write directly:
  await db.from('payments').update({ status: 'refunded' }).eq('id', b2.paymentId!)
  await db.from('refunds').update({ status: 'pending' }).eq('payment_id', b5.paymentId!)

  // Attendance: two tickets on the ended event (one scanned), one on the
  // live event that must not be counted.
  const { data: tickets, error: ticketsError } = await db
    .from('tickets')
    .insert([
      { booking_id: b1.bookingId, code: ticketCode(), checked_in_at: new Date().toISOString() },
      { booking_id: b3.bookingId, code: ticketCode() },
      { booking_id: b6.bookingId, code: ticketCode() },
    ])
    .select('id')
  if (ticketsError || (tickets ?? []).length !== 3) {
    throw new Error(`ticket seed failed: ${ticketsError?.message}`)
  }
})

afterAll(async () => {
  // tickets cascade with their bookings (core_schema.sql:244), so
  // cleanupEvent's booking delete takes them too.
  await cleanupEvent(db, endedFx)
  await cleanupEvent(db, liveFx)
  await cleanupEvent(db, cancelledFx)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
  for (const id of extraUsers) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('admin_business_snapshot', () => {
  it('refuses a signed-in non-admin', async () => {
    const { error } = await scoped(outsiderId)
    expect(error?.code).toBe('EH071')
  })

  it('refuses a truly anonymous caller at the grant, before the gate', async () => {
    const { error } = await anonClient().rpc('admin_business_snapshot')
    expect(error?.code).toBe('42501')
  })

  it('computes every number over the seeded fixtures', async () => {
    const { data, error } = await scoped(adminId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]).toEqual({
      gmv_paise: 135_000,               // 50k + 40k refunded-arm + 10k pending-refund + 20k live + 15k cancelled
      refunds_processed_paise: 40_000,  // b5's pending refund is not returned money
      commission_paise: 5_000,          // proves the sum accumulates when fees turn on
      cash_confirmed_paise: 25_000,
      online_confirmed_paise: 85_000,   // b1 + b6 + b7; b2/b5 are refunded, not confirmed
      cash_confirmed_count: 1,
      confirmed_count: 4,               // b1 + b3 + b6 + b7 (money facts ignore event status)
      events_live: 1,                   // cancelledFx is neither live nor ended
      events_ended: 1,
      capacity_seats: 20,               // endedFx + liveFx; cancelledFx is not published
      confirmed_seats: 3,               // b1 + b3 + b6, quantity 1 each; b7's event unpublished
      tickets_issued: 2,                // b6's live-event ticket is not a no-show candidate
      tickets_checked_in: 1,
      waitlisted_count: 1,
    })
  })

  it('answers the whole platform when unscoped — at least what our fixtures put in', async () => {
    const { data, error } = await userClient(adminId).rpc('admin_business_snapshot')
    expect(error).toBeNull()
    const platform = data![0]
    // Monotone smoke only: other test files write to the same database in
    // parallel, so equality would flake. The exact math is pinned above.
    expect(platform.gmv_paise).toBeGreaterThanOrEqual(135_000)
    expect(platform.waitlisted_count).toBeGreaterThanOrEqual(1)
    expect(platform.events_ended).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 5: Run the file**

Run: `npx vitest run lib/analytics/snapshot-rpc.test.ts`
Expected: 4 passed. If the `toEqual` fails, the diff names the wrong column — fix the SQL, not the expectation, unless the fixture math above is provably wrong.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260813000002_admin_business_snapshot.sql lib/analytics/snapshot-rpc.test.ts
git commit -m "feat: admin_business_snapshot — the operator's numbers, gated in SQL"
```

---

### Task 2: Pure rate math

**Files:**
- Create: `lib/analytics/rates.ts`
- Create: `lib/analytics/rates.test.ts`

**Interfaces:**
- Consumes: `SettleableEvent` (`lib/payouts/queries.ts` — uses only `.statement.netPaise`, `.payout?.status`, `.payout?.net_paise`), `assertPaise`/`Paise` (`lib/money.ts`).
- Produces: `interface BusinessSnapshot` (fields exactly as Task 1's SQL columns, typed `number`); `CASH_RATIO_THRESHOLD = 0.3`; `ratio(n, d): number | null`; `cashCountRatio`, `cashValueRatio`, `fillRate`, `checkInRate`, `takeRate` (each `(s: BusinessSnapshot) => number | null`); `cashFlag(s): boolean`; `netGmvPaise(s): Paise`; `payoutTotals(rows): { owedPaise: Paise; settledPaise: Paise }`. Tasks 3–4 import these names verbatim.

- [ ] **Step 1: Write the failing tests**

`lib/analytics/rates.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CASH_RATIO_THRESHOLD,
  cashCountRatio,
  cashFlag,
  cashValueRatio,
  checkInRate,
  fillRate,
  netGmvPaise,
  payoutTotals,
  ratio,
  takeRate,
  type BusinessSnapshot,
} from '@/lib/analytics/rates'

function snapshot(over: Partial<BusinessSnapshot> = {}): BusinessSnapshot {
  return {
    gmv_paise: 0,
    refunds_processed_paise: 0,
    commission_paise: 0,
    cash_confirmed_paise: 0,
    online_confirmed_paise: 0,
    cash_confirmed_count: 0,
    confirmed_count: 0,
    events_live: 0,
    events_ended: 0,
    capacity_seats: 0,
    confirmed_seats: 0,
    tickets_issued: 0,
    tickets_checked_in: 0,
    waitlisted_count: 0,
    ...over,
  }
}

describe('ratio', () => {
  it('is null on a zero denominator — no data is not 0%', () => {
    expect(ratio(5, 0)).toBeNull()
  })
  it('divides otherwise', () => {
    expect(ratio(1, 4)).toBe(0.25)
  })
})

describe('an empty platform', () => {
  it('answers null everywhere a rate needs data, never NaN', () => {
    const s = snapshot()
    expect(cashCountRatio(s)).toBeNull()
    expect(cashValueRatio(s)).toBeNull()
    expect(fillRate(s)).toBeNull()
    expect(checkInRate(s)).toBeNull()
    expect(takeRate(s)).toBeNull()
    expect(cashFlag(s)).toBe(false)
    expect(netGmvPaise(s)).toBe(0)
  })
})

describe('the cash flag', () => {
  it('stays quiet below the threshold', () => {
    expect(cashFlag(snapshot({ cash_confirmed_count: 299, confirmed_count: 1000 }))).toBe(false)
  })
  it('fires AT the threshold — at the threshold is at the threshold', () => {
    expect(cashFlag(snapshot({ cash_confirmed_count: 300, confirmed_count: 1000 }))).toBe(true)
  })
  it('fires past it', () => {
    expect(cashFlag(snapshot({ cash_confirmed_count: 301, confirmed_count: 1000 }))).toBe(true)
  })
})

describe('value vs count divergence', () => {
  it('a few large cash bookings hide in the count ratio and show in the value ratio', () => {
    const s = snapshot({
      cash_confirmed_count: 1,
      confirmed_count: 10,
      cash_confirmed_paise: 90_000,
      online_confirmed_paise: 10_000,
    })
    expect(cashCountRatio(s)).toBe(0.1)
    expect(cashValueRatio(s)).toBe(0.9)
  })
})

describe('netGmvPaise', () => {
  it('subtracts processed refunds from GMV', () => {
    expect(netGmvPaise(snapshot({ gmv_paise: 100_000, refunds_processed_paise: 40_000 }))).toBe(60_000)
  })
})

describe('payoutTotals', () => {
  const statement = (netPaise: number) =>
    ({ statement: { netPaise } }) as Parameters<typeof payoutTotals>[0][number]
  const paid = (netPaise: number, settledNet: number) =>
    ({
      statement: { netPaise },
      payout: { status: 'paid', net_paise: settledNet },
    }) as Parameters<typeof payoutTotals>[0][number]
  const onHold = (netPaise: number) =>
    ({
      statement: { netPaise },
      payout: { status: 'on_hold', net_paise: 0 },
    }) as Parameters<typeof payoutTotals>[0][number]

  it('sums unpaid statements as owed, frozen paid rows as settled', () => {
    const totals = payoutTotals([statement(50_000), paid(50_000, 80_000), onHold(20_000)])
    // The paid row contributes its FROZEN net (what left the bank), not the
    // recomputation; the on-hold row is still owed.
    expect(totals).toEqual({ owedPaise: 70_000, settledPaise: 80_000 })
  })

  it('is all zeros with no ended events', () => {
    expect(payoutTotals([])).toEqual({ owedPaise: 0, settledPaise: 0 })
  })

  it('says the threshold is 30%', () => {
    expect(CASH_RATIO_THRESHOLD).toBe(0.3)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/analytics/rates.test.ts`
Expected: FAIL — cannot resolve `@/lib/analytics/rates`.

- [ ] **Step 3: Implement**

`lib/analytics/rates.ts`:

```ts
import { assertPaise, type Paise } from '@/lib/money'
import type { SettleableEvent } from '@/lib/payouts/queries'

/**
 * Pure math from the snapshot row (and the console's settlement statements)
 * to display values. Pure on purpose, following lib/payouts/settlement.ts:
 * handed numbers, it returns numbers — no database, no clock — so the whole
 * of the business arithmetic is testable in milliseconds.
 *
 * Rates are fractions (0.25), null when the denominator is empty: "no data
 * yet" is not 0% and must not render as it.
 */

/** One row of raw platform aggregates from admin_business_snapshot(). */
export interface BusinessSnapshot {
  gmv_paise: number
  refunds_processed_paise: number
  commission_paise: number
  cash_confirmed_paise: number
  online_confirmed_paise: number
  cash_confirmed_count: number
  confirmed_count: number
  events_live: number
  events_ended: number
  capacity_seats: number
  confirmed_seats: number
  tickets_issued: number
  tickets_checked_in: number
  waitlisted_count: number
}

/** The v1 design doc's rethink-threshold: cash at or past this share of confirmed bookings. */
export const CASH_RATIO_THRESHOLD = 0.3

/** numerator/denominator as a fraction, or null when there is nothing to divide by. */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return numerator / denominator
}

export function cashCountRatio(s: BusinessSnapshot): number | null {
  return ratio(s.cash_confirmed_count, s.confirmed_count)
}

export function cashValueRatio(s: BusinessSnapshot): number | null {
  return ratio(s.cash_confirmed_paise, s.cash_confirmed_paise + s.online_confirmed_paise)
}

/** True at or past the threshold — at the threshold IS at the threshold. */
export function cashFlag(s: BusinessSnapshot): boolean {
  const r = cashCountRatio(s)
  return r !== null && r >= CASH_RATIO_THRESHOLD
}

export function fillRate(s: BusinessSnapshot): number | null {
  return ratio(s.confirmed_seats, s.capacity_seats)
}

export function checkInRate(s: BusinessSnapshot): number | null {
  return ratio(s.tickets_checked_in, s.tickets_issued)
}

export function takeRate(s: BusinessSnapshot): number | null {
  return ratio(s.commission_paise, s.gmv_paise)
}

export function netGmvPaise(s: BusinessSnapshot): Paise {
  const net = s.gmv_paise - s.refunds_processed_paise
  assertPaise(net, 'netGmvPaise')
  return net
}

/**
 * Owed and settled, summed from the statements the console already computes
 * via listSettleableEvents — settle() stays the only interpreter of owed
 * money; these two numbers never get a second SQL definition. A paid row
 * contributes its FROZEN net (what left the bank); everything else — no
 * payout yet, or on hold — is still owed.
 */
export function payoutTotals(
  rows: Array<Pick<SettleableEvent, 'statement' | 'payout'>>,
): { owedPaise: Paise; settledPaise: Paise } {
  let owedPaise = 0
  let settledPaise = 0
  for (const row of rows) {
    if (row.payout?.status === 'paid') settledPaise += row.payout.net_paise
    else owedPaise += row.statement.netPaise
  }
  assertPaise(owedPaise, 'owedPaise')
  assertPaise(settledPaise, 'settledPaise')
  return { owedPaise, settledPaise }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/analytics/rates.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/analytics/rates.ts lib/analytics/rates.test.ts
git commit -m "feat: pure rate math for the business strip"
```

---

### Task 3: The fail-closed read

**Files:**
- Create: `lib/analytics/queries.ts`
- Create: `lib/analytics/queries.test.ts`

**Interfaces:**
- Consumes: `createClient` (`@/lib/supabase/server`), `BusinessSnapshot` (Task 2).
- Produces: `businessSnapshot(): Promise<BusinessSnapshot>` — Task 4 calls it from the admin page.

- [ ] **Step 1: Implement**

`lib/analytics/queries.ts`:

```ts
import 'server-only'
import type { BusinessSnapshot } from '@/lib/analytics/rates'
import { createClient } from '@/lib/supabase/server'

/**
 * The one read for the operator's numbers, through the ordinary session
 * client — the database answers the admin question (EH071), not this file.
 * A failed read THROWS: the console fails to render rather than showing
 * wrong business numbers. Same ruling as every money read since 6a.
 */
export async function businessSnapshot(): Promise<BusinessSnapshot> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_business_snapshot')
  if (error) throw new Error(`Failed to read the business snapshot: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as BusinessSnapshot | undefined
  if (!row) throw new Error('Failed to read the business snapshot: no row came back')
  return row
}
```

- [ ] **Step 2: Write the seam tests**

`businessSnapshot()` builds its own client, so it is tested through the
session mock (`tests/helpers/session.ts` — importing it installs the mock;
the module under test must be bound with a top-level `await import` AFTER,
see that file's docblock). Create `lib/analytics/queries.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { signInAs } from '@/tests/helpers/session'
import { adminClient, seedPlatformAdmin } from '@/tests/helpers/db'

// After every static import: the mock in session.ts must be installed before
// this module binds @/lib/supabase/server. See that file's docblock.
const { businessSnapshot } = await import('@/lib/analytics/queries')

describe('businessSnapshot', () => {
  it('throws for a non-admin rather than rendering zeros', async () => {
    // EH071 from the RPC must surface as a throw — a failed read must not
    // read as "an empty business".
    signInAs(null)
    await expect(businessSnapshot()).rejects.toThrow(/Failed to read the business snapshot/)
  })

  it('returns the one row to an admin', async () => {
    const db = adminClient()
    const adminId = await seedPlatformAdmin(db)
    try {
      signInAs(adminId)
      const row = await businessSnapshot()
      expect(typeof row.gmv_paise).toBe('number')
      expect(typeof row.waitlisted_count).toBe('number')
    } finally {
      signInAs(null)
      await db.auth.admin.deleteUser(adminId).catch(() => {})
    }
  })
})
```

- [ ] **Step 3: Run both analytics files**

Run: `npx vitest run lib/analytics`
Expected: all pass (the non-admin call hits the revoked-for-anon grant → error → throw).

- [ ] **Step 4: Commit**

```bash
git add lib/analytics/queries.ts lib/analytics/queries.test.ts
git commit -m "feat: fail-closed businessSnapshot read"
```

---

### Task 4: The strip on /admin

**Files:**
- Create: `app/admin/business-strip.tsx`
- Modify: `app/admin/page.tsx` (import + one line after the `<h1>`; pass `events`)

**Interfaces:**
- Consumes: `businessSnapshot()` (Task 3), everything from `rates.ts` (Task 2), `formatPaise` (`lib/money.ts:41`), `SettleableEvent[]` — the page's existing `events` value from `listSettleableEvents()` (`app/admin/page.tsx:20`).
- Produces: `<BusinessStrip snapshot events />` server component.

- [ ] **Step 1: Consult the dataviz skill**

Invoke the `dataviz` skill (it covers stat tiles / KPI rows) and let it shape
the tile markup within the house classes already on this page
(`border-line rounded-xl border`, `text-muted`, `bg-amber-50`-style accents).
The structure below is the contract; the skill refines the presentation.

- [ ] **Step 2: Write the component**

`app/admin/business-strip.tsx` (baseline — adapt presentation per Step 1,
keep the data wiring and copy exactly):

```tsx
import {
  cashCountRatio,
  cashFlag,
  cashValueRatio,
  checkInRate,
  fillRate,
  netGmvPaise,
  payoutTotals,
  takeRate,
  type BusinessSnapshot,
} from '@/lib/analytics/rates'
import { formatPaise } from '@/lib/money'
import type { SettleableEvent } from '@/lib/payouts/queries'

/** "24%", or an em-dash when there is no data to divide — never "NaN%". */
function pct(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`
}

export function BusinessStrip({
  snapshot,
  events,
}: {
  snapshot: BusinessSnapshot
  events: SettleableEvent[]
}) {
  const { owedPaise, settledPaise } = payoutTotals(events)
  const flagged = cashFlag(snapshot)

  const tiles: Array<{ label: string; value: string; detail?: string; alert?: boolean }> = [
    {
      label: 'GMV',
      value: formatPaise(snapshot.gmv_paise),
      detail: `net ${formatPaise(netGmvPaise(snapshot))} after ${formatPaise(snapshot.refunds_processed_paise)} refunded`,
    },
    {
      label: 'Take rate',
      value: pct(takeRate(snapshot)),
      detail: formatPaise(snapshot.commission_paise),
    },
    {
      label: 'Owed to hosts',
      value: formatPaise(owedPaise),
      detail: `settled ${formatPaise(settledPaise)}`,
    },
    {
      label: 'Cash share',
      value: pct(cashCountRatio(snapshot)),
      detail: `${pct(cashValueRatio(snapshot))} by value · ${formatPaise(snapshot.cash_confirmed_paise)} the hosts hold — watch at 30%`,
      alert: flagged,
    },
    {
      label: 'Events',
      value: `${snapshot.events_live} live · ${snapshot.events_ended} ended`,
      detail: `${snapshot.waitlisted_count} waitlisted`,
    },
    {
      label: 'Fill',
      value: pct(fillRate(snapshot)),
      detail: `check-in ${pct(checkInRate(snapshot))} of ended`,
    },
  ]

  return (
    <section aria-label="The business at a glance" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className={`rounded-xl border p-3 ${
            tile.alert ? 'border-amber-300 bg-amber-50' : 'border-line'
          }`}
        >
          <p className={`text-xs ${tile.alert ? 'text-amber-900' : 'text-muted'}`}>{tile.label}</p>
          <p className={`text-lg font-semibold ${tile.alert ? 'text-amber-900' : ''}`}>{tile.value}</p>
          {tile.detail && (
            <p className={`text-xs ${tile.alert ? 'text-amber-800' : 'text-muted'}`}>{tile.detail}</p>
          )}
        </div>
      ))}
    </section>
  )
}
```

- [ ] **Step 3: Wire the page**

In `app/admin/page.tsx`: add imports

```tsx
import { businessSnapshot } from '@/lib/analytics/queries'
import { BusinessStrip } from '@/app/admin/business-strip'
```

after `const events = await listSettleableEvents()` (line 20) add:

```tsx
  const snapshot = await businessSnapshot()
```

and directly after the `<h1 …>Settlements</h1>` line render:

```tsx
      <BusinessStrip snapshot={snapshot} events={events} />
```

- [ ] **Step 4: Typecheck, lint, and walk it**

Run: `npm run typecheck && npm run lint`
Expected: clean.

Browser sanity (the stack is already up): `npm run dev` (port 3100 per
package.json), sign in as `919999900001` (OTP `123456`), open `/admin`:
the strip renders over the walkthrough data (`walk-ended-supper` is settled,
so "settled" carries its net and the drift fixture still shows below).
A non-admin (`919999900003`) still 404s. `/host/payouts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add app/admin/business-strip.tsx app/admin/page.tsx
git commit -m "feat: the business strip on /admin"
```

---

### Task 5: Mutation wave + spec amendments

**Files:**
- Modify: `docs/specs/2026-08-13-phase-6c-analytics-design.md`
- Temporary: `.mutants/` (deleted before commit)

- [ ] **Step 1: SQL mutants, one at a time**

For each, write the mutant to `.mutants/m.sql` as a full
`create or replace function admin_business_snapshot …` copy with ONE change,
apply with `docker exec -i supabase_db_Event_Hoster psql -U postgres -d postgres < .mutants/m.sql`,
run `npx vitest run lib/analytics/snapshot-rpc.test.ts` (full file), confirm
the named test goes red, then restore with
`docker exec -i supabase_db_Event_Hoster psql -U postgres -d postgres < supabase/migrations/20260813000002_admin_business_snapshot.sql`.

1. GMV arm: `p.status in ('captured', 'refunded')` → `= 'captured'`.
   Expected red: "computes every number" (gmv 95 000 — b2's flipped payment dropped).
2. Refunds filter: `r.status = 'processed'` → drop the predicate.
   Expected red: same test (refunds 50 000 — b5's pending refund leaks in).
3. Check-in scope: remove `coalesce(e.ends_at, e.starts_at) < now()` from the
   tickets_issued subquery.
   Expected red: same test (issued 3 — b6's live-event ticket leaks in).
4. Gate: remove the EH071 raise. Expected red: "refuses a signed-in non-admin".

- [ ] **Step 2: TS mutants, one at a time**

1. `rates.ts`: `if (denominator === 0) return null` → delete the guard.
   Run `npx vitest run lib/analytics/rates.test.ts`; expected red: the empty-platform test (NaN).
2. `rates.ts`: `r >= CASH_RATIO_THRESHOLD` → `r > CASH_RATIO_THRESHOLD`.
   Expected red: "fires AT the threshold".
3. `rates.ts`: `payoutTotals` paid branch → always add `row.statement.netPaise`.
   Expected red: "sums unpaid statements as owed, frozen paid rows as settled" (80 000 vs 50 000).

Revert each after its red run; `rm -rf .mutants`; finish with
`npx vitest run lib/analytics` green.

- [ ] **Step 3: Amend the spec**

In `docs/specs/2026-08-13-phase-6c-analytics-design.md`, Design section,
after the migration paragraph add:

```markdown
**Execution amendment (2026-08-13):** the function takes
`p_event_ids uuid[] default null` — null means the whole platform
(production always passes nothing); an array scopes every aggregate to
those events. The parameter exists for the tests: the suite runs files in
parallel against one database, so platform-wide totals are moving targets,
while a test's own events' numbers are exact.
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-08-13-phase-6c-analytics-design.md
git commit -m "docs: record the p_event_ids testability seam in the 6c spec"
```

---

### Task 6: Full suite, review, merge

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: 921 + 17 new = 938± all green (the webhook race file is a fixed
probabilistic net — if IT flakes, that is a regression of the 6b fix, stop
and investigate; see the memory note).

- [ ] **Step 2: Fresh-eyes review**

Dispatch a code-reviewer subagent over `git diff master...phase-6c-analytics`
with the spec as context (same shape as the 6a/6b reviews). Addressing
findings follows the house pattern: fix material ones, triage deliberate
trades into the spec.

- [ ] **Step 3: Merge and push**

```bash
git checkout master
git merge --no-ff phase-6c-analytics -m "Merge Phase 6c: see the business"
git push origin master
```

Branch kept local, per convention.
