# Phase 6a — The settlement loop: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an event ends, the operator sees exactly what each host is owed, pays by UPI, and records the transfer; the host sees the same statement.

**Architecture:** The money math is a pure TypeScript module handed rows — no I/O, no clock of its own — following `lib/notifications/sweep.ts`. Authorisation is a `platform_admins` table and an `is_platform_admin()` predicate used inside RLS, so both screens run on the ordinary session client and **nothing joins the four-file service-role fence**. The two things RLS cannot do — reach column-granted payout secrets, and write `payouts` — go through `SECURITY DEFINER` functions gated on the same predicate.

**Tech Stack:** Next.js 15 App Router (Server Components + Server Actions), TypeScript, Supabase Postgres with RLS, Tailwind, vitest.

**Spec:** [`docs/specs/2026-08-12-phase-6a-settlement-design.md`](../specs/2026-08-12-phase-6a-settlement-design.md). Where this plan and the spec disagree, the spec wins — except for the one refinement recorded under "Deviations from the spec" below.

## Global Constraints

Every task's requirements implicitly include this section.

- **Money is an integer count of paise.** Use `lib/money.ts` (`Paise`, `assertPaise`, `formatPaise`). Never a float, never rupees, never `toFixed`.
- **Fees and commission stay ₹0.** No task passes a non-zero fee or commission to any SQL function, and no task calls `lib/pricing/`. The ledger reads `bookings.commission_paise` and nothing else. This is what makes it correct on the day fees turn on.
- **Mutation-test every new assertion before believing it.** Break the implementation the test covers, run the test, watch it go **red**, then revert. The previous session shipped **sixteen** tests that could not fail; a settlement test that cannot fail is a wrong payment nobody catches. A test you have not seen fail is not evidence.
- **Never add a file to the eslint service-role fence.** Nothing under `lib/payouts/` or `app/admin/` may import `@/lib/supabase/admin` (or `../supabase/admin`, or `./admin`). `eslint.config.mjs` will error; that error is correct and must not be suppressed or worked around.
- **Every new SQL function** is `security definer` with `set search_path = public`, and — for the admin-gated ones — `if not is_platform_admin() then raise` as its **first statement**, before it reads anything.
- **Error codes** are raised as `raise exception 'message' using errcode = 'EH0xx';`. **EH070–EH079 are this phase's block**; EH065 is the highest currently in use. Do not reuse a code below EH070.
- **Commands:** `npm test` (vitest run), `npm run lint`, `npm run typecheck`. Integration tests need the local stack: `npm run db:start`. After **any** migration change, run `npm run db:reset` **and then** `npm run db:types` — `lib/supabase/types.ts` is generated and typecheck will fail without it.
- **Tests run with `TZ=UTC`** and `fileParallelism: false` (a shared local Postgres). Timeouts are 30s.
- Commit after each task's tests pass. Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `docs:`) matching the existing log.

## Deviations from the spec

One, and it is a refinement rather than a change of behaviour.

The spec says read policies "gain `or is_platform_admin()`". This plan instead **adds separate policies** (`events_select_admin`, `bookings_select_admin`, …). Postgres OR-s multiple permissive policies for the same command, so the effect is identical — but it touches no existing policy, needs no `drop policy`, and matches the idiom already in `20260808000003_rls_policies.sql`, where `events_select_published` and `events_select_own` are two policies rather than one disjunction. It is also the reviewable form: a new policy is an addition to read, not a diff inside an existing security rule.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `lib/events/datetime.ts` | Gains `hasEnded` beside `hasStarted`, failing closed in the opposite direction | 1 |
| `lib/events/datetime.test.ts` | Its tests, including the contrast with `hasStarted` | 1 |
| `lib/payouts/settlement.ts` | **Pure.** Which bookings count, and the arithmetic. Imports only `lib/money` | 2 |
| `lib/payouts/settlement.test.ts` | One test per counting rule; no database | 2 |
| `tests/helpers/db.ts` | `SeedOptions.startsAt/endsAt`, `seedPlatformAdmin`, and a `cleanupEvent` that no longer leaks | 3 |
| `supabase/migrations/20260812000002_platform_admins.sql` | `platform_admins`, `is_platform_admin()`, the five admin read policies | 3 |
| `lib/supabase/rls.test.ts` | Extended with the platform-admin visibility assertions | 3 |
| `supabase/migrations/20260812000003_payout_settlement.sql` | `forfeited_paise`, the freeze trigger, `record_payout`, `admin_host_payout_target` | 4 |
| `lib/payouts/payout-rpc.test.ts` | The definer gates, the freeze, the ended guard | 4 |
| `lib/payouts/queries.ts` | Session-client reads: settleable events, an event's rows, a host's statements | 5 |
| `lib/payouts/service.ts` | The two RPC wrappers. **Not** service-role | 5 |
| `lib/payouts/queries.test.ts` | Integration tests for both | 5 |
| `lib/payouts/admin.ts` | `isPlatformAdmin()` / `requirePlatformAdmin()` for the route segment | 6 |
| `app/admin/page.tsx` | The console | 6 |
| `app/admin/actions.ts` | `recordPayoutAction` | 6 |
| `app/admin/record-payout-form.tsx` | The UTR + notes form | 6 |
| `app/admin/actions.test.ts` | The route gate, and the action's authorisation and validation | 6 |
| `app/host/payouts/page.tsx` | The host statement page | 7 |
| `app/host/page.tsx` | A link to `/host/payouts` | 7 |

---

### Task 1: `hasEnded`

The predicate everything else keys on. Small, but it carries its own test cycle because getting its fail-direction wrong silently pays hosts for events that have not happened.

**Files:**
- Modify: `lib/events/datetime.ts` (append after `hasStarted`, which ends at line 94)
- Test: `lib/events/datetime.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `hasEnded(startsAt: string, endsAt: string | null, now?: Date): boolean` — used by Tasks 5, 6 and 7.

**Background the implementer needs.** `events.ends_at` is **nullable** — `events_end_after_start` reads `ends_at is null or ends_at > starts_at` — so an event may legitimately carry no end time, and a rule written against `ends_at` alone would leave those hosts permanently unpayable with no error anywhere. `hasStarted` (line 90) returns **`true`** for an unreadable time, because there "closed" means withholding a Book button. Here "closed" means **refusing to pay**, so an unreadable or absent time must return `false`. Do not delegate to `hasStarted`; the two want opposite answers for the same input.

- [ ] **Step 1: Write the failing tests**

Append to `lib/events/datetime.test.ts`. Add `hasEnded` to the existing import from `@/lib/events/datetime`.

```ts
describe('hasEnded', () => {
  const now = new Date('2026-08-15T14:00:00.000Z')

  it('is false for an event whose end is still ahead', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', '2026-08-15T14:00:00.001Z', now)).toBe(false)
  })

  it('is true once the end is behind us', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', '2026-08-15T13:59:59.999Z', now)).toBe(true)
  })

  it('is false at the exact end instant — "ended" means strictly past', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', '2026-08-15T14:00:00.000Z', now)).toBe(false)
  })

  it('falls back to starts_at when the event carries no end time', () => {
    // ends_at is nullable, and without this fallback every such host is
    // permanently unpayable and nothing says so.
    expect(hasEnded('2026-08-15T13:00:00.000Z', null, now)).toBe(true)
    expect(hasEnded('2026-08-15T15:00:00.000Z', null, now)).toBe(false)
  })

  it('fails closed on an unreadable time — the OPPOSITE of hasStarted', () => {
    // hasStarted('nonsense') is true: no Book button is the safe answer there.
    // Here the safe answer is refusing to pay, so this must be false. A later
    // reader will be tempted to implement this by calling hasStarted; these two
    // assertions are what stops them.
    expect(hasStarted('nonsense', now)).toBe(true)
    expect(hasEnded('nonsense', null, now)).toBe(false)
    expect(hasEnded('2026-08-15T10:00:00.000Z', 'nonsense', now)).toBe(false)
  })

  it('fails closed on an unreadable clock', () => {
    expect(hasEnded('2026-08-15T10:00:00.000Z', null, new Date(NaN))).toBe(false)
  })

  it('defaults now to the current time', () => {
    expect(hasEnded(new Date(Date.now() - 60_000).toISOString(), null)).toBe(true)
    expect(hasEnded(new Date(Date.now() + 60_000).toISOString(), null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/events/datetime.test.ts`
Expected: FAIL — `hasEnded is not a function` (a TypeScript/import error, since the export does not exist yet).

- [ ] **Step 3: Write the implementation**

Append to `lib/events/datetime.ts`:

```ts
/**
 * Whether an event is over, and therefore settleable.
 *
 * `ends_at` is nullable — events_end_after_start allows it — so an event with
 * no stated end falls back to its start. Without that fallback a host who
 * never filled in an end time could never be paid, and nothing would say so.
 *
 * Fails closed in the opposite direction to hasStarted, which is why this is a
 * separate function and not a call to it. There, an unreadable time returns
 * true because the safe answer is withholding a Book button. Here the safe
 * answer is refusing to move money, so an unreadable time — on either side of
 * the comparison — returns false. Strictly past, too: at the exact end instant
 * the event is not yet over.
 */
export function hasEnded(startsAt: string, endsAt: string | null, now: Date = new Date()): boolean {
  const end = new Date(endsAt ?? startsAt).getTime()
  const nowTime = now.getTime()
  if (Number.isNaN(end) || Number.isNaN(nowTime)) return false
  return end < nowTime
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/events/datetime.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Mutation-test the assertions**

Make each change, run the file, confirm **red**, then revert:

1. `return end < nowTime` → `return end <= nowTime` — the exact-instant test must fail.
2. `if (Number.isNaN(end) ...) return false` → `return true` — the fail-closed tests must fail.
3. `new Date(endsAt ?? startsAt)` → `new Date(endsAt ?? '')` — the null-fallback test must fail.

If any mutation leaves the suite green, the test is not testing what it claims. Fix the test, not the implementation.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add lib/events/datetime.ts lib/events/datetime.test.ts
git commit -m "feat: hasEnded, failing closed toward not paying"
```

---

### Task 2: The settlement calculator

The feature. Everything after this is a screen around it.

**Files:**
- Create: `lib/payouts/settlement.ts`
- Test: `lib/payouts/settlement.test.ts`

**Interfaces:**
- Consumes: `Paise`, `assertPaise` from `@/lib/money`.
- Produces:
  - `interface SettlementBooking { id: string; status: string; payment_mode: 'online' | 'cash'; subtotal_paise: number; commission_paise: number; has_captured_payment: boolean; has_refund: boolean }`
  - `interface RawPayment { id: string; booking_id: string; status: string }`
  - `interface RawRefund { payment_id: string }`
  - `interface Statement { grossPaise: Paise; commissionPaise: Paise; netPaise: Paise; forfeitedPaise: Paise; cashPaise: Paise; countedBookingIds: string[] }`
  - `joinPaymentFacts(bookings, payments: RawPayment[], refunds: RawRefund[]): SettlementBooking[]`
  - `settle(bookings: SettlementBooking[]): Statement`

Tasks 5, 6 and 7 rely on exactly these names.

**Why the money facts arrive pre-joined, rather than `settle` taking three arrays.** Hosts are deliberately forbidden from reading `payments` — `20260808000003_rls_policies.sql:157` says so in as many words: *"A host has no business seeing payment instrument details. They get aggregate money through payouts instead."* A `settle` that needed payment rows could therefore never run for the host statement page. Splitting the join out fixes that: the admin path joins in TypeScript from rows it may read, and the host path receives the same two booleans from a `SECURITY DEFINER` function (Task 4) that exposes no instrument detail. **One implementation of the money math, two ways of reaching it** — which is the point, because two implementations would eventually disagree about somebody's payment.

**The counting rules**, from the spec. This table *is* the specification:

| Booking | Into gross? | Why |
|---|---|---|
| `confirmed`, online, has a `captured` payment, **no** refund row | **yes** | the ordinary case |
| `confirmed` but carrying a refund row | **no** | amended after the Task 2 review: `applyRefundEvent` writes the refund row before flipping `payments.status`, so this state is reachable and would over-pay |
| `cancelled`, has a `captured` payment, **no** refund row against it | **yes**, and into `forfeitedPaise` | cancelled past the cutoff, so the money stayed; it is the host's |
| `confirmed`, cash | **no** — into `cashPaise` | the host already holds the cash |
| `refunded` (any refund status) | **no** | the money went back; and where a refund row exists but `failed`, fail toward not paying |
| `confirmed`, online, no `captured` payment | **no** | we do not pay out money we do not hold |
| `pending_approval`, `awaiting_payment`, `expired`, `waitlisted` | **no** | no money ever moved |

`refunds` is consulted for exactly one thing: disqualifying a `cancelled` booking that does have a refund. A `refunded` booking is excluded on status alone.

- [ ] **Step 1: Write the failing tests**

Create `lib/payouts/settlement.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { joinPaymentFacts, settle, type SettlementBooking } from '@/lib/payouts/settlement'
import { MoneyError } from '@/lib/money'

function booking(over: Partial<SettlementBooking> = {}): SettlementBooking {
  return {
    id: 'b1',
    status: 'confirmed',
    payment_mode: 'online',
    subtotal_paise: 50_000,
    commission_paise: 0,
    has_captured_payment: true,
    has_refund: false,
    ...over,
  }
}

describe('settle', () => {
  it('counts a confirmed online booking with a captured payment', () => {
    const result = settle([booking({ id: 'b1' })])
    expect(result.grossPaise).toBe(50_000)
    expect(result.netPaise).toBe(50_000)
    expect(result.forfeitedPaise).toBe(0)
    expect(result.countedBookingIds).toEqual(['b1'])
  })

  it('counts a cancelled booking whose money was kept, and marks it forfeited', () => {
    const result = settle([booking({ id: 'b1', status: 'cancelled' })])
    expect(result.grossPaise).toBe(50_000)
    expect(result.forfeitedPaise).toBe(50_000)
    expect(result.countedBookingIds).toEqual(['b1'])
  })

  it('excludes a cancelled booking that does have a refund', () => {
    const result = settle([booking({ id: 'b1', status: 'cancelled', has_refund: true })])
    expect(result.grossPaise).toBe(0)
    expect(result.forfeitedPaise).toBe(0)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a refunded booking even when its refund failed', () => {
    // has_refund is true whatever the refund's own status, so a 'failed' refund
    // — where the money may still be ours — is still not paid out. An
    // underpayment is a correction; an overpayment is a conversation.
    const result = settle([booking({ id: 'b1', status: 'refunded', has_refund: true })])
    expect(result.grossPaise).toBe(0)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a refunded booking even with no refund row at all', () => {
    // Status alone disqualifies. Nothing about the refunds table rescues it.
    const result = settle([booking({ id: 'b1', status: 'refunded', has_refund: false })])
    expect(result.grossPaise).toBe(0)
  })

  it('keeps cash out of gross and reports it separately', () => {
    const result = settle([
      booking({ id: 'b1', payment_mode: 'cash', has_captured_payment: false }),
    ])
    expect(result.grossPaise).toBe(0)
    expect(result.netPaise).toBe(0)
    expect(result.cashPaise).toBe(50_000)
    expect(result.countedBookingIds).toEqual([])
  })

  it('excludes a confirmed online booking with no captured payment', () => {
    const result = settle([booking({ id: 'b1', has_captured_payment: false })])
    expect(result.grossPaise).toBe(0)
  })

  it.each(['pending_approval', 'awaiting_payment', 'expired', 'waitlisted'])(
    'excludes %s bookings, where no money ever moved',
    (status) => {
      const result = settle([booking({ id: 'b1', status })])
      expect(result.grossPaise).toBe(0)
    },
  )

  it('subtracts commission from gross to get net', () => {
    // Zero across the pilot, non-zero here on purpose: this is the assertion
    // that the ledger is already correct on the day fees turn on, and it is
    // tested rather than asserted in prose.
    const result = settle([booking({ id: 'b1', subtotal_paise: 50_000, commission_paise: 5_000 })])
    expect(result.grossPaise).toBe(50_000)
    expect(result.commissionPaise).toBe(5_000)
    expect(result.netPaise).toBe(45_000)
  })

  it('takes commission on a forfeited seat too, from the same booking row', () => {
    const result = settle([
      booking({ id: 'b1', status: 'cancelled', subtotal_paise: 20_000, commission_paise: 2_000 }),
    ])
    expect(result.grossPaise).toBe(20_000)
    expect(result.forfeitedPaise).toBe(20_000)
    expect(result.commissionPaise).toBe(2_000)
    expect(result.netPaise).toBe(18_000)
  })

  it('sums a mixed event', () => {
    const result = settle([
      booking({ id: 'b1', subtotal_paise: 50_000 }),
      booking({ id: 'b2', subtotal_paise: 30_000, status: 'cancelled' }),
      booking({ id: 'b3', subtotal_paise: 40_000, status: 'refunded', has_refund: true }),
      booking({ id: 'b4', subtotal_paise: 25_000, payment_mode: 'cash', has_captured_payment: false }),
      booking({ id: 'b5', subtotal_paise: 10_000, status: 'expired' }),
    ])
    expect(result.grossPaise).toBe(80_000)
    expect(result.forfeitedPaise).toBe(30_000)
    expect(result.cashPaise).toBe(25_000)
    expect(result.netPaise).toBe(80_000)
    expect(result.countedBookingIds.sort()).toEqual(['b1', 'b2'])
  })

  it('settles an event with no bookings to zero rather than throwing', () => {
    const result = settle([])
    expect(result).toMatchObject({
      grossPaise: 0,
      commissionPaise: 0,
      netPaise: 0,
      forfeitedPaise: 0,
      cashPaise: 0,
    })
    expect(result.countedBookingIds).toEqual([])
  })

  it('settles a free event to zero', () => {
    const result = settle([booking({ id: 'b1', subtotal_paise: 0, has_captured_payment: false })])
    expect(result.grossPaise).toBe(0)
  })

  it('refuses a non-integer or negative amount rather than settling it', () => {
    expect(() => settle([booking({ subtotal_paise: 1.5 })])).toThrow(MoneyError)
    expect(() => settle([booking({ subtotal_paise: -1 })])).toThrow(MoneyError)
  })
})

describe('joinPaymentFacts', () => {
  const raw = { id: 'b1', status: 'confirmed', payment_mode: 'online' as const, subtotal_paise: 100, commission_paise: 0 }

  it('marks a booking with a captured payment', () => {
    const [row] = joinPaymentFacts([raw], [{ id: 'p1', booking_id: 'b1', status: 'captured' }], [])
    expect(row.has_captured_payment).toBe(true)
    expect(row.has_refund).toBe(false)
  })

  it('ignores a payment that never captured', () => {
    const [row] = joinPaymentFacts([raw], [{ id: 'p1', booking_id: 'b1', status: 'created' }], [])
    expect(row.has_captured_payment).toBe(false)
  })

  it('marks a refund against the captured payment', () => {
    const [row] = joinPaymentFacts(
      [raw],
      [{ id: 'p1', booking_id: 'b1', status: 'captured' }],
      [{ payment_id: 'p1' }],
    )
    expect(row.has_refund).toBe(true)
  })

  it('does not attribute another booking\'s refund', () => {
    const [row] = joinPaymentFacts(
      [raw],
      [{ id: 'p1', booking_id: 'b1', status: 'captured' }],
      [{ payment_id: 'p_other' }],
    )
    expect(row.has_refund).toBe(false)
  })

  it('handles a booking with no payment rows at all', () => {
    const [row] = joinPaymentFacts([raw], [], [])
    expect(row.has_captured_payment).toBe(false)
    expect(row.has_refund).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/payouts/settlement.test.ts`
Expected: FAIL — cannot resolve `@/lib/payouts/settlement`.

- [ ] **Step 3: Write the implementation**

Create `lib/payouts/settlement.ts`:

```ts
import { assertPaise, type Paise } from '@/lib/money'

/**
 * What a host is owed for one event, derived from state.
 *
 * Pure on purpose, following lib/notifications/sweep.ts: handed rows, it
 * returns the statement. No database, no clock, no provider — so the whole of
 * the money math is testable in milliseconds, which is the only reasonable
 * posture for the code that decides what leaves a bank account.
 *
 * Commission is read from bookings.commission_paise and from nowhere else —
 * not from hosts.commission_bps, not from fee_rules, not from lib/pricing.
 * Every booking path writes 0 today. That is why this module is correct at the
 * pilot's zero and still correct the day fees turn on, with no change here.
 */

/**
 * A booking with its money facts already attached. The two booleans are a
 * query concern, not a counting rule: the admin path derives them from rows it
 * may read (joinPaymentFacts below), and the host path receives them from
 * host_settlement_rows(), because a host may not read `payments` at all —
 * 20260808000003_rls_policies.sql:157 is explicit that they get aggregates
 * instead. Two routes in, one implementation of the arithmetic.
 */
export interface SettlementBooking {
  id: string
  status: string
  payment_mode: 'online' | 'cash'
  subtotal_paise: number
  commission_paise: number
  has_captured_payment: boolean
  /** Any refund row against the booking's payment, whatever its own status. */
  has_refund: boolean
}

export interface RawPayment {
  id: string
  booking_id: string
  status: string
}

export interface RawRefund {
  payment_id: string
}

export interface Statement {
  /** Face value of every counted booking — the host's money. */
  grossPaise: Paise
  /** The platform's cut, summed from the booking rows. Zero across the pilot. */
  commissionPaise: Paise
  /** gross - commission. Matches the payouts_net_is_consistent CHECK. */
  netPaise: Paise
  /** A SUBSET of gross, not an addend: seats cancelled past the cutoff. */
  forfeitedPaise: Paise
  /** Collected by the host at the door. Never part of a payout. */
  cashPaise: Paise
  countedBookingIds: string[]
}

/** Attaches the two money facts to bookings, for callers that may read payments. */
export function joinPaymentFacts(
  bookings: Array<Omit<SettlementBooking, 'has_captured_payment' | 'has_refund'>>,
  payments: RawPayment[],
  refunds: RawRefund[],
): SettlementBooking[] {
  // Any refund row at all disqualifies, whatever its own status. A 'failed'
  // refund may mean the money is still ours, and we still decline to pay it.
  const refundedPaymentIds = new Set(refunds.map((refund) => refund.payment_id))

  const capturedByBooking = new Map<string, RawPayment>()
  for (const payment of payments) {
    if (payment.status === 'captured' && !capturedByBooking.has(payment.booking_id)) {
      capturedByBooking.set(payment.booking_id, payment)
    }
  }

  return bookings.map((booking) => {
    const payment = capturedByBooking.get(booking.id)
    return {
      ...booking,
      has_captured_payment: payment !== undefined,
      has_refund: payment !== undefined && refundedPaymentIds.has(payment.id),
    }
  })
}

export function settle(bookings: SettlementBooking[]): Statement {
  let grossPaise = 0
  let commissionPaise = 0
  let forfeitedPaise = 0
  let cashPaise = 0
  const countedBookingIds: string[] = []

  for (const booking of bookings) {
    assertPaise(booking.subtotal_paise, `booking ${booking.id} subtotal_paise`)
    assertPaise(booking.commission_paise, `booking ${booking.id} commission_paise`)

    if (booking.payment_mode === 'cash') {
      // The host took this at the door. It is reported so a statement
      // reconciles, and it never enters gross — paying it out would be paying
      // the host money they are already holding.
      if (booking.status === 'confirmed') cashPaise += booking.subtotal_paise
      continue
    }

    if (!booking.has_captured_payment) continue

    const isOrdinary = booking.status === 'confirmed' && !booking.has_refund
    const isForfeit = booking.status === 'cancelled' && !booking.has_refund
    if (!isOrdinary && !isForfeit) continue

    grossPaise += booking.subtotal_paise
    commissionPaise += booking.commission_paise
    if (isForfeit) forfeitedPaise += booking.subtotal_paise
    countedBookingIds.push(booking.id)
  }

  assertPaise(grossPaise, 'grossPaise')
  assertPaise(commissionPaise, 'commissionPaise')
  const netPaise = grossPaise - commissionPaise
  assertPaise(netPaise, 'netPaise')

  return { grossPaise, commissionPaise, netPaise, forfeitedPaise, cashPaise, countedBookingIds }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/payouts/settlement.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Mutation-test the assertions**

Each change must turn the file **red**; revert after each:

1. `if (isForfeit) forfeitedPaise += …` → drop the line. The two forfeit tests must fail.
2. `booking.status === 'cancelled' && !booking.has_refund` → drop the `&&` clause. "excludes a cancelled booking that does have a refund" must fail.
3. `if (booking.status === 'confirmed') cashPaise += …` → `grossPaise += …`. The cash test must fail.
4. `if (!booking.has_captured_payment) continue` → delete the line. "excludes a confirmed online booking with no captured payment" must fail.
5. `const netPaise = grossPaise - commissionPaise` → `= grossPaise`. The commission test must fail. **If it does not, the commission fixture is zero somewhere it should not be** — that is exactly the class of bug that shipped sixteen times last session.
6. Add `'refunded'` to the `isOrdinary` condition. Both refunded tests must fail.
7. In `joinPaymentFacts`, `payment.status === 'captured'` → `true`. "ignores a payment that never captured" must fail.
8. In `joinPaymentFacts`, `refundedPaymentIds.has(payment.id)` → `refundedPaymentIds.size > 0`. "does not attribute another booking's refund" must fail.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add lib/payouts/settlement.ts lib/payouts/settlement.test.ts
git commit -m "feat: the settlement calculator, pure and mutation-tested"
```

---

### Task 3: `platform_admins`, the predicate, and the admin read policies

**Files:**
- Create: `supabase/migrations/20260812000002_platform_admins.sql`
- Modify: `tests/helpers/db.ts`
- Modify: `lib/supabase/rls.test.ts` (append a `describe` block; add imports)
- Regenerate: `lib/supabase/types.ts` (via `npm run db:types` — never hand-edit)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: SQL `is_platform_admin() returns boolean`; test helpers `seedPlatformAdmin(db): Promise<string>` and `SeedOptions.startsAt` / `SeedOptions.endsAt`. Tasks 4, 5, 6 and 7 all rely on these.

**Two things about the existing helpers the implementer must know.**

`seedEvent` hardcodes `starts_at` to **seven days in the future** and never sets `ends_at`, so nothing it produces is settleable. It needs options.

`cleanupEvent` deletes bookings, then events, then hosts — and **checks none of its errors**. `payments.booking_id`, `refunds.payment_id` and both of `payouts`' foreign keys are `on delete restrict`, so any seed carrying a payment already fails to delete and leaks silently. That is how orphan rows reached the dev database in earlier phases. Payout rows would make it worse, because `payouts_one_per_event` then pins a leaked event. Fix the order as part of this task.

- [ ] **Step 1: Extend the test helpers**

In `tests/helpers/db.ts`, add to `SeedOptions`:

```ts
  /** Defaults to seven days out. Pass a past instant to seed a settleable event. */
  startsAt?: string
  /** Nullable in the schema, and left null by default — exactly like a real event that never set one. */
  endsAt?: string | null
```

Destructure them in `seedEvent` alongside the others:

```ts
    startsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    endsAt = null,
```

and replace the two lines in the `events` insert:

```ts
      starts_at: startsAt,
      ends_at: endsAt,
```

Add the admin helper next to `createTestUser`:

```ts
/** Creates a user who is a platform admin. Cascades away with the auth user. */
export async function seedPlatformAdmin(db: SupabaseClient): Promise<string> {
  const profileId = await createTestUser(db)
  const { error } = await db
    .from('platform_admins')
    .insert({ profile_id: profileId, note: 'test' })
  if (error) throw new Error(`seedPlatformAdmin failed: ${error.message}`)
  return profileId
}
```

Add the money fixture, which Tasks 4 and 5 both build on:

```ts
let bookingCounter = 0

export interface SeededBooking {
  bookingId: string
  paymentId: string | null
}

/**
 * A booking in a terminal money state, written straight in.
 *
 * Not built from the booking RPCs on purpose: `begin_paid_booking` and
 * `book_free_tickets` both refuse an event that has already started (EH032,
 * EH013) — and every settleable event has by definition started. A settlement
 * fixture therefore cannot come from the booking path at all.
 *
 * Pass a distinct `attendeeId` per booking on the same event: the one-active-
 * booking-per-attendee index will otherwise reject the second.
 */
export async function seedCapturedBooking(
  db: SupabaseClient,
  seed: SeededEvent,
  options: {
    status?: string
    paymentMode?: 'online' | 'cash'
    subtotalPaise?: number
    commissionPaise?: number
    captured?: boolean
    refunded?: boolean
    attendeeId?: string
  } = {},
): Promise<SeededBooking> {
  const {
    status = 'confirmed',
    paymentMode = 'online',
    subtotalPaise = 50_000,
    commissionPaise = 0,
    captured = true,
    refunded = false,
    attendeeId = seed.attendeeId,
  } = options

  bookingCounter += 1
  const reference = `TST${String(Date.now() % 100_000).padStart(5, '0')}${String(bookingCounter).padStart(3, '0')}`

  const { data: booking, error } = await db
    .from('bookings')
    .insert({
      reference,
      event_id: seed.eventId,
      ticket_type_id: seed.ticketTypeId,
      attendee_id: attendeeId,
      quantity: 1,
      status,
      payment_mode: paymentMode,
      subtotal_paise: subtotalPaise,
      convenience_fee_paise: 0,
      total_paise: subtotalPaise,
      commission_paise: commissionPaise,
    })
    .select()
    .single()
  if (error) throw new Error(`seedCapturedBooking: ${error.message}`)
  if (!captured) return { bookingId: booking.id, paymentId: null }

  const { data: payment, error: paymentError } = await db
    .from('payments')
    .insert({
      booking_id: booking.id,
      provider: 'razorpay',
      provider_order_id: `order_${reference}`,
      provider_payment_id: `pay_${reference}`,
      amount_paise: subtotalPaise,
      status: 'captured',
    })
    .select()
    .single()
  if (paymentError) throw new Error(`seedCapturedBooking payment: ${paymentError.message}`)

  if (refunded) {
    const { error: refundError } = await db.from('refunds').insert({
      payment_id: payment.id,
      provider_refund_id: `rfnd_${reference}`,
      amount_paise: subtotalPaise,
      status: 'processed',
    })
    if (refundError) throw new Error(`seedCapturedBooking refund: ${refundError.message}`)
  }

  return { bookingId: booking.id, paymentId: payment.id }
}
```

Replace `cleanupEvent` entirely:

```ts
/** Removes a seeded event and everything hanging off it. */
export async function cleanupEvent(db: SupabaseClient, seed: SeededEvent): Promise<void> {
  // Order matters and used not to. payouts, payments and refunds are all
  // `on delete restrict` against the rows below them, and none of these
  // deletes checks its error — so before this, any seed carrying a payment
  // failed to delete and leaked its event, host and auth users in silence.
  await db.from('payouts').delete().eq('event_id', seed.eventId)

  const { data: bookings } = await db.from('bookings').select('id').eq('event_id', seed.eventId)
  const bookingIds = (bookings ?? []).map((row) => row.id)
  if (bookingIds.length > 0) {
    const { data: payments } = await db.from('payments').select('id').in('booking_id', bookingIds)
    const paymentIds = (payments ?? []).map((row) => row.id)
    if (paymentIds.length > 0) {
      await db.from('refunds').delete().in('payment_id', paymentIds)
      await db.from('payments').delete().in('id', paymentIds)
    }
  }

  await db.from('bookings').delete().eq('event_id', seed.eventId)
  await db.from('events').delete().eq('id', seed.eventId)
  await db.from('hosts').delete().eq('id', seed.hostId)
  await db.auth.admin.deleteUser(seed.hostProfileId).catch(() => {})
  await db.auth.admin.deleteUser(seed.attendeeId).catch(() => {})
}
```

- [ ] **Step 2: Write the failing RLS tests**

Append to `lib/supabase/rls.test.ts`. Add `seedPlatformAdmin` to the existing import from `@/tests/helpers/db`.

```ts
describe('platform admins', () => {
  let adminProfileId: string
  let otherHost: SeededEvent

  beforeAll(async () => {
    adminProfileId = await seedPlatformAdmin(db)
    otherHost = await seedEvent(db, { quantity: 5, status: 'published' })
    await db.from('payouts').insert({
      host_id: otherHost.hostId,
      event_id: otherHost.eventId,
      gross_paise: 50_000,
      commission_paise: 0,
      net_paise: 50_000,
    })
  })

  afterAll(async () => {
    await cleanupEvent(db, otherHost)
    await db.auth.admin.deleteUser(adminProfileId).catch(() => {})
  })

  it('hides platform_admins from a signed-in non-admin', async () => {
    // The same posture as fee_rules and provider_webhook_events: RLS on, no
    // policy, no grant. Knowing WHO can settle is itself worth withholding.
    const { data, error } = await userClient(outsiderId).from('platform_admins').select('profile_id')
    expect(data ?? []).toHaveLength(0)
    if (error) expect(error.code).toBeTruthy()
  })

  it('hides platform_admins from an admin too — nothing grants it', async () => {
    const { data } = await userClient(adminProfileId).from('platform_admins').select('profile_id')
    expect(data ?? []).toHaveLength(0)
  })

  it('does not let one host read another host\'s payouts', async () => {
    const { data } = await userClient(published.hostProfileId)
      .from('payouts')
      .select('id')
      .eq('event_id', otherHost.eventId)
    expect(data ?? []).toHaveLength(0)
  })

  it('lets a platform admin read payouts across hosts', async () => {
    const { data, error } = await userClient(adminProfileId)
      .from('payouts')
      .select('id, net_paise')
      .eq('event_id', otherHost.eventId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].net_paise).toBe(50_000)
  })

  it('lets a platform admin read an event they do not host', async () => {
    // draft, so events_select_published cannot be what allows it.
    const { data, error } = await userClient(adminProfileId)
      .from('events')
      .select('id')
      .eq('id', draft.eventId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('does not let a non-admin read a draft event they do not host', async () => {
    const { data } = await userClient(outsiderId).from('events').select('id').eq('id', draft.eventId)
    expect(data ?? []).toHaveLength(0)
  })

  it('still withholds host payout secrets from an admin on the ordinary client', async () => {
    // The column grant, not a policy, is what hides upi_id — and no policy can
    // widen a grant. This is precisely why admin_host_payout_target exists.
    const { error } = await userClient(adminProfileId).from('hosts').select('upi_id')
    expect(error).not.toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run db:start` (if not already up), then `npx vitest run lib/supabase/rls.test.ts`
Expected: FAIL — `relation "platform_admins" does not exist`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260812000002_platform_admins.sql`:

```sql
-- Platform admins — the operator identity, and the reads it needs.
--
-- There was no admin concept anywhere in this codebase before Phase 6a. This
-- is it, and it is deliberately the same shape as current_host_id(): a table,
-- a SECURITY DEFINER predicate, and policies that call it. The console then
-- runs on the ordinary session client, so the service-role fence in
-- eslint.config.mjs stays at four files and the database remains the place
-- authorisation is decided.

create table platform_admins (
  profile_id  uuid primary key references profiles (id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now()
);

alter table platform_admins enable row level security;

-- No policies and no grant, exactly as fee_rules and provider_webhook_events
-- have none: RLS is on and nothing is granted, so the table is invisible to
-- anon and authenticated alike — including to admins themselves. Who can
-- settle is not a fact any browser needs. Seeded by hand against the service
-- role:  insert into platform_admins (profile_id) values ('<uuid>');

-- SECURITY DEFINER for the same reason current_host_id() is: a policy on
-- payouts that queried platform_admins directly would re-enter that table's
-- own (absent) policies and read nothing.
create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where profile_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Admin reads
-- ---------------------------------------------------------------------------
-- Added as separate policies rather than folded into the existing ones with an
-- OR. Postgres OR-s permissive policies for the same command, so the effect is
-- identical — but nothing already reviewed is edited, and this file already
-- reads this way (events_select_published beside events_select_own).
--
-- Reads only. Every write still goes through a SECURITY DEFINER function.
--
-- `to authenticated` is load-bearing, not tidiness. A policy with no TO clause
-- applies to PUBLIC, so an anonymous visitor reading the city feed would have
-- to evaluate is_platform_admin() on every row — needing EXECUTE on it, and
-- erroring without. An admin is by definition signed in, so scoping the policy
-- keeps anon on exactly the path it had before this migration.

create policy events_select_admin on events
  for select to authenticated using (is_platform_admin());

create policy bookings_select_admin on bookings
  for select to authenticated using (is_platform_admin());

create policy payments_select_admin on payments
  for select to authenticated using (is_platform_admin());

create policy refunds_select_admin on refunds
  for select to authenticated using (is_platform_admin());

create policy payouts_select_admin on payouts
  for select to authenticated using (is_platform_admin());

-- authenticated needs EXECUTE because policy expressions run with the caller's
-- privileges; the app also calls it directly to decide whether /admin exists.
revoke execute on function is_platform_admin() from public, anon;
grant execute on function is_platform_admin() to authenticated, service_role;

-- No grant is added for hosts.upi_id or hosts.bank_account_ref. RLS filters
-- rows, not columns, so no policy here could reach them anyway, and widening
-- the column grant would hand every host's bank details to every signed-in
-- visitor — hosts is world-readable so event pages can name their host.
-- admin_host_payout_target() in the next migration is the way through.
```

- [ ] **Step 5: Apply the migration, regenerate types, run the tests**

```bash
npm run db:reset && npm run db:types
npx vitest run lib/supabase/rls.test.ts
```
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 6: Mutation-test the assertions**

1. Change `payouts_select_admin` to `using (true)` and re-apply. "does not let one host read another host's payouts" must fail.
2. Drop `events_select_admin` and re-apply. "lets a platform admin read an event they do not host" must fail.
3. Add `grant select on platform_admins to authenticated;` and re-apply. Both `platform_admins` visibility tests must fail. **This one matters most** — a test asserting "I saw nothing" passes just as well when the query was broken for an unrelated reason, so prove it can see something when the grant exists.
4. Drop `to authenticated` from `events_select_admin` **and** the `grant execute … to authenticated` line, then re-apply. The pre-existing "lets anonymous visitors read published events" test must fail with a permission error on `is_platform_admin`. This is the regression the `TO` clause exists to prevent, and the guard for it is already in the file.

Re-apply with `npm run db:reset` after each change, and again after reverting.

- [ ] **Step 7: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add supabase/migrations/20260812000002_platform_admins.sql lib/supabase/types.ts tests/helpers/db.ts lib/supabase/rls.test.ts
git commit -m "feat: platform admins, and the reads settlement needs"
```

---

### Task 4: The payout writer — `forfeited_paise`, the freeze, and two gated functions

**Files:**
- Create: `supabase/migrations/20260812000003_payout_settlement.sql`
- Create: `lib/payouts/payout-rpc.test.ts`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Consumes: `is_platform_admin()` and `seedPlatformAdmin` / `SeedOptions.startsAt` from Task 3.
- Produces:
  - `record_payout(p_event_id uuid, p_gross_paise bigint, p_commission_paise bigint, p_forfeited_paise bigint, p_status payout_status, p_utr_reference text, p_notes text) returns payouts`
  - `admin_host_payout_target(p_host_id uuid) returns table (upi_id text, bank_account_ref text, kyc_status host_kyc_status)`
  - `host_settlement_rows(p_event_id uuid) returns table (id uuid, status booking_status, payment_mode payment_mode, subtotal_paise bigint, commission_paise bigint, has_captured_payment boolean, has_refund boolean)`
  - Error codes **EH070** (settled payout is immutable), **EH071** (not a platform admin), **EH072** (no such event), **EH073** (the event has not ended), **EH074** (status must be paid or on_hold), **EH075** (a paid payout needs its UTR), **EH076** (not your event).

Task 5 wraps all three functions; Task 6 surfaces the codes as sentences; Task 7 is the only caller of `host_settlement_rows`.

**Why `host_settlement_rows` exists.** A host may read their own bookings but **not** `payments` — `20260808000003_rls_policies.sql:157` is explicit that they get aggregates instead of instrument detail. The host statement page still needs to run the same `settle()` as the admin console, so this function hands back exactly the two booleans `SettlementBooking` wants and no payment row, no provider id, no method, no amount. It is scoped by `owns_event()`, the helper that already exists, so it grants a host nothing about anyone else.

**One subtlety that will bite if missed.** The upsert's `DO UPDATE` fires the freeze trigger, which is how a paid row is protected from `record_payout` itself. But a naive `paid_at = excluded.paid_at` would set a fresh `now()` on every re-record, so the trigger would refuse even a note-only edit to a settled row. `paid_at = coalesce(payouts.paid_at, excluded.paid_at)` keeps the original instant, which is both the honest value and what makes `notes` genuinely editable.

- [ ] **Step 1: Write the failing tests**

Create `lib/payouts/payout-rpc.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  seedPlatformAdmin,
  userClient,
  type SeededEvent,
} from '@/tests/helpers/db'

/**
 * The two functions that guard real money. Every assertion here calls them the
 * way the app will — as a signed-in user through PostgREST — rather than
 * inspecting their source, because "the gate is written" and "the gate fires"
 * are different claims.
 */

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let ended: SeededEvent
let future: SeededEvent
let noEndTime: SeededEvent
let held: SeededEvent

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)
  ended = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  future = await seedEvent(db, {
    startsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  })
  noEndTime = await seedEvent(db, {
    startsAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    endsAt: null,
  })
  held = await seedEvent(db, {
    startsAt: new Date(Date.now() - 72 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 71 * HOUR).toISOString(),
  })
  await db.from('hosts').update({ upi_id: 'host@upi' }).eq('id', ended.hostId)
})

afterAll(async () => {
  await cleanupEvent(db, ended)
  await cleanupEvent(db, future)
  await cleanupEvent(db, noEndTime)
  await cleanupEvent(db, held)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
})

function paid(eventId: string, over: Record<string, unknown> = {}) {
  return {
    p_event_id: eventId,
    p_gross_paise: 50_000,
    p_commission_paise: 0,
    p_forfeited_paise: 0,
    p_status: 'paid',
    p_utr_reference: 'UTR123456',
    p_notes: null,
    ...over,
  }
}

describe('record_payout', () => {
  it('refuses a caller who is not a platform admin', async () => {
    const { error } = await userClient(outsiderId).rpc('record_payout', paid(ended.eventId))
    expect(error?.code).toBe('EH071')
  })

  it('refuses an anonymous caller', async () => {
    const { error } = await userClient(ended.hostProfileId).rpc('record_payout', paid(ended.eventId))
    // The host of the event is still not an admin. Hosting is not settling.
    expect(error?.code).toBe('EH071')
  })

  it('refuses an event that has not ended', async () => {
    const { error } = await userClient(adminId).rpc('record_payout', paid(future.eventId))
    expect(error?.code).toBe('EH073')
  })

  it('accepts an event with no end time whose start has passed', async () => {
    // ends_at is nullable. Without the coalesce these hosts are unpayable.
    const { data, error } = await userClient(adminId).rpc('record_payout', paid(noEndTime.eventId))
    expect(error).toBeNull()
    expect(data.status).toBe('paid')
  })

  it('refuses a status other than paid or on_hold', async () => {
    const { error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_status: 'pending' }),
    )
    expect(error?.code).toBe('EH074')
  })

  it('refuses a paid payout with no UTR', async () => {
    const { error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_utr_reference: '   ' }),
    )
    expect(error?.code).toBe('EH075')
  })

  it('records a settlement, deriving net and stamping paid_at', async () => {
    const { data, error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_gross_paise: 80_000, p_commission_paise: 8_000, p_forfeited_paise: 30_000 }),
    )
    expect(error).toBeNull()
    expect(data.net_paise).toBe(72_000)
    expect(data.forfeited_paise).toBe(30_000)
    expect(data.host_id).toBe(ended.hostId)
    expect(data.paid_at).not.toBeNull()
  })

  it('freezes the amounts once paid', async () => {
    const { error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_gross_paise: 10_000 }),
    )
    expect(error?.code).toBe('EH070')
  })

  it('still allows a note on a settled row, which is how a correction is recorded', async () => {
    const { data, error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, {
        p_gross_paise: 80_000,
        p_commission_paise: 8_000,
        p_forfeited_paise: 30_000,
        p_notes: 'refund landed after settlement; ₹200 recovered by UPI',
      }),
    )
    expect(error).toBeNull()
    expect(data.notes).toContain('recovered')
  })

  it('freezes against the service role too — the trigger, not an app check', async () => {
    const { error } = await db
      .from('payouts')
      .update({ gross_paise: 1 })
      .eq('event_id', ended.eventId)
    expect(error?.code).toBe('EH070')
  })

  it('updates an unsettled row rather than duplicating it, and holds are not frozen', async () => {
    const hold = { p_status: 'on_hold', p_utr_reference: null }
    const first = await userClient(adminId).rpc(
      'record_payout',
      paid(held.eventId, { ...hold, p_notes: 'KYC pending' }),
    )
    expect(first.error).toBeNull()
    expect(first.data.paid_at).toBeNull()

    const second = await userClient(adminId).rpc(
      'record_payout',
      paid(held.eventId, { ...hold, p_gross_paise: 12_000, p_notes: 'KYC cleared, paying Friday' }),
    )
    expect(second.error).toBeNull()
    expect(second.data.gross_paise).toBe(12_000)

    const { data: rows } = await db.from('payouts').select('id').eq('event_id', held.eventId)
    expect(rows).toHaveLength(1)
  })
})

describe('admin_host_payout_target', () => {
  it('refuses a caller who is not a platform admin', async () => {
    const { error } = await userClient(outsiderId).rpc('admin_host_payout_target', {
      p_host_id: ended.hostId,
    })
    expect(error?.code).toBe('EH071')
  })

  it('returns the payout destination to an admin, which no policy could', async () => {
    // The ordinary client cannot select upi_id at all — it is withheld by a
    // COLUMN GRANT, and RLS filters rows, not columns. This function is the
    // only route that does not either leak the column or reach for the
    // service role.
    const { data, error } = await userClient(adminId).rpc('admin_host_payout_target', {
      p_host_id: ended.hostId,
    })
    expect(error).toBeNull()
    expect(data[0].upi_id).toBe('host@upi')
  })
})

describe('host_settlement_rows', () => {
  let withMoney: SeededEvent
  let secondAttendee: string

  beforeAll(async () => {
    withMoney = await seedEvent(db, {
      startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
      endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
    })
    secondAttendee = await createTestUser(db)
    await seedCapturedBooking(db, withMoney, { subtotalPaise: 50_000 })
    await seedCapturedBooking(db, withMoney, {
      status: 'refunded',
      refunded: true,
      subtotalPaise: 30_000,
      attendeeId: secondAttendee,
    })
  })

  afterAll(async () => {
    await cleanupEvent(db, withMoney)
    await db.auth.admin.deleteUser(secondAttendee).catch(() => {})
  })

  it('gives the host the two money facts and no payment row', async () => {
    const { data, error } = await userClient(withMoney.hostProfileId).rpc('host_settlement_rows', {
      p_event_id: withMoney.eventId,
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    const paid = data.find((row: { subtotal_paise: number }) => row.subtotal_paise === 50_000)
    expect(paid.has_captured_payment).toBe(true)
    expect(paid.has_refund).toBe(false)
    const refunded = data.find((row: { subtotal_paise: number }) => row.subtotal_paise === 30_000)
    expect(refunded.has_refund).toBe(true)
    // The aggregate, and nothing about the instrument.
    expect(Object.keys(paid).sort()).toEqual([
      'commission_paise',
      'has_captured_payment',
      'has_refund',
      'id',
      'payment_mode',
      'status',
      'subtotal_paise',
    ])
  })

  it('refuses a host asking about an event they do not own', async () => {
    const { error } = await userClient(ended.hostProfileId).rpc('host_settlement_rows', {
      p_event_id: withMoney.eventId,
    })
    expect(error?.code).toBe('EH076')
  })

  it('still refuses the host a direct read of payments', async () => {
    // The function is an aggregate escape hatch, not a widening. If this ever
    // returns rows, rls_policies.sql:157 has been undone by accident.
    const { data } = await userClient(withMoney.hostProfileId).from('payments').select('id')
    expect(data ?? []).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/payouts/payout-rpc.test.ts`
Expected: FAIL — `Could not find the function public.record_payout`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260812000003_payout_settlement.sql`:

```sql
-- The payout writer.
--
-- payouts has existed since Phase 0 and nothing has ever written to it. This
-- migration gives it its one writer, its memo column, and the rule that a
-- settled row is history.
--
--   EH070  a settled payout is immutable
--   EH071  not a platform admin
--   EH072  no such event
--   EH073  the event has not ended
--   EH074  a payout is recorded as paid or on_hold
--   EH075  a paid payout needs its UTR

-- A SUBSET of gross_paise, not an addend — seats cancelled past the refund
-- cutoff, whose money stayed with us and belongs to the host. Held separately
-- so a statement can explain its own number. payouts_net_is_consistent
-- therefore keeps meaning exactly what it always meant.
alter table payouts
  add column forfeited_paise bigint not null default 0
    check (forfeited_paise >= 0);

-- ---------------------------------------------------------------------------
-- The freeze
-- ---------------------------------------------------------------------------
-- Once a payout says 'paid', its amounts record what actually left a bank
-- account. Recomputation may disagree — a refund can land afterwards — and the
-- console shows that drift, but nothing silently rewrites a number somebody
-- already acted on. notes stays editable precisely so an out-of-band
-- correction has somewhere to go.
--
-- A trigger rather than a check in the service, because the service is not the
-- only writer: this fires against the service role and against psql too.

create or replace function payouts_freeze_when_paid()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'paid' and (
       new.gross_paise      is distinct from old.gross_paise
    or new.commission_paise is distinct from old.commission_paise
    or new.net_paise        is distinct from old.net_paise
    or new.forfeited_paise  is distinct from old.forfeited_paise
    or new.utr_reference    is distinct from old.utr_reference
    or new.paid_at          is distinct from old.paid_at
    or new.status           is distinct from old.status
  ) then
    raise exception 'this payout is settled; its amounts are what left the bank'
      using errcode = 'EH070',
            hint = 'Record the correction in notes and settle the difference out of band.';
  end if;
  return new;
end;
$$;

create trigger payouts_frozen_when_paid
  before update on payouts
  for each row execute function payouts_freeze_when_paid();

-- ---------------------------------------------------------------------------
-- record_payout — the only writer
-- ---------------------------------------------------------------------------

create or replace function record_payout(
  p_event_id         uuid,
  p_gross_paise      bigint,
  p_commission_paise bigint,
  p_forfeited_paise  bigint,
  p_status           payout_status,
  p_utr_reference    text default null,
  p_notes            text default null
)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  ev     events;
  result payouts;
begin
  -- First statement, before anything is read.
  if not is_platform_admin() then
    raise exception 'not a platform admin' using errcode = 'EH071';
  end if;

  select * into ev from events where id = p_event_id;
  if not found then
    raise exception 'no such event' using errcode = 'EH072';
  end if;

  -- ends_at is nullable, so fall back to starts_at: without this an event that
  -- never stated an end time could never be settled, and nothing would say so.
  if coalesce(ev.ends_at, ev.starts_at) >= now() then
    raise exception 'this event has not ended yet' using errcode = 'EH073';
  end if;

  -- 'pending' is a schema default the console never writes: manual settlement
  -- reads a number, sends UPI, then records it, so no row exists before money
  -- has moved.
  if p_status not in ('paid', 'on_hold') then
    raise exception 'a payout is recorded as paid or on_hold' using errcode = 'EH074';
  end if;

  if p_status = 'paid' and coalesce(btrim(p_utr_reference), '') = '' then
    raise exception 'a settled payout needs its bank reference' using errcode = 'EH075';
  end if;

  insert into payouts (
    host_id, event_id, gross_paise, commission_paise, net_paise,
    forfeited_paise, status, utr_reference, notes, paid_at
  ) values (
    ev.host_id, p_event_id, p_gross_paise, p_commission_paise,
    p_gross_paise - p_commission_paise, p_forfeited_paise, p_status,
    p_utr_reference, p_notes,
    case when p_status = 'paid' then now() else null end
  )
  on conflict (event_id) do update set
    gross_paise      = excluded.gross_paise,
    commission_paise = excluded.commission_paise,
    net_paise        = excluded.net_paise,
    forfeited_paise  = excluded.forfeited_paise,
    status           = excluded.status,
    utr_reference    = excluded.utr_reference,
    notes            = excluded.notes,
    -- Keep the ORIGINAL settlement instant. A fresh now() here would differ
    -- from the frozen row on every re-record, so the trigger would refuse even
    -- a note-only edit — and the stored time would stop being when the money
    -- actually moved.
    paid_at          = coalesce(payouts.paid_at, excluded.paid_at)
  returning * into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_host_payout_target — the way past a column grant
-- ---------------------------------------------------------------------------
-- upi_id and bank_account_ref are withheld from authenticated by the column
-- grant in 20260808000003_rls_policies.sql, not by a policy — and RLS filters
-- rows, not columns, so no policy can widen it. Widening the grant instead
-- would expose every host's bank details to every signed-in visitor, because
-- hosts is world-readable so event pages can name their host. SECURITY DEFINER
-- is the only remaining route that does not put a fifth file inside the
-- service-role fence.

create or replace function admin_host_payout_target(p_host_id uuid)
returns table (upi_id text, bank_account_ref text, kyc_status host_kyc_status)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'not a platform admin' using errcode = 'EH071';
  end if;

  return query
    select h.upi_id, h.bank_account_ref, h.kyc_status
      from hosts h
     where h.id = p_host_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- host_settlement_rows — the same math, without the instrument details
-- ---------------------------------------------------------------------------
-- A host may read their own bookings but NOT payments: rls_policies.sql says
-- "A host has no business seeing payment instrument details. They get
-- aggregate money through payouts instead." The statement page still has to
-- run the same settle() the console does, so this returns exactly the two
-- booleans it needs — no payment row, no provider id, no method, no amount.
-- One implementation of the money math, reached two ways; two implementations
-- would eventually disagree about somebody's payment.
--
-- Scoped by owns_event(), the helper that already exists.

create or replace function host_settlement_rows(p_event_id uuid)
returns table (
  id                   uuid,
  status               booking_status,
  payment_mode         payment_mode,
  subtotal_paise       bigint,
  commission_paise     bigint,
  has_captured_payment boolean,
  has_refund           boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not owns_event(p_event_id) and not is_platform_admin() then
    raise exception 'not your event' using errcode = 'EH076';
  end if;

  return query
    select
      b.id,
      b.status,
      b.payment_mode,
      b.subtotal_paise,
      b.commission_paise,
      exists (
        select 1 from payments p
         where p.booking_id = b.id and p.status = 'captured'
      ),
      exists (
        select 1
          from payments p
          join refunds r on r.payment_id = p.id
         where p.booking_id = b.id and p.status = 'captured'
      )
      from bookings b
     where b.event_id = p_event_id;
end;
$$;

-- Explicit, because a hosted project may carry default privileges that survive
-- a revoke from PUBLIC. All three are callable by a signed-in user; each
-- refuses an unauthorised caller as its first act.
revoke execute on function record_payout(uuid, bigint, bigint, bigint, payout_status, text, text)
  from public, anon;
revoke execute on function admin_host_payout_target(uuid) from public, anon;
revoke execute on function host_settlement_rows(uuid) from public, anon;

grant execute on function record_payout(uuid, bigint, bigint, bigint, payout_status, text, text)
  to authenticated, service_role;
grant execute on function admin_host_payout_target(uuid) to authenticated, service_role;
grant execute on function host_settlement_rows(uuid) to authenticated, service_role;
```

- [ ] **Step 4: Apply, regenerate types, run the tests**

```bash
npm run db:reset && npm run db:types
npx vitest run lib/payouts/payout-rpc.test.ts
```
Expected: PASS, all cases.

- [ ] **Step 5: Mutation-test the assertions**

Re-apply with `npm run db:reset` after each change and after each revert:

1. Delete the `is_platform_admin()` guard from `record_payout`. The two EH071 tests must fail. **Do this one first** — an authorisation test that passes against an ungated function is the exact failure the last session shipped, where a route answering 200 to `Bearer undefined` passed its auth test.
2. Change `coalesce(ev.ends_at, ev.starts_at)` to `ev.ends_at`. "accepts an event with no end time" must fail (a null comparison is never true, so the guard would raise).
3. Change `>= now()` to `> now()`. Nothing should break — but if a test *does* fail, the fixture is sitting exactly on the boundary and is time-dependent; fix the fixture.
4. Drop the `payouts_frozen_when_paid` trigger. Both freeze tests must fail.
5. Change `paid_at = coalesce(payouts.paid_at, excluded.paid_at)` to `= excluded.paid_at`. "still allows a note on a settled row" must fail.
6. Remove the `p_status not in ('paid','on_hold')` guard. The EH074 test must fail.
7. Remove the `owns_event(p_event_id)` guard from `host_settlement_rows`. "refuses a host asking about an event they do not own" must fail.
8. In `host_settlement_rows`, change the refund `exists` to `select 1 from refunds r` with no join. "gives the host the two money facts" must fail — every row would report a refund.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add supabase/migrations/20260812000003_payout_settlement.sql lib/supabase/types.ts lib/payouts/payout-rpc.test.ts
git commit -m "feat: the payout writer, gated and frozen once paid"
```

---

### Task 5: The reads and the RPC wrappers

**Files:**
- Create: `lib/payouts/queries.ts`, `lib/payouts/service.ts`
- Test: `lib/payouts/queries.test.ts`

**Interfaces:**
- Consumes: `hasEnded` (Task 1); `settle`, `joinPaymentFacts`, `Statement`, `SettlementBooking` (Task 2); `is_platform_admin`, the admin policies (Task 3); `record_payout`, `admin_host_payout_target`, `host_settlement_rows` (Task 4).
- Produces: `isPlatformAdmin()`, `listSettleableEvents(now?)`, `hostPayoutTarget(hostId)`, `listHostStatements(now?)`, `recordPayout(input)`, and the types `PayoutRow`, `SettleableEvent`, `HostStatement`, `RecordPayoutResult`. Tasks 6 and 7 consume these and nothing below them.

**How these get tested.** `tests/helpers/session.ts` already exists for exactly this: importing it installs a `vi.mock` over `@/lib/supabase/server#createClient`, and `signInAs(userId)` decides who subsequent calls act as. Everything below that seam stays real — a real PostgREST client with a real JWT against the real local Postgres under real RLS. **The module under test must be imported with a top-level `await import(...)`, after the static imports**, or it binds the real `createClient` and dies on "`cookies` was called outside a request scope". Read that file's docblock before writing the test.

- [ ] **Step 1: Write the failing tests**

Create `lib/payouts/queries.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  seedPlatformAdmin,
  type SeededEvent,
} from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session'

// After every static import: the mock in session.ts must be installed before
// this module binds @/lib/supabase/server. See that file's docblock.
const { isPlatformAdmin, listSettleableEvents, listHostStatements, hostPayoutTarget } =
  await import('@/lib/payouts/queries')
const { recordPayout } = await import('@/lib/payouts/service')

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let ended: SeededEvent
let future: SeededEvent
const extraAttendees: string[] = []

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)

  ended = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  future = await seedEvent(db, { startsAt: new Date(Date.now() + 24 * HOUR).toISOString() })

  for (let i = 0; i < 3; i += 1) extraAttendees.push(await createTestUser(db))

  // ₹500 confirmed, ₹300 forfeited, ₹400 refunded, ₹250 cash.
  await seedCapturedBooking(db, ended, { subtotalPaise: 50_000 })
  await seedCapturedBooking(db, ended, {
    status: 'cancelled', subtotalPaise: 30_000, attendeeId: extraAttendees[0],
  })
  await seedCapturedBooking(db, ended, {
    status: 'refunded', refunded: true, subtotalPaise: 40_000, attendeeId: extraAttendees[1],
  })
  await seedCapturedBooking(db, ended, {
    paymentMode: 'cash', captured: false, subtotalPaise: 25_000, attendeeId: extraAttendees[2],
  })

  await db.from('hosts').update({ upi_id: 'host@upi' }).eq('id', ended.hostId)
})

afterAll(async () => {
  signInAs(null)
  await cleanupEvent(db, ended)
  await cleanupEvent(db, future)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
  for (const id of extraAttendees) await db.auth.admin.deleteUser(id).catch(() => {})
})

describe('isPlatformAdmin', () => {
  it('is true for an admin and false for everyone else', async () => {
    signInAs(adminId)
    expect(await isPlatformAdmin()).toBe(true)
    signInAs(outsiderId)
    expect(await isPlatformAdmin()).toBe(false)
    signInAs(null)
    expect(await isPlatformAdmin()).toBe(false)
  })
})

describe('listSettleableEvents', () => {
  it('computes the statement for an ended event', async () => {
    signInAs(adminId)
    const rows = await listSettleableEvents()
    const row = rows.find((r) => r.eventId === ended.eventId)
    expect(row).toBeDefined()
    expect(row!.statement.grossPaise).toBe(80_000)
    expect(row!.statement.forfeitedPaise).toBe(30_000)
    expect(row!.statement.cashPaise).toBe(25_000)
    expect(row!.statement.netPaise).toBe(80_000)
    expect(row!.payout).toBeNull()
    expect(row!.driftPaise).toBeNull()
  })

  it('leaves out an event that has not ended', async () => {
    signInAs(adminId)
    const rows = await listSettleableEvents()
    expect(rows.map((r) => r.eventId)).not.toContain(future.eventId)
  })

  it('returns nothing to a signed-in non-admin', async () => {
    // The RLS policies are the guard; this asserts the query relies on them
    // rather than on a filter the caller could be missing.
    signInAs(outsiderId)
    expect(await listSettleableEvents()).toEqual([])
  })

  it('reports drift once a settled row disagrees with the recomputation', async () => {
    signInAs(adminId)
    const result = await recordPayout({
      eventId: ended.eventId,
      grossPaise: 80_000,
      commissionPaise: 0,
      forfeitedPaise: 30_000,
      status: 'paid',
      utrReference: 'UTR900001',
      notes: null,
    })
    expect(result.ok).toBe(true)

    let rows = await listSettleableEvents()
    let row = rows.find((r) => r.eventId === ended.eventId)!
    expect(row.payout!.status).toBe('paid')
    expect(row.driftPaise).toBe(0)

    // A refund lands after settlement: the recomputation drops by ₹300.
    await db
      .from('bookings')
      .update({ status: 'refunded' })
      .eq('event_id', ended.eventId)
      .eq('status', 'cancelled')

    rows = await listSettleableEvents()
    row = rows.find((r) => r.eventId === ended.eventId)!
    expect(row.statement.netPaise).toBe(50_000)
    // The frozen row still records what left the bank.
    expect(row.payout!.net_paise).toBe(80_000)
    expect(row.driftPaise).toBe(-30_000)
  })
})

describe('recordPayout', () => {
  it('refuses a non-admin with a sentence rather than a raw Postgres error', async () => {
    signInAs(outsiderId)
    const result = await recordPayout({
      eventId: ended.eventId,
      grossPaise: 1_000,
      commissionPaise: 0,
      forfeitedPaise: 0,
      status: 'paid',
      utrReference: 'UTR1',
      notes: null,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/not.*admin/i)
  })

  it('refuses to rewrite a settled payout', async () => {
    signInAs(adminId)
    const result = await recordPayout({
      eventId: ended.eventId,
      grossPaise: 1,
      commissionPaise: 0,
      forfeitedPaise: 0,
      status: 'paid',
      utrReference: 'UTR900002',
      notes: null,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/settled/i)
  })
})

describe('hostPayoutTarget', () => {
  it('gives an admin the destination', async () => {
    signInAs(adminId)
    expect((await hostPayoutTarget(ended.hostId))?.upi_id).toBe('host@upi')
  })

  it('gives a non-admin nothing', async () => {
    signInAs(outsiderId)
    expect(await hostPayoutTarget(ended.hostId)).toBeNull()
  })
})

describe('listHostStatements', () => {
  it('shows the host their own ended events with the same numbers', async () => {
    signInAs(ended.hostProfileId)
    const rows = await listHostStatements()
    const row = rows.find((r) => r.eventId === ended.eventId)
    expect(row).toBeDefined()
    // Recomputed after the refund landed above.
    expect(row!.statement.netPaise).toBe(50_000)
    expect(row!.statement.cashPaise).toBe(25_000)
    expect(row!.payout!.utr_reference).toBe('UTR900001')
  })

  it('shows a host nothing about another host\'s event', async () => {
    signInAs(outsiderId)
    expect(await listHostStatements()).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/payouts/queries.test.ts`
Expected: FAIL — cannot resolve `@/lib/payouts/queries`.

- [ ] **Step 3: Write `lib/payouts/queries.ts`**

```ts
import 'server-only'
import { hasEnded } from '@/lib/events/datetime'
import { joinPaymentFacts, settle, type SettlementBooking, type Statement } from '@/lib/payouts/settlement'
import { createClient } from '@/lib/supabase/server'

/**
 * Reads for the settlement loop, through the ordinary session client.
 *
 * Nothing here reaches for the service role, and nothing here performs its own
 * authorisation: the admin policies added in 20260812000002 decide what comes
 * back, so a non-admin caller gets an empty list from the database rather than
 * from an `if` in this file. That is the whole reason the admin predicate lives
 * in RLS.
 */

export interface PayoutRow {
  id: string
  event_id: string
  status: 'pending' | 'paid' | 'on_hold'
  gross_paise: number
  commission_paise: number
  net_paise: number
  forfeited_paise: number
  utr_reference: string | null
  notes: string | null
  paid_at: string | null
}

export interface SettleableEvent {
  eventId: string
  title: string
  slug: string
  startsAt: string
  endsAt: string | null
  hostId: string
  hostName: string
  hostKycStatus: string
  statement: Statement
  payout: PayoutRow | null
  /**
   * Recomputed net minus the settled row's net. Null when nothing is settled.
   * Derived on every read and never stored — a drift column could only go
   * stale, and this is the same call the page already makes.
   */
  driftPaise: number | null
}

export interface HostStatement {
  eventId: string
  title: string
  slug: string
  startsAt: string
  endsAt: string | null
  statement: Statement
  payout: PayoutRow | null
}

const PAYOUT_COLUMNS =
  'id, event_id, status, gross_paise, commission_paise, net_paise, forfeited_paise, utr_reference, notes, paid_at'

/** Whether the caller may settle. Reported by the database, not inferred here. */
export async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('is_platform_admin')
  if (error) return false
  return data === true
}

export async function listSettleableEvents(now: Date = new Date()): Promise<SettleableEvent[]> {
  const supabase = await createClient()

  // starts_at < now is a necessary condition for hasEnded — events_end_after_start
  // guarantees ends_at > starts_at — so this narrows in SQL and hasEnded decides.
  // Doing the whole thing in SQL would need the coalesce duplicated there.
  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, slug, starts_at, ends_at, host_id, hosts(display_name, kyc_status)')
    .lt('starts_at', now.toISOString())
    .order('starts_at', { ascending: false })
  if (error || !events) return []

  const ended = events.filter((event) => hasEnded(event.starts_at, event.ends_at, now))
  if (ended.length === 0) return []

  const eventIds = ended.map((event) => event.id)
  const bookings = await bookingRowsFor(supabase, eventIds)
  const payouts = await payoutRowsFor(supabase, eventIds)

  return ended.map((event) => {
    const statement = settle(bookings.get(event.id) ?? [])
    const payout = payouts.get(event.id) ?? null
    return {
      eventId: event.id,
      title: event.title,
      slug: event.slug,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      hostId: event.host_id,
      hostName: event.hosts?.display_name ?? 'Unknown host',
      hostKycStatus: event.hosts?.kyc_status ?? 'pending',
      statement,
      payout,
      driftPaise: payout ? statement.netPaise - payout.net_paise : null,
    }
  })
}

/** Bookings for many events, with their money facts joined. Admin path only. */
async function bookingRowsFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  eventIds: string[],
): Promise<Map<string, SettlementBooking[]>> {
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, event_id, status, payment_mode, subtotal_paise, commission_paise')
    .in('event_id', eventIds)
  if (!bookings || bookings.length === 0) return new Map()

  const bookingIds = bookings.map((booking) => booking.id)
  const { data: payments } = await supabase
    .from('payments')
    .select('id, booking_id, status')
    .in('booking_id', bookingIds)

  const paymentIds = (payments ?? []).map((payment) => payment.id)
  const { data: refunds } = paymentIds.length
    ? await supabase.from('refunds').select('payment_id').in('payment_id', paymentIds)
    : { data: [] }

  const joined = joinPaymentFacts(bookings, payments ?? [], refunds ?? [])
  const byEvent = new Map<string, SettlementBooking[]>()
  joined.forEach((row, index) => {
    const eventId = bookings[index].event_id
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), row])
  })
  return byEvent
}

async function payoutRowsFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  eventIds: string[],
): Promise<Map<string, PayoutRow>> {
  const { data } = await supabase.from('payouts').select(PAYOUT_COLUMNS).in('event_id', eventIds)
  return new Map((data ?? []).map((row) => [row.event_id as string, row as unknown as PayoutRow]))
}

/** The destination for a transfer. Admin only; refuses through the database. */
export async function hostPayoutTarget(
  hostId: string,
): Promise<{ upi_id: string | null; bank_account_ref: string | null } | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_host_payout_target', { p_host_id: hostId })
  if (error || !data || data.length === 0) return null
  return data[0]
}

/**
 * The host's own statements.
 *
 * The per-booking money facts come from host_settlement_rows() because a host
 * may not read `payments` — rls_policies.sql:157 — so the same settle() runs
 * over rows that carry no instrument detail at all.
 */
export async function listHostStatements(now: Date = new Date()): Promise<HostStatement[]> {
  const supabase = await createClient()

  const { data: events, error } = await supabase
    .from('events')
    .select('id, title, slug, starts_at, ends_at')
    .lt('starts_at', now.toISOString())
    .order('starts_at', { ascending: false })
  if (error || !events) return []

  const ended = events.filter((event) => hasEnded(event.starts_at, event.ends_at, now))
  if (ended.length === 0) return []

  const payouts = await payoutRowsFor(supabase, ended.map((event) => event.id))

  const statements: HostStatement[] = []
  for (const event of ended) {
    const { data: rows } = await supabase.rpc('host_settlement_rows', { p_event_id: event.id })
    statements.push({
      eventId: event.id,
      title: event.title,
      slug: event.slug,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      statement: settle((rows ?? []) as SettlementBooking[]),
      payout: payouts.get(event.id) ?? null,
    })
  }
  return statements
}
```

- [ ] **Step 4: Write `lib/payouts/service.ts`**

```ts
import 'server-only'
import type { PostgrestError } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * The one write in this phase.
 *
 * NOT service-role, and that is the point: record_payout is SECURITY DEFINER
 * and gated on is_platform_admin(), so this calls it as the signed-in user and
 * the database decides. Nothing here belongs in the eslint fence, and nothing
 * here may import @/lib/supabase/admin.
 */

export type RecordPayoutResult = { ok: true } | { ok: false; error: string }

export interface RecordPayoutInput {
  eventId: string
  grossPaise: number
  commissionPaise: number
  forfeitedPaise: number
  status: 'paid' | 'on_hold'
  utrReference: string | null
  notes: string | null
}

/** Refusals as sentences an operator can act on. Anything unmapped passes through. */
function refusal(error: PostgrestError): string {
  switch (error.code) {
    case 'EH070':
      return 'This payout is already settled. Its amounts are what left the bank — record the correction in the notes instead.'
    case 'EH071':
      return 'You are not a platform admin.'
    case 'EH072':
      return 'That event no longer exists.'
    case 'EH073':
      return 'This event has not ended yet.'
    case 'EH074':
      return 'A payout is recorded as paid or on hold.'
    case 'EH075':
      return 'A settled payout needs its bank reference.'
    default:
      return error.message
  }
}

export async function recordPayout(input: RecordPayoutInput): Promise<RecordPayoutResult> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('record_payout', {
    p_event_id: input.eventId,
    p_gross_paise: input.grossPaise,
    p_commission_paise: input.commissionPaise,
    p_forfeited_paise: input.forfeitedPaise,
    p_status: input.status,
    p_utr_reference: input.utrReference,
    p_notes: input.notes,
  })
  if (error) return { ok: false, error: refusal(error) }
  return { ok: true }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/payouts/queries.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Mutation-test the assertions**

1. In `listSettleableEvents`, drop the `.filter(hasEnded(...))`. "leaves out an event that has not ended" must fail.
2. `driftPaise: payout ? … : null` → `null`. The drift test must fail.
3. In `refusal`, return `error.message` for every code. Both `recordPayout` refusal tests must fail — **if they still pass, they are matching raw Postgres prose rather than the mapped sentence**, which is not the assertion they claim to make.
4. In `listHostStatements`, replace the `host_settlement_rows` call with a direct `supabase.from('bookings')` select and hardcode `has_captured_payment: true`. "shows the host their own ended events with the same numbers" must fail on the refunded booking.
5. In `bookingRowsFor`, key the map by `bookings[0].event_id` instead of `bookings[index].event_id`. The statement test must fail once two events carry bookings — if it does not, add a second ended event with bookings to the fixture, because the grouping is untested.

- [ ] **Step 7: Confirm the fence, typecheck, lint and commit**

```bash
grep -rn "supabase/admin" lib/payouts/ && echo "FENCE BREACH" || echo "clean"
npm run typecheck && npm run lint
git add lib/payouts/queries.ts lib/payouts/service.ts lib/payouts/queries.test.ts
git commit -m "feat: the settlement reads and the payout wrapper"
```

---

### Task 6: The `/admin` console

**Files:**
- Create: `lib/payouts/admin.ts`, `app/admin/page.tsx`, `app/admin/actions.ts`, `app/admin/record-payout-form.tsx`
- Test: `app/admin/actions.test.ts`

**Interfaces:**
- Consumes: `isPlatformAdmin`, `listSettleableEvents`, `hostPayoutTarget` (Task 5); `recordPayout` (Task 5); `formatPaise` (`@/lib/money`); `formatIst` (`@/lib/events/datetime`).
- Produces: `requirePlatformAdmin()`; `recordPayoutAction(previous, formData)` with `RecordPayoutState { error?: string; ok?: boolean }`.

**The one design rule for the action.** It takes **only** `eventId`, `status`, `utr` and `notes` from the form, and **recomputes the amounts server-side** from `listSettleableEvents()`. Amounts must never arrive from a hidden input. This is the same posture `app/host/events/[id]/attendees/actions.ts` already documents — "never passes the form's eventId into the authorisation decision" — applied to money: the numbers you settle are the numbers the server computed, not the numbers a form said.

**404, not 403.** An unauthorised visitor should not learn that `/admin` exists.

- [ ] **Step 1: Write the failing tests**

Create `app/admin/actions.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  seedPlatformAdmin,
  type SeededEvent,
} from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session'

const { recordPayoutAction } = await import('@/app/admin/actions')
const { requirePlatformAdmin } = await import('@/lib/payouts/admin')

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let ended: SeededEvent

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)
  ended = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  await seedCapturedBooking(db, ended, { subtotalPaise: 50_000 })
})

afterAll(async () => {
  signInAs(null)
  await cleanupEvent(db, ended)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
})

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.append(key, value)
  return data
}

describe('requirePlatformAdmin', () => {
  // notFound() throws a Next control-flow error rather than returning, so the
  // gate is assertable without a rendering harness. This is what makes the
  // page's 404 a tested claim and not only a line in the manual walk.
  it('throws for a signed-in non-admin', async () => {
    signInAs(outsiderId)
    await expect(requirePlatformAdmin()).rejects.toThrow()
  })

  it('throws for a signed-out visitor', async () => {
    signInAs(null)
    await expect(requirePlatformAdmin()).rejects.toThrow()
  })

  it('returns for an admin', async () => {
    signInAs(adminId)
    await expect(requirePlatformAdmin()).resolves.toBeUndefined()
  })
})

describe('recordPayoutAction', () => {
  it('refuses a signed-in non-admin', async () => {
    signInAs(outsiderId)
    const result = await recordPayoutAction(
      {},
      form({ eventId: ended.eventId, status: 'paid', utr: 'UTR7', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
    expect(result.error).toBeTruthy()
  })

  it('rejects a status that is neither paid nor on_hold', async () => {
    signInAs(adminId)
    const result = await recordPayoutAction(
      {},
      form({ eventId: ended.eventId, status: 'pending', utr: 'UTR7', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
  })

  it('requires a UTR when settling', async () => {
    signInAs(adminId)
    const result = await recordPayoutAction(
      {},
      form({ eventId: ended.eventId, status: 'paid', utr: '  ', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
    expect(result.error).toMatch(/reference/i)
  })

  it('settles using the SERVER\'s numbers, not the form\'s', async () => {
    // The single most important assertion in this file. A tampered amount must
    // change nothing about what is recorded.
    signInAs(adminId)
    const result = await recordPayoutAction(
      {},
      form({
        eventId: ended.eventId,
        status: 'paid',
        utr: 'UTR800001',
        notes: '',
        grossPaise: '999999',
        netPaise: '999999',
      }),
    )
    expect(result.ok).toBe(true)

    const { data } = await db.from('payouts').select('*').eq('event_id', ended.eventId).single()
    expect(data!.gross_paise).toBe(50_000)
    expect(data!.net_paise).toBe(50_000)
  })

  it('refuses an event that is not settleable, whatever the form says', async () => {
    signInAs(adminId)
    const future = await seedEvent(db, { startsAt: new Date(Date.now() + HOUR).toISOString() })
    const result = await recordPayoutAction(
      {},
      form({ eventId: future.eventId, status: 'paid', utr: 'UTR9', notes: '' }),
    )
    expect(result.ok).toBeFalsy()
    await cleanupEvent(db, future)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/admin/actions.test.ts`
Expected: FAIL — cannot resolve `@/app/admin/actions`.

- [ ] **Step 3: Write `lib/payouts/admin.ts`**

```ts
import 'server-only'
import { notFound } from 'next/navigation'
import { isPlatformAdmin } from '@/lib/payouts/queries'

/**
 * The route segment's gate.
 *
 * notFound() rather than a 403: whether a settlement console exists is not
 * something an unauthorised visitor needs confirmed. The database refuses them
 * anyway — every read behind this is RLS-scoped and every write is gated in
 * SQL — so this decides what the page LOOKS like, not what it may touch.
 */
export async function requirePlatformAdmin(): Promise<void> {
  if (!(await isPlatformAdmin())) notFound()
}
```

- [ ] **Step 4: Write `app/admin/actions.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { listSettleableEvents } from '@/lib/payouts/queries'
import { recordPayout } from '@/lib/payouts/service'

export interface RecordPayoutState {
  error?: string
  ok?: boolean
}

export async function recordPayoutAction(
  _previous: RecordPayoutState,
  formData: FormData,
): Promise<RecordPayoutState> {
  const eventId = String(formData.get('eventId') ?? '')
  const status = String(formData.get('status') ?? '')
  const utr = String(formData.get('utr') ?? '').trim()
  const notes = String(formData.get('notes') ?? '').trim()

  if (status !== 'paid' && status !== 'on_hold') {
    return { error: 'A payout is recorded as paid or on hold.' }
  }
  if (status === 'paid' && utr === '') {
    return { error: 'A settled payout needs its bank reference.' }
  }

  // The amounts are RECOMPUTED here and never read from the form. A hidden
  // input is a number of the sender's choosing; this is a number the server
  // derived from the booking rows a moment ago. Same posture as the attendees
  // actions, which take ids from a form and authorisation from nowhere near it.
  //
  // This also re-runs the RLS-scoped read, so a non-admin finds no event and is
  // refused here before record_payout ever refuses them in SQL.
  const settleable = await listSettleableEvents()
  const event = settleable.find((row) => row.eventId === eventId)
  if (!event) return { error: 'That event is not settleable.' }

  const result = await recordPayout({
    eventId,
    grossPaise: event.statement.grossPaise,
    commissionPaise: event.statement.commissionPaise,
    forfeitedPaise: event.statement.forfeitedPaise,
    status,
    utrReference: status === 'paid' ? utr : null,
    notes: notes === '' ? null : notes,
  })
  if (!result.ok) return { error: result.error }

  revalidatePath('/admin')
  revalidatePath('/host/payouts')
  return { ok: true }
}
```

- [ ] **Step 5: Write `app/admin/record-payout-form.tsx`**

```tsx
'use client'

import { useActionState } from 'react'
import { recordPayoutAction, type RecordPayoutState } from '@/app/admin/actions'

export function RecordPayoutForm({ eventId }: { eventId: string }) {
  const [state, action, pending] = useActionState<RecordPayoutState, FormData>(
    recordPayoutAction,
    {},
  )

  return (
    <form action={action} className="border-line mt-3 space-y-2 border-t pt-3">
      <input type="hidden" name="eventId" value={eventId} />
      {/* No amount fields, deliberately. The server recomputes them. */}
      <div className="flex flex-wrap gap-2">
        <input
          name="utr"
          placeholder="UTR / bank reference"
          className="border-line min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
        />
        <input
          name="notes"
          placeholder="Notes (optional)"
          className="border-line min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          name="status"
          value="paid"
          disabled={pending}
          className="bg-ink text-paper rounded-lg px-3 py-2 text-sm disabled:opacity-50"
        >
          Record payment
        </button>
        <button
          type="submit"
          name="status"
          value="on_hold"
          disabled={pending}
          className="border-line rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
        >
          Put on hold
        </button>
      </div>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      {state.ok && <p className="text-muted text-sm">Recorded.</p>}
    </form>
  )
}
```

- [ ] **Step 6: Write `app/admin/page.tsx`**

```tsx
import { requireUser } from '@/lib/auth/session'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { requirePlatformAdmin } from '@/lib/payouts/admin'
import { hostPayoutTarget, listSettleableEvents } from '@/lib/payouts/queries'
import { RecordPayoutForm } from '@/app/admin/record-payout-form'

export const metadata = { title: 'Settlements' }

const STATUS_BADGE: Record<'pending' | 'paid' | 'on_hold', string> = {
  pending: 'bg-raised text-muted',
  paid: 'bg-green-100 text-green-800',
  on_hold: 'bg-amber-100 text-amber-800',
}

export default async function AdminConsole() {
  await requireUser()
  await requirePlatformAdmin()

  const events = await listSettleableEvents()

  // Resolved BEFORE the JSX, not inside the map. `events.map(async …)` yields an
  // array of promises as children, which is not a thing a Server Component may
  // render — and it would fire one RPC per row serially even if it were.
  const targets = new Map(
    await Promise.all(
      events
        .filter((event) => event.payout?.status !== 'paid')
        .map(async (event) => [event.eventId, await hostPayoutTarget(event.hostId)] as const),
    ),
  )

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Settlements</h1>

      {events.length === 0 ? (
        <p className="border-line text-muted rounded-xl border border-dashed p-8 text-center">
          No events have ended yet.
        </p>
      ) : (
        <ul className="space-y-4">
          {events.map((event) => {
            const target = targets.get(event.eventId) ?? null
            return (
              <li key={event.eventId} className="border-line rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{event.title}</p>
                    <p className="text-muted text-sm">
                      {formatIst(new Date(event.startsAt))} · {event.hostName}
                      {event.hostKycStatus !== 'verified' && ` · KYC ${event.hostKycStatus}`}
                    </p>
                  </div>
                  {event.payout && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-xs ${STATUS_BADGE[event.payout.status]}`}
                    >
                      {event.payout.status === 'on_hold' ? 'on hold' : event.payout.status}
                    </span>
                  )}
                </div>

                <dl className="text-muted mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt>Gross</dt>
                  <dd className="text-right">{formatPaise(event.statement.grossPaise)}</dd>
                  <dt>Commission</dt>
                  <dd className="text-right">−{formatPaise(event.statement.commissionPaise)}</dd>
                  <dt className="text-ink font-medium">Net owed</dt>
                  <dd className="text-ink text-right font-medium">
                    {formatPaise(event.statement.netPaise)}
                  </dd>
                  {event.statement.forfeitedPaise > 0 && (
                    <>
                      <dt>of which forfeited</dt>
                      <dd className="text-right">{formatPaise(event.statement.forfeitedPaise)}</dd>
                    </>
                  )}
                  {event.statement.cashPaise > 0 && (
                    <>
                      <dt>Cash the host already holds</dt>
                      <dd className="text-right">{formatPaise(event.statement.cashPaise)}</dd>
                    </>
                  )}
                </dl>

                {event.driftPaise !== null && event.driftPaise !== 0 && (
                  <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    Settled at {formatPaise(event.payout!.net_paise)}, now computes{' '}
                    {formatPaise(event.statement.netPaise)} — a difference of{' '}
                    {formatPaise(Math.abs(event.driftPaise))}. The settled row is what left the
                    bank; settle the difference out of band and note it here.
                  </p>
                )}

                {event.payout?.status === 'paid' ? (
                  <p className="text-muted mt-3 text-sm">
                    Paid {event.payout.paid_at && formatIst(new Date(event.payout.paid_at))} ·{' '}
                    {event.payout.utr_reference}
                    {event.payout.notes && ` · ${event.payout.notes}`}
                  </p>
                ) : (
                  <>
                    {target && (
                      <p className="text-muted mt-3 text-sm">
                        Pay to {target.upi_id ?? target.bank_account_ref ?? 'no destination on file'}
                      </p>
                    )}
                    <RecordPayoutForm eventId={event.eventId} />
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run app/admin/actions.test.ts`
Expected: PASS, all cases.

- [ ] **Step 8: Mutation-test the assertions**

1. In `recordPayoutAction`, take `grossPaise` from `formData` instead of the recomputed statement. "settles using the SERVER's numbers" must fail. **This is the assertion to trust least until you have seen it go red** — it passes trivially if the fixture's real amount happens to equal what the form sent, which is why the form sends `999999`.
2. Remove the `status === 'paid' && utr === ''` check. The UTR test must fail (it should then be caught by EH075 in SQL — confirm the *message* still names the reference, or the test is asserting on the wrong layer).
3. Remove the `if (!event) return` guard. "refuses an event that is not settleable" must fail.
4. Change `requirePlatformAdmin` to return without calling `notFound()`. The two `rejects.toThrow()` tests must fail. Then change it to `notFound()` unconditionally — "returns for an admin" must fail. Both directions matter: a gate that always throws passes a test that only checks the refusal.

- [ ] **Step 9: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add lib/payouts/admin.ts app/admin/
git commit -m "feat: the settlement console"
```

---

### Task 7: The host's statement page

**Files:**
- Create: `app/host/payouts/page.tsx`
- Modify: `app/host/page.tsx` (add the link)

**Interfaces:**
- Consumes: `listHostStatements` (Task 5), `requireUser`, `formatIst`, `formatPaise`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write `app/host/payouts/page.tsx`**

```tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { listHostStatements } from '@/lib/payouts/queries'

export const metadata = { title: 'Your payouts' }

export default async function HostPayouts() {
  await requireUser()
  const statements = await listHostStatements()

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your payouts</h1>
        <Link href="/host" className="text-muted text-sm hover:underline">
          Your events
        </Link>
      </div>

      {statements.length === 0 ? (
        <p className="border-line text-muted rounded-xl border border-dashed p-8 text-center">
          Nothing to settle yet. Payouts appear here once an event has finished.
        </p>
      ) : (
        <ul className="space-y-3">
          {statements.map((row) => (
            <li key={row.eventId} className="border-line rounded-xl border p-4">
              <p className="font-medium break-words">{row.title}</p>
              <p className="text-muted text-sm">{formatIst(new Date(row.startsAt))}</p>

              <dl className="text-muted mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt>Ticket sales</dt>
                <dd className="text-right">{formatPaise(row.statement.grossPaise)}</dd>
                {row.statement.commissionPaise > 0 && (
                  <>
                    <dt>Platform commission</dt>
                    <dd className="text-right">−{formatPaise(row.statement.commissionPaise)}</dd>
                  </>
                )}
                <dt className="text-ink font-medium">
                  {row.payout?.status === 'paid' ? 'Paid to you' : 'Owed to you'}
                </dt>
                <dd className="text-ink text-right font-medium">
                  {formatPaise(
                    row.payout?.status === 'paid' ? row.payout.net_paise : row.statement.netPaise,
                  )}
                </dd>
                {row.statement.cashPaise > 0 && (
                  <>
                    <dt>Collected by you in cash</dt>
                    <dd className="text-right">{formatPaise(row.statement.cashPaise)}</dd>
                  </>
                )}
              </dl>

              {row.payout?.status === 'paid' ? (
                <p className="text-muted mt-3 text-sm">
                  Sent {row.payout.paid_at && formatIst(new Date(row.payout.paid_at))} · ref{' '}
                  {row.payout.utr_reference}
                </p>
              ) : row.payout?.status === 'on_hold' ? (
                <p className="text-muted mt-3 text-sm">
                  On hold{row.payout.notes ? ` — ${row.payout.notes}` : ''}.
                </p>
              ) : (
                <p className="text-muted mt-3 text-sm">Not settled yet.</p>
              )}

              {row.statement.cashPaise > 0 && (
                <p className="text-muted mt-1 text-xs">
                  Cash you took at the door never passed through the platform, so it is not part of
                  this transfer.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 2: Link it from the host dashboard**

In `app/host/page.tsx`, in the header row that currently holds only the "New event" link, add a payouts link before it:

```tsx
        <div className="flex items-center gap-3">
          <Link href="/host/payouts" className="text-muted text-sm hover:underline">
            Payouts
          </Link>
          <Link href="/host/events/new" className="bg-ink text-paper rounded-lg px-4 py-2 text-sm">
            New event
          </Link>
        </div>
```

replacing the bare `<Link href="/host/events/new" …>` element (keep the surrounding `<div className="mb-6 flex items-center justify-between">`).

- [ ] **Step 3: Verify the page renders and the numbers match**

Run the suite — `npx vitest run lib/payouts/` — and confirm `listHostStatements` is still green. Then check the page by hand in Task 8's walk; there is no unit test for JSX in this repo and adding a rendering harness is out of scope for this phase.

- [ ] **Step 4: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add app/host/payouts/ app/host/page.tsx
git commit -m "feat: the host's payout statements"
```

---

### Task 8: Whole-phase verification

No new code. This task exists because the previous session's most useful finding — the walk-up gate — came from a manual check no test in the repo could reach.

- [ ] **Step 1: The whole suite, from a clean database**

```bash
npm run db:reset && npm run db:types
npm test
```
Expected: green, and **more tests than the 819 the phase started from**. Record both numbers.

- [ ] **Step 2: Confirm the fence and the fee posture**

```bash
# No new service-role importer.
grep -rn "supabase/admin" lib/payouts/ app/admin/ app/host/payouts/ && echo "BREACH" || echo "clean"
# No task turned fees on.
grep -rn "calculatePrice\|commission_bps\|fee_rules" lib/payouts/ app/admin/ && echo "REVIEW" || echo "clean"
# The eslint fence list is unchanged.
git diff master --stat -- eslint.config.mjs
```
Each must be clean; `eslint.config.mjs` must show no diff at all.

- [ ] **Step 3: Migrations apply to a scratch database**

Both new migrations reference `auth.users` and existing tables, so a bare database needs the baseline stub the Task 7 sections of the Phase 5b and Phase 4 plans carry. Apply all 18 migrations in order to a scratch database and confirm they succeed with no manual intervention.

- [ ] **Step 4: The manual walk — the part no test covers**

Against `npm run dev` (port 3100) and the local stack:

1. Sign in as a user who is **not** an admin. Visit `/admin`. **Expect a 404 page**, not a 403 and not a redirect to login. This is the one check that exercises `requirePlatformAdmin`; the action tests deliberately do not go through the page.
2. Make yourself an admin: `insert into platform_admins (profile_id) values ('<your profile id>');` against the service role. Reload `/admin`. The ended events appear.
3. Pick an event, read the net, record a payment with a UTR. Confirm the row flips to **paid**, the form disappears, and the UTR shows.
4. Reload. Confirm the amounts have not moved.
5. As the **host** of that event, open `/host/payouts`. Confirm the same net and the same UTR appear, and that no payment or refund detail does.
6. Against the service role, flip one of that event's counted bookings to `refunded`. Reload `/admin`. **Confirm the drift banner appears** with the right delta and the settled row still shows the original amount.
7. Try to settle an event that has not ended by posting its id — confirm it is refused.

- [ ] **Step 5: Record what was found**

Add a "Carried into Phase 6b" section to the spec listing anything triaged as non-blocking, in the shape 5b's "Carried into Phase 6" section uses. If nothing was found, say so explicitly rather than omitting the section.

- [ ] **Step 6: Commit**

```bash
git add docs/specs/2026-08-12-phase-6a-settlement-design.md
git commit -m "docs: what Phase 6a shipped knowingly"
```
