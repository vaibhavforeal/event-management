# Phase 3 — Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paid, no-approval event completes publish → WhatsApp link → pay (Razorpay sheet over the booking page) → per-seat QR → door scan, with the webhook — never the attendee's browser — as the only writer of payment truth, and refunds on both cancel surfaces governed by a per-event cutoff.

**Architecture:** One new `SECURITY DEFINER` function, `begin_paid_booking`, mirrors `book_free_tickets`' guard block with the price guard inverted and stops at the hold — no confirm. `lib/payments/` mirrors `lib/bookings/`: a provider interface (`provider.ts`, the mocked seam in every integration test), a plain-`fetch` Razorpay adapter (`razorpay.ts`, no SDK), a service (`service.ts`, the **third and last** file allowed to import `lib/supabase/admin.ts`), a pure refund policy, and an `EH03x` SQLSTATE mapper. One processor (`processWebhookEvent`/`applyPayment`) does every payment write, fed by the webhook route and by `reconcileBooking`; the unique constraints Phase 0 built (`payments.provider_payment_id`, `(provider, provider_order_id)`, `(provider, provider_event_id)`, `refunds.provider_refund_id`) make replays no-ops. `cancelBooking` gains a typed initiator and hands money to `refundIfOwed` after the seat is freed.

**Tech Stack:** Postgres 17 (local Supabase), plpgsql, Next.js 16.3 App Router, React 19.2, TypeScript, Tailwind 4 (paper-palette tokens), supabase-js 2.x, Vitest 4, Razorpay Standard Checkout (`checkout.js` via `next/script`), `node:crypto` HMAC-SHA256 + `timingSafeEqual`. **No new runtime dependencies.**

**Spec:** [`docs/specs/2026-08-10-phase-3-payments-design.md`](../specs/2026-08-10-phase-3-payments-design.md)

## Global Constraints

- **Identity never comes from a form.** Every write takes a `Caller` from `lib/bookings/caller.ts` (reused, not re-branded); only `currentCaller()` can produce one.
- **`lib/supabase/admin.ts` may be imported by exactly three files** after Task 5: `lib/bookings/service.ts`, `lib/checkin/service.ts`, `lib/payments/service.ts`. Extending the ESLint `ignores` list and its message is Task 5's job alone.
- **RLS does not protect service-role writes.** Every authorisation decision in `lib/payments/service.ts` is the whole of the rule.
- **The webhook confirms; the browser only watches.** The client's success handler starts polling and hands over its `{payment_id, signature}` proof; every write is made server-side from Razorpay's API answer, never from the client's claim.
- **Money is integer paise** (`lib/money.ts`); floats are forbidden; display via `formatPaise`.
- **`convenience_fee_paise` and `commission_paise` stay 0.** `reserve_tickets`' defaults already do this; no task passes a fee.
- **The three `RAZORPAY_*` env vars stay `.optional()` in `lib/env.ts`** — a free-only checkout must boot without a Razorpay account. `startPaidCheckout` fails loudly (one sentence + `console.error`) when they are missing. The key id is not a secret and reaches the checkout client component as a prop from the server component (the `scan/page.tsx` → `Scanner` precedent), never as a new `NEXT_PUBLIC_*` var.
- **Razorpay's signature scheme is its own, not `standardwebhooks`** (that package serves `app/api/hooks/send-sms/route.ts` and stays there). HMAC-SHA256 hex, compared with `node:crypto`'s `timingSafeEqual` behind a length check.
- **`params` and `searchParams` are Promises** in Next.js 16 — use the generated `PageProps<'/route'>` helpers. **`cookies()` is async.** Route handlers use web-standard `Request`/`Response`; the raw body comes from `await request.text()` **before** any JSON parse.
- **Run `npm run db:types` after the migration.** `lib/supabase/types.ts` is committed, never hand-edited.
- **`npm test` needs `npm run db:start`,** which needs Docker Desktop, which starts only via PowerShell: `powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`. A `createTestUser failed: fetch failed` error means the stack is down, not an app bug.
- **Dev server: `localhost:3100`, never `127.0.0.1:3100`** (the IP form 403s dev chunks and React never hydrates).
- **Subagents dispatched with `model: "sonnet"` fail on this Foundry deployment.** Use the inherited session model or `haiku`.
- **The session mock installs as an import side effect** (`tests/helpers/session.ts`'s `signInAs`); a module under test that needs mocks must be imported with a top-level `await import` after `vi.mock` calls.
- **`lib/events/actions.test.ts` is order-dependent; do not append to it.** New tests go in new files.
- **Baseline suite: ≥376 tests, all green** (376/35 files at `fd2d061`; commit `34e9be0` may have added a few — record the exact number in Task 1). Never finish a task with a red suite.
- **`supabase db psql` does not exist** in this CLI version; `supabase db query` is the working form.
- **Colours come from the `globals.css` tokens** (`paper/ink/muted/line/accent/raised`); semantic green/amber/red stay Tailwind hues. No hex literals in components — which is also why the Razorpay sheet keeps its default theme (its `theme.color` option takes only a hex).
- **`C:` is ~99% full.** `npm run db:stop` when the session ends.
- **Work on branch `phase-3-payments`** (created in Task 1, merged `--no-ff` after the final review).

## Razorpay contract (verified against razorpay.com/docs, 2026-08-10)

The adapter implements exactly this; nothing else in the app may talk to Razorpay.

| Concern | Fact |
|---|---|
| Auth | HTTP Basic: `Authorization: Basic base64(key_id:key_secret)` |
| Create order | `POST https://api.razorpay.com/v1/orders` `{amount, currency: 'INR', receipt, notes}`; `amount` integer paise; `receipt` ≤ 40 chars unique (the 8-char booking reference qualifies); response order id is top-level `id` |
| Fetch payments | `GET /v1/orders/{id}/payments` → `{entity:'collection', count, items:[payment…]}`; payment fields `id, order_id, amount, status ('created'\|'authorized'\|'captured'\|'refunded'\|'failed'), method, error_code, error_description` |
| Create refund | `POST /v1/payments/{payment_id}/refund`; **omit `amount` for a full refund**; send `speed: 'normal'` explicitly (docs disagree on the default); response `{id, status}` with status `pending\|processed\|failed` — the same words as our `refund_status` enum |
| Webhook signature | header `X-Razorpay-Signature` = HMAC-SHA256(webhook secret, **raw body bytes**), lowercase hex |
| Webhook dedup | header `x-razorpay-event-id`, unique per event |
| Webhook envelope | `{entity:'event', account_id, event, contains, created_at, payload}`; payment entity at `payload.payment.entity`, refund entity at `payload.refund.entity` |
| Checkout | script `https://checkout.razorpay.com/v1/checkout.js`; options **require** `key, amount, currency, name, order_id` (plus `handler`, optional `modal.ondismiss`, `prefill`); success handler receives `razorpay_payment_id, razorpay_order_id, razorpay_signature` |
| Checkout signature | HMAC-SHA256(key_secret, `order_id + '\|' + payment_id`) hex — computed against the **server-stored** order id, never the client-returned one |

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260811000002_paid_bookings.sql` | **New.** `events.refund_cutoff_hours`; `create/update_event_with_ticket_type` re-created with `p_refund_cutoff_hours`; `begin_paid_booking` (`EH030`–`EH033`); revoke/grant pairs. |
| `lib/supabase/types.ts` | **Regenerated.** |
| `lib/events/validation.ts` | **Modified.** `refundCutoffHours` in schema, `EVENT_FORM_FIELDS`, `OMITTED_TEXT_DEFAULTS`. |
| `app/host/events/event-form.tsx` | **Modified.** The cutoff number field, `Draft`/`EventFormValues` entries. |
| `app/host/events/actions.ts` | **Modified.** Both RPC calls pass `p_refund_cutoff_hours`. |
| `app/host/events/[id]/edit/page.tsx` | **Modified.** `values` gains `refundCutoffHours`. |
| `lib/events/queries.ts` | **Modified.** `OwnedEvent` + `PublicEvent` (+ selects) gain `refund_cutoff_hours`. |
| `lib/payments/refund-policy.ts` | **New.** Pure. `refundDecision`, `refundCutoffAt`, `refundPolicySentence`, `cancelConsequence`. |
| `lib/payments/rpc-errors.ts` | **New.** Pure. `mapPaymentRpcError` (`EH030`–`EH033`). |
| `lib/payments/provider.ts` | **New.** The `PaymentProvider` interface + provider-agnostic types. |
| `lib/payments/razorpay.ts` | **New.** The adapter: plain `fetch`, basic auth, four endpoints, both signature verifiers, `RazorpayConfigError`. |
| `lib/payments/service.ts` | **New.** `startPaidCheckout`, `processWebhookEvent`, `reconcileBooking`, `reconcileAfterCheckout`, `refundIfOwed`, `runReconciliationSweep`. The third admin importer. |
| `eslint.config.mjs` | **Modified.** Fence `ignores` + message gain `lib/payments/service.ts`. |
| `lib/checkin/service.ts` | **Modified.** The "second — and last —" header comment amended. |
| `app/api/webhooks/razorpay/route.ts` | **New.** POST only: raw body → verify → dedup → dispatch → stamp; 401/400/500 per spec. |
| `lib/bookings/service.ts` | **Modified.** `cancelBooking(caller, bookingId, initiator)`; calls `refundIfOwed` after the seat is freed. |
| `app/bookings/actions.ts`, `app/host/events/[id]/attendees/actions.ts` | **Modified.** Pass the typed initiator. |
| `lib/bookings/queries.ts` | **Modified.** `BOOKING_COLUMNS` gains `total_paise, hold_expires_at, attendee_name`, `events.refund_cutoff_hours`, `payments(provider_order_id, status)`; interfaces updated. |
| `app/e/[slug]/actions.ts`, `book-panel.tsx`, `page.tsx` | **Modified.** The paid form action, the `paid` panel mode, the policy sentence. |
| `app/bookings/[reference]/page.tsx` | **Modified.** Status branches, page-load reconcile, checkout panel mount, policy sentence. |
| `app/bookings/[reference]/checkout-panel.tsx` | **New.** Client: `next/script` + sheet + countdown + polling. |
| `app/bookings/[reference]/actions.ts` | **New.** `pollBookingStatus` Server Action. |
| `app/bookings/cancel-button.tsx`, `app/bookings/page.tsx` | **Modified.** Consequence line before the tap. |
| `app/host/events/[id]/attendees/…` | **Modified.** "Removing refunds ₹X in full." on paid rows. |
| `scripts/reconcile.ts`, `package.json` | **New/Modified.** `npm run reconcile` — the where-nobody-is-looking sweep. |
| `tests/helpers/payments.ts` | **New.** `fakeProvider`, `seedPaidBooking`, webhook fixture builders. |

---

### Task 1: The paid-booking migration

**Files:**
- Create: `supabase/migrations/20260811000002_paid_bookings.sql`
- Create: `lib/payments/begin-paid-booking.test.ts`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Consumes: `reserve_tickets` (called inside the new function), `tests/helpers/db.ts` (`adminClient`, `userClient`, `createTestUser`, `seedEvent`, `cleanupEvent` — **read that file's exports and the `SeededEvent` shape before writing setup**; the field names below are believed correct but the helper is the authority).
- Produces (later tasks call these over `.rpc()` as the service role):
  - `begin_paid_booking(p_ticket_type_id uuid, p_attendee_id uuid, p_quantity integer, p_attendee_name text) returns bookings` — booking `awaiting_payment`, 10-minute hold, `payment_mode 'online'`, fees 0, **no confirm, no tickets**.
  - SQLSTATEs: `EH030` (free ticket type), `EH031` (requires approval), `EH032` (started), `EH033` (already an active booking; also the `unique_violation` remap). Delegated guards (unpublished, sales window, `max_per_order`, availability) surface as `reserve_tickets`' existing `check_violation` (`23514`) refusals with human-written messages.
  - `create_event_with_ticket_type` / `update_event_with_ticket_type` re-created with a trailing `p_refund_cutoff_hours integer default 24`.
  - `events.refund_cutoff_hours integer not null default 24 check (refund_cutoff_hours >= 0)` — `0` means "refundable until start".

- [ ] **Step 1: Branch, stack up, record the baseline**

```bash
git checkout -b phase-3-payments
npm run db:start   # Docker via PowerShell first if it is down
npm test           # record the exact test/file count for the final task
```

- [ ] **Step 2: Write the failing integration test**

`lib/payments/begin-paid-booking.test.ts`. Model setup on `lib/bookings/book-free-tickets.test.ts` (read it first). Remember teardown order — bookings before users (`ON DELETE RESTRICT`) — and distinct attendees per active booking (the partial unique index).

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, userClient, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()
let paid: SeededEvent

beforeAll(async () => {
  paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
})
afterAll(async () => {
  await cleanupEvent(db, paid)
})

describe('begin_paid_booking', () => {
  it('holds seats without confirming', async () => {
    const { data, error } = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Asha  ',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'awaiting_payment',
      quantity: 2,
      subtotal_paise: 100_000,
      total_paise: 100_000,
      payment_mode: 'online',
      attendee_name: 'Asha',
    })
    expect(data!.hold_expires_at).toBeTruthy()
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', data!.id)
    expect(count).toBe(0)
    // release the hold so later tests see clean inventory
    await db.rpc('cancel_booking', { p_booking_id: data!.id, p_reason: 'test cleanup' })
  })

  it('refuses a free ticket type with EH030', async () => {
    const free = await seedEvent(db, { quantity: 5, pricePaise: 0, status: 'published' })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: free.ticketTypeId,
        p_attendee_id: free.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('EH030')
    } finally {
      await cleanupEvent(db, free)
    }
  })

  it('refuses an approval-gated event with EH031', async () => {
    const gated = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'published', requiresApproval: true })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: gated.ticketTypeId,
        p_attendee_id: gated.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('EH031')
    } finally {
      await cleanupEvent(db, gated)
    }
  })

  it('refuses a started event with EH032', async () => {
    const past = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'published' })
    try {
      await db.from('events').update({ starts_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', past.eventId)
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: past.ticketTypeId,
        p_attendee_id: past.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('EH032')
    } finally {
      await cleanupEvent(db, past)
    }
  })

  it('refuses a second active booking with EH033', async () => {
    const buyer = await createTestUser(db)
    const first = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: buyer.userId,
      p_quantity: 1,
      p_attendee_name: 'Ravi',
    })
    expect(first.error).toBeNull()
    const again = await db.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: buyer.userId,
      p_quantity: 1,
      p_attendee_name: 'Ravi',
    })
    expect(again.error?.code).toBe('EH033')
    await db.rpc('cancel_booking', { p_booking_id: first.data!.id, p_reason: 'test cleanup' })
  })

  it('refuses a draft event through reserve_tickets (23514)', async () => {
    const draft = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'draft' })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: draft.ticketTypeId,
        p_attendee_id: draft.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error?.code).toBe('23514')
      expect(error?.message).toMatch(/not open for booking/)
    } finally {
      await cleanupEvent(db, draft)
    }
  })

  it('refuses a quantity above max_per_order through reserve_tickets', async () => {
    const capped = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published', maxPerOrder: 4 })
    try {
      const { error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: capped.ticketTypeId,
        p_attendee_id: capped.attendeeId,
        p_quantity: 5,
        p_attendee_name: 'Asha',
      })
      expect(error).not.toBeNull()
      const { count } = await db.from('bookings').select('*', { count: 'exact', head: true }).eq('event_id', capped.eventId)
      expect(count).toBe(0)
    } finally {
      await cleanupEvent(db, capped)
    }
  })

  it('books online even when the event allows cash', async () => {
    const cashy = await seedEvent(db, { quantity: 5, pricePaise: 50_000, status: 'published', allowsCash: true })
    try {
      const { data, error } = await db.rpc('begin_paid_booking', {
        p_ticket_type_id: cashy.ticketTypeId,
        p_attendee_id: cashy.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      expect(error).toBeNull()
      expect(data!.payment_mode).toBe('online')
    } finally {
      await cleanupEvent(db, cashy)
    }
  })

  it('stays unreachable over PostgREST for authenticated users', async () => {
    const asUser = userClient(paid.attendeeId)
    const { error } = await asUser.rpc('begin_paid_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error?.message).toMatch(/permission denied/)
  })
})

describe('refund_cutoff_hours on the event writers', () => {
  it('creates with an explicit cutoff and defaults to 24 without one', async () => {
    const seed = await seedEvent(db, { quantity: 5, pricePaise: 0, status: 'published' })
    try {
      const { data: withCutoff, error } = await db.rpc('create_event_with_ticket_type', {
        p_host_id: seed.hostId,
        p_slug: `plan-test-cutoff-${Date.now()}`,
        p_title: 'Cutoff test event',
        p_description: null,
        p_city: 'Bengaluru',
        p_venue_name: null,
        p_venue_address: null,
        p_cover_image_url: null,
        p_starts_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
        p_ends_at: null,
        p_requires_approval: false,
        p_allows_cash: false,
        p_hide_venue_until_approved: false,
        p_price_paise: 50_000,
        p_quantity: 5,
        p_refund_cutoff_hours: 48,
      })
      expect(error).toBeNull()
      expect(withCutoff!.refund_cutoff_hours).toBe(48)

      const { data: updated } = await db.rpc('update_event_with_ticket_type', {
        p_event_id: withCutoff!.id,
        p_title: 'Cutoff test event',
        p_description: null,
        p_city: 'Bengaluru',
        p_venue_name: null,
        p_venue_address: null,
        p_cover_image_url: null,
        p_starts_at: withCutoff!.starts_at,
        p_ends_at: null,
        p_requires_approval: false,
        p_allows_cash: false,
        p_hide_venue_until_approved: false,
        p_price_paise: 50_000,
        p_quantity: 5,
        p_refund_cutoff_hours: 0,
      })
      expect(updated!.refund_cutoff_hours).toBe(0)
      await expect(seedEventRowCutoff(seed)).resolves.toBe(24) // helper below
      await db.from('events').delete().eq('id', withCutoff!.id)
    } finally {
      await cleanupEvent(db, seed)
    }
  })
})

// Every pre-existing row (and every row seeded without the arg) carries the default.
async function seedEventRowCutoff(seed: SeededEvent): Promise<number> {
  const { data } = await db.from('events').select('refund_cutoff_hours').eq('id', seed.eventId).single()
  return data!.refund_cutoff_hours
}
```

Note: `update_event_with_ticket_type` runs as `current_host_id()` (SECURITY INVOKER). If the admin client cannot satisfy that ownership check, drive the update through `userClient(<host profile id>)` instead — read `tests/helpers/db.ts` and the RLS file to pick the working caller, and keep the assertion the same.

- [ ] **Step 3: Run it, confirm it fails on the missing function**

Run: `npx vitest run lib/payments/begin-paid-booking.test.ts`
Expected: FAIL — PostgREST "Could not find the function public.begin_paid_booking".

- [ ] **Step 4: Write the migration**

`supabase/migrations/20260811000002_paid_bookings.sql`. Three parts.

Part 1 — the column:

```sql
-- Phase 3: the paid checkout path. One new column, one new function, and the
-- event writers learn the refund cutoff.
--
-- refund_cutoff_hours: full refund on attendee self-cancel until this many
-- hours before starts_at; after that the attendee may still cancel -- the host
-- wants the seat freed and the no-show signalled -- but no money moves. 0
-- means "refundable until start". Host-initiated cancels always refund in
-- full; that rule lives in lib/payments/refund-policy.ts, not here -- the
-- column is the event's number, the policy is TypeScript's.

alter table events add column refund_cutoff_hours integer not null default 24
  check (refund_cutoff_hours >= 0);
```

Part 2 — the event writers. **`create or replace` cannot change a signature: it would create an overload beside the old function and PostgREST would refuse the ambiguous name. Drop first.** Copy both function bodies **verbatim** from `supabase/migrations/20260809000001_event_write_transactions.sql:42-194`, then apply exactly these edits:

```sql
drop function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
);
drop function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
);
```

- Both parameter lists gain a trailing `p_refund_cutoff_hours integer default 24` (the default keeps the generated `Args` type optional, so `app/host/events/actions.ts` still compiles until Task 2 passes it).
- `create_event_with_ticket_type`'s `insert into events (...)` column list gains `refund_cutoff_hours` and its `values (...)` list gains `p_refund_cutoff_hours` (keep list order aligned).
- `update_event_with_ticket_type`'s `update events set ...` gains `refund_cutoff_hours = p_refund_cutoff_hours`.
- Repeat the revoke/grant pairs from `20260809000001:225-243` with the new signatures (each type list gains a trailing `integer`): revoke from `public, anon`; grant to `authenticated, service_role`.

Part 3 — the new function:

```sql
-- Beginning a paid booking, as one transaction that STOPS at the hold.
--
-- The mirror of book_free_tickets' guard block with the price guard inverted:
-- this path exists only for tickets that cost money. It reserves inventory
-- (10-minute hold, awaiting_payment) and returns; confirm_booking runs later,
-- from the webhook processor, when Razorpay says the money moved. That is why
-- search_path is public alone -- this function never confirms, so it never
-- needs pgcrypto's gen_random_bytes from extensions.
--
--   EH030  the ticket type is free; the paid path does not apply
--   EH031  the event requires host approval; that flow is Phase 5
--   EH032  the event has already started
--   EH033  this attendee already has an active booking on this event
--
-- payment_mode 'cash' stays refused by construction: there is no parameter to
-- ask for it, and reserve_tickets' default is 'online'. Fees and commission
-- stay at their 0 defaults -- Phase 3 charges the ticket price exactly.
--
-- Published status, the sales window, max_per_order and availability under
-- the row lock are reserve_tickets' job, and its refusals are already
-- sentences a person can read. They pass through.

create or replace function begin_paid_booking(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text
)
returns bookings
language plpgsql
security definer
set search_path = public
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

  if tt.price_paise = 0 then
    raise exception 'this ticket type is free; use the free booking path'
      using errcode = 'EH030';
  end if;

  if ev.requires_approval then
    raise exception 'this event requires host approval before booking'
      using errcode = 'EH031';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH032';
  end if;

  -- The friendly half of the one-booking rule; the partial unique index is
  -- the half that holds under concurrency. Same shape as book_free_tickets.
  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH033';
  end if;

  booking := reserve_tickets(
    p_ticket_type_id => p_ticket_type_id,
    p_attendee_id    => p_attendee_id,
    p_quantity       => p_quantity
  );

  -- reserve_tickets has no name parameter and should not grow one (see
  -- 20260810000003). Written here, inside the same transaction.
  update bookings
     set attendee_name = nullif(btrim(p_attendee_name), '')
   where id = booking.id
  returning * into booking;

  return booking;

exception
  -- The pre-check loses the race sometimes; the index never does. Same
  -- remap, and the same reasoning, as book_free_tickets' handler.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH033';
    end if;
    raise;
end;
$$;

-- EXECUTE is granted to PUBLIC by default; revoking from public also strips
-- service_role, so the grant back is required, not decorative. anon named
-- explicitly for the same hosted-project reason as 20260810000003.
revoke execute on function begin_paid_booking(uuid, uuid, integer, text)
  from public, anon, authenticated;

grant execute on function begin_paid_booking(uuid, uuid, integer, text)
  to service_role;
```

- [ ] **Step 5: Apply and regenerate types**

```bash
npm run db:reset
npm run db:types
```

- [ ] **Step 6: Run the test, confirm it passes**

Run: `npx vitest run lib/payments/begin-paid-booking.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green (the event actions still compile — the new arg is optional in the generated types).

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260811000002_paid_bookings.sql lib/payments/begin-paid-booking.test.ts lib/supabase/types.ts
git commit -m "feat: begin_paid_booking and the refund cutoff column"
```

---

### Task 2: The refund cutoff through the host form

**Files:**
- Modify: `lib/events/validation.ts` (schema, `EVENT_FORM_FIELDS`, `OMITTED_TEXT_DEFAULTS`)
- Modify: `app/host/events/event-form.tsx` (`EventFormValues`, `Draft`, `draftFromValues`, `draftFromEcho`, the field)
- Modify: `app/host/events/actions.ts` (both RPC calls)
- Modify: `app/host/events/[id]/edit/page.tsx` (`values` map)
- Modify: `lib/events/queries.ts` (`OwnedEvent` interface + `getOwnedEvent` select)
- Test: `lib/events/validation.test.ts` (append; this file is not the order-dependent one)

**Interfaces:**
- Consumes: `p_refund_cutoff_hours` on both event writers (Task 1).
- Produces: `EventDraftInput.refundCutoffHours: number` — parsed, validated, persisted; the edit form round-trips it. Task 10/11's policy sentences read the column this writes.

- [ ] **Step 1: Write the failing validation tests**

Append to `lib/events/validation.test.ts` (model assertions on that file's existing style — read it first):

```ts
describe('refundCutoffHours', () => {
  it('parses a plain number of hours', () => {
    const result = parseEventForm(formDataWith({ refundCutoffHours: '48' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.refundCutoffHours).toBe(48)
  })

  it('defaults to 24 when the field is blank or absent', () => {
    const result = parseEventForm(formDataWith({}))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.refundCutoffHours).toBe(24)
  })

  it('accepts 0 — refundable until start', () => {
    const result = parseEventForm(formDataWith({ refundCutoffHours: '0' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.refundCutoffHours).toBe(0)
  })

  it('refuses negatives with a sentence', () => {
    const result = parseEventForm(formDataWith({ refundCutoffHours: '-2' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.refundCutoffHours).toBe('The refund cutoff cannot be negative')
  })

  it('refuses fractions with a sentence', () => {
    const result = parseEventForm(formDataWith({ refundCutoffHours: '1.5' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.refundCutoffHours).toBe('Refund cutoff must be a whole number of hours')
  })

  it('refuses more than 30 days with a sentence', () => {
    const result = parseEventForm(formDataWith({ refundCutoffHours: '721' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.refundCutoffHours).toBe('Keep the refund cutoff within 30 days (720 hours)')
  })
})
```

(`formDataWith` = whatever minimal-valid-form builder the file already uses; if it has none, build a `FormData` with the required fields — title, city, startsAtLocal, seats — plus the override.)

- [ ] **Step 2: Run them, confirm they fail**

Run: `npx vitest run lib/events/validation.test.ts`
Expected: FAIL — `refundCutoffHours` unknown on the parse result.

- [ ] **Step 3: Add the field to the validation module**

`lib/events/validation.ts` — three lockstep edits (the `satisfies` clause makes forgetting one a compile error):

In `eventDraftSchema`, after `priceRupees`:

```ts
    refundCutoffHours: z.coerce
      .number('Refund cutoff must be a whole number of hours')
      .int('Refund cutoff must be a whole number of hours')
      .min(0, 'The refund cutoff cannot be negative')
      .max(720, 'Keep the refund cutoff within 30 days (720 hours)'),
```

In `EVENT_FORM_FIELDS`, after `priceRupees: 'text',`:

```ts
  refundCutoffHours: 'text',
```

In `OMITTED_TEXT_DEFAULTS`, after `priceRupees: '0',`:

```ts
  refundCutoffHours: '24',
```

Update the `OMITTED_TEXT_DEFAULTS` doc comment's count ("five of the thirteen" → "six of the fifteen") so it stays true.

- [ ] **Step 4: Run the validation tests, confirm they pass**

Run: `npx vitest run lib/events/validation.test.ts`
Expected: PASS. (`npm run typecheck` will still fail — the form components don't compile yet; that is the next step's job.)

- [ ] **Step 5: Thread it through the form component**

`app/host/events/event-form.tsx`:

- `EventFormValues` gains `refundCutoffHours?: number` (after `priceRupees`).
- `Draft` gains `refundCutoffHours: string`.
- `draftFromValues` gains `refundCutoffHours: String(values.refundCutoffHours ?? 24),`.
- `draftFromEcho` gains `refundCutoffHours: echo.refundCutoffHours,`.
- After the seats/price grid, add the field (same markup pattern as the seats input):

```tsx
      <div>
        <label htmlFor="refundCutoffHours" className="block text-sm font-medium">
          Refund cutoff (hours before start)
        </label>
        <input
          id="refundCutoffHours"
          name="refundCutoffHours"
          type="number"
          min={0}
          max={720}
          value={draft.refundCutoffHours}
          onChange={(event) => set('refundCutoffHours', event.target.value)}
          required
          className={field}
        />
        <p className="text-muted mt-1 text-xs">
          Guests who cancel earlier than this get a full refund. 0 means refundable until start.
        </p>
        {state.fieldErrors?.refundCutoffHours && (
          <p className="text-sm text-red-600">{state.fieldErrors.refundCutoffHours}</p>
        )}
      </div>
```

(Use the component's actual draft-setter name — the file's existing number fields show it.)

- [ ] **Step 6: Pass it at both RPC call sites**

`app/host/events/actions.ts` — `createEvent`'s RPC literal gains, after `p_quantity: input.seats,`:

```ts
    p_refund_cutoff_hours: input.refundCutoffHours,
```

and identically in `updateEvent`'s literal. The `satisfies Nullable<...> as ...` clauses need no change.

- [ ] **Step 7: Round-trip it on the edit page**

`lib/events/queries.ts`: `OwnedEvent` gains `refund_cutoff_hours: number`; `getOwnedEvent`'s select string gains `refund_cutoff_hours` (keep it beside `requires_approval, allows_cash`).

`app/host/events/[id]/edit/page.tsx`: the `values={{ ... }}` literal gains:

```tsx
          refundCutoffHours: event.refund_cutoff_hours,
```

(`app/host/events/new/page.tsx` needs nothing: `draftFromValues` already defaults to 24.)

- [ ] **Step 8: Full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add lib/events/validation.ts lib/events/validation.test.ts lib/events/queries.ts app/host/events/event-form.tsx app/host/events/actions.ts "app/host/events/[id]/edit/page.tsx"
git commit -m "feat: hosts set the refund cutoff on the event form"
```

---

### Task 3: The pure payment domain — refund policy and EH03x sentences

**Files:**
- Create: `lib/payments/refund-policy.ts`
- Create: `lib/payments/rpc-errors.ts`
- Test: `lib/payments/refund-policy.test.ts`, `lib/payments/rpc-errors.test.ts`

**Interfaces:**
- Consumes: `formatPaise` from `lib/money.ts`; `istLocalToUtc` from `lib/events/datetime.ts` (tests only).
- Produces (Tasks 8, 10, 11, 12 import these exact names):
  - `type CancelInitiator = 'attendee' | 'host'`
  - `type RefundDecision = 'full' | 'none'`
  - `refundCutoffAt(startsAt: string, cutoffHours: number): Date`
  - `refundDecision(input: { initiator: CancelInitiator; startsAt: string; cutoffHours: number; now?: Date }): RefundDecision`
  - `refundPolicySentence(cutoffHours: number): string`
  - `cancelConsequence(input: { initiator: CancelInitiator; totalPaise: number; startsAt: string; cutoffHours: number; now?: Date }): string | null`
  - `mapPaymentRpcError(error: PostgrestError): string`

- [ ] **Step 1: Write the failing tests**

`lib/payments/refund-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { istLocalToUtc } from '@/lib/events/datetime'
import { cancelConsequence, refundCutoffAt, refundDecision, refundPolicySentence } from '@/lib/payments/refund-policy'

// A supper club at 7:30 pm IST on 15 Aug, cutoff 24 h → refunds end 7:30 pm IST on 14 Aug.
const startsAt = istLocalToUtc('2026-08-15T19:30').toISOString()
const cutoff = istLocalToUtc('2026-08-14T19:30')

describe('refundCutoffAt', () => {
  it('subtracts whole hours from the start', () => {
    expect(refundCutoffAt(startsAt, 24).getTime()).toBe(cutoff.getTime())
  })
  it('cutoff 0 is the start itself', () => {
    expect(refundCutoffAt(startsAt, 0).toISOString()).toBe(startsAt)
  })
})

describe('refundDecision', () => {
  it('host cancels: full, any time — even mid-event', () => {
    expect(refundDecision({ initiator: 'host', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-15T20:00') })).toBe('full')
  })
  it('attendee inside the window: full', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-13T10:00') })).toBe('full')
  })
  it('attendee one minute before the cutoff: full', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-14T19:29') })).toBe('full')
  })
  it('attendee exactly at the cutoff: none — the boundary fails closed', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: cutoff })).toBe('none')
  })
  it('attendee past the cutoff: none', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 24, now: istLocalToUtc('2026-08-15T10:00') })).toBe('none')
  })
  it('cutoff 0: refundable until the start instant', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 0, now: istLocalToUtc('2026-08-15T19:29') })).toBe('full')
    expect(refundDecision({ initiator: 'attendee', startsAt, cutoffHours: 0, now: istLocalToUtc('2026-08-15T19:30') })).toBe('none')
  })
  it('an unreadable start time fails closed for the attendee', () => {
    expect(refundDecision({ initiator: 'attendee', startsAt: 'nonsense', cutoffHours: 24, now: cutoff })).toBe('none')
  })
})

describe('refundPolicySentence', () => {
  it('names the window', () => {
    expect(refundPolicySentence(24)).toBe('Free cancellation until 24 h before start.')
  })
  it('cutoff 0 reads as until-start', () => {
    expect(refundPolicySentence(0)).toBe('Free cancellation until the event starts.')
  })
})

describe('cancelConsequence', () => {
  const paid = { totalPaise: 100_000, startsAt, cutoffHours: 24 }
  it('is silent for free bookings', () => {
    expect(cancelConsequence({ initiator: 'attendee', totalPaise: 0, startsAt, cutoffHours: 24 })).toBeNull()
  })
  it('tells the attendee the amount inside the window', () => {
    expect(cancelConsequence({ initiator: 'attendee', ...paid, now: istLocalToUtc('2026-08-13T10:00') })).toBe(
      "You'll be refunded ₹1,000.00.",
    )
  })
  it('tells the attendee there is no refund outside it', () => {
    expect(cancelConsequence({ initiator: 'attendee', ...paid, now: istLocalToUtc('2026-08-15T10:00') })).toBe(
      'Past the refund window — no refund.',
    )
  })
  it('tells the host removal always refunds', () => {
    expect(cancelConsequence({ initiator: 'host', ...paid, now: istLocalToUtc('2026-08-15T10:00') })).toBe(
      'Removing refunds ₹1,000.00 in full.',
    )
  })
})
```

**Before writing the amount assertions, check `formatPaise(100_000)`'s exact output in `lib/money.ts`/its test** (`₹1,000.00` vs `₹1,000`) and match it — the sentence builders delegate to it, so the test must assert whatever it truly prints.

`lib/payments/rpc-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapPaymentRpcError } from '@/lib/payments/rpc-errors'

function rpcError(code: string, message = 'raw database sentence'): PostgrestError {
  return { code, message, details: '', hint: '', name: 'PostgrestError' } as PostgrestError
}

describe('mapPaymentRpcError', () => {
  it.each([
    ['EH030', 'This event is free — book it without paying.'],
    ['EH031', 'This host approves guests before booking, which is not available yet.'],
    ['EH032', 'This event has already started.'],
    ['EH033', 'You have already booked this event. Cancel that booking first to change it.'],
  ])('%s becomes a sentence', (code, sentence) => {
    expect(mapPaymentRpcError(rpcError(code))).toBe(sentence)
  })

  it('passes reserve_tickets refusals through unchanged', () => {
    expect(mapPaymentRpcError(rpcError('23514', 'only 3 seats remain'))).toBe('only 3 seats remain')
  })
})
```

- [ ] **Step 2: Run them, confirm they fail on the missing modules**

Run: `npx vitest run lib/payments/refund-policy.test.ts lib/payments/rpc-errors.test.ts`
Expected: FAIL — cannot resolve the imports.

- [ ] **Step 3: Write the modules**

`lib/payments/refund-policy.ts` (no `'server-only'` — Task 11/12's pages and any future client code may say these sentences too, the `lib/checkin/sentences.ts` reasoning):

```ts
import { formatPaise } from '@/lib/money'

/**
 * The whole cutoff rule, in one tested place.
 *
 * The arithmetic is zone-free on purpose: starts_at is an absolute instant and
 * the cutoff is N hours before it, which no timezone can change. IST enters
 * only where humans do — the tests speak IST wall-clock via istLocalToUtc, and
 * the UI formats instants with lib/events/datetime.ts. India has no DST, so
 * there is no wall-clock trap hiding in the subtraction.
 */

export type CancelInitiator = 'attendee' | 'host'
export type RefundDecision = 'full' | 'none'

export function refundCutoffAt(startsAt: string, cutoffHours: number): Date {
  return new Date(new Date(startsAt).getTime() - cutoffHours * 60 * 60 * 1000)
}

export function refundDecision(input: {
  initiator: CancelInitiator
  startsAt: string
  cutoffHours: number
  now?: Date
}): RefundDecision {
  // The host is choosing to give the seat back; the clock never applies.
  if (input.initiator === 'host') return 'full'

  const cutoff = refundCutoffAt(input.startsAt, input.cutoffHours).getTime()
  const now = (input.now ?? new Date()).getTime()

  // Fail closed, the hasStarted precedent: NaN comparisons are all false, so
  // without this branch an unreadable start time would decide whichever way
  // the expression happened to be written. Money errs toward not moving.
  if (Number.isNaN(cutoff) || Number.isNaN(now)) return 'none'

  return now < cutoff ? 'full' : 'none'
}

/** The one-sentence policy the public event page and the booking page carry. */
export function refundPolicySentence(cutoffHours: number): string {
  if (cutoffHours === 0) return 'Free cancellation until the event starts.'
  return `Free cancellation until ${cutoffHours} h before start.`
}

/** What the cancel tap will do to the money, stated before the tap. Null when no money moved. */
export function cancelConsequence(input: {
  initiator: CancelInitiator
  totalPaise: number
  startsAt: string
  cutoffHours: number
  now?: Date
}): string | null {
  if (input.totalPaise === 0) return null
  if (input.initiator === 'host') return `Removing refunds ${formatPaise(input.totalPaise)} in full.`
  return refundDecision(input) === 'full'
    ? `You'll be refunded ${formatPaise(input.totalPaise)}.`
    : 'Past the refund window — no refund.'
}
```

`lib/payments/rpc-errors.ts` (the `lib/checkin/rpc-errors.ts` shape exactly):

```ts
import type { PostgrestError } from '@supabase/supabase-js'

/** The ticket type is free; the paid path does not apply. */
const FREE = 'EH030'
/** The event requires host approval; that flow is Phase 5. */
const NEEDS_APPROVAL = 'EH031'
/** The event has already started. */
const STARTED = 'EH032'
/** This attendee already has an active booking on this event. */
const ALREADY_BOOKED = 'EH033'

/**
 * begin_paid_booking refusals as sentences an attendee can act on. Anything
 * unmapped passes through: reserve_tickets' messages are already human-written.
 */
export function mapPaymentRpcError(error: PostgrestError): string {
  if (error.code === FREE) return 'This event is free — book it without paying.'
  if (error.code === NEEDS_APPROVAL) {
    return 'This host approves guests before booking, which is not available yet.'
  }
  if (error.code === STARTED) return 'This event has already started.'
  if (error.code === ALREADY_BOOKED) {
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
  return error.message
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `npx vitest run lib/payments/refund-policy.test.ts lib/payments/rpc-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/payments/refund-policy.ts lib/payments/rpc-errors.ts lib/payments/refund-policy.test.ts lib/payments/rpc-errors.test.ts
git commit -m "feat: the refund policy and payment error sentences, pure"
```

---

### Task 4: The provider seam and the Razorpay adapter

**Files:**
- Create: `lib/payments/provider.ts`
- Create: `lib/payments/razorpay.ts`
- Test: `lib/payments/razorpay.test.ts`

**Interfaces:**
- Consumes: `serverEnv()` from `lib/env.ts` (lazy, cached, throws in the browser).
- Produces (the service and the webhook route import these exact names):
  - `provider.ts`: `CreateOrderInput`, `ProviderOrder`, `ProviderPaymentStatus`, `ProviderPayment`, `CreatedRefund`, `PaymentProvider`
  - `razorpay.ts`: `class RazorpayConfigError extends Error`, `razorpayProvider(): PaymentProvider` (throws `RazorpayConfigError` when any of the three env vars is missing)

- [ ] **Step 1: Write `provider.ts`** (types first — the test file imports them)

```ts
/**
 * The payment-provider seam.
 *
 * The v1 doc designed this boundary for vendor change; Phase 3 uses it as the
 * mocked seam in every integration test — the service and the webhook route
 * speak only these types, and lib/payments/razorpay.ts is the one file that
 * knows what is on the wire. Amounts are integer paise throughout
 * (lib/money.ts's rule); statuses reuse Razorpay's five words because our
 * payment_status enum was built from them in Phase 0.
 */

export interface CreateOrderInput {
  amountPaise: number
  /** ≤ 40 chars, unique per order — the 8-char booking reference qualifies. */
  receipt: string
  notes?: Record<string, string>
}

export interface ProviderOrder {
  orderId: string
}

export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'

export interface ProviderPayment {
  paymentId: string
  orderId: string
  amountPaise: number
  status: ProviderPaymentStatus
  method: string | null
  errorCode: string | null
  errorDescription: string | null
}

export interface CreatedRefund {
  refundId: string
  status: 'pending' | 'processed' | 'failed'
}

export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<ProviderOrder>
  listOrderPayments(orderId: string): Promise<ProviderPayment[]>
  /** A FULL refund of the payment; Phase 3 has no partial refunds. */
  createRefund(providerPaymentId: string, input?: { notes?: Record<string, string> }): Promise<CreatedRefund>
  verifyWebhookSignature(rawBody: string, signature: string): boolean
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean
}
```

- [ ] **Step 2: Write the failing adapter tests**

`lib/payments/razorpay.test.ts`. Env handling is the delicate part: `serverEnv()` caches after its first parse and `clientEnv` parses at `lib/env.ts` import — so every scenario resets modules, stubs a full set of env vars, and imports fresh.

```ts
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { razorpayProvider as RazorpayProviderFn } from '@/lib/payments/razorpay'

const BASE_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3100',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  SEND_SMS_HOOK_SECRET: 'test-sms-secret',
  TICKET_SIGNING_SECRET: 't'.repeat(32),
}

const KEYS = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'checkout-secret',
  RAZORPAY_WEBHOOK_SECRET: 'webhook-secret',
}

async function loadProvider(extra: Record<string, string>) {
  vi.resetModules()
  vi.unstubAllEnvs()
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...extra })) vi.stubEnv(name, value)
  const mod = await import('@/lib/payments/razorpay')
  return mod as { razorpayProvider: typeof RazorpayProviderFn; RazorpayConfigError: typeof Error }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('configuration', () => {
  it('throws RazorpayConfigError when any of the three vars is missing', async () => {
    const { razorpayProvider, RazorpayConfigError } = await loadProvider({
      ...KEYS,
      RAZORPAY_WEBHOOK_SECRET: '',
    })
    expect(() => razorpayProvider()).toThrow(RazorpayConfigError)
  })
})

describe('signatures', () => {
  it('accepts the true webhook signature and rejects tampering', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const provider = razorpayProvider()
    const body = JSON.stringify({ event: 'payment.captured', payload: {} })
    const signature = createHmac('sha256', KEYS.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex')

    expect(provider.verifyWebhookSignature(body, signature)).toBe(true)
    expect(provider.verifyWebhookSignature(body + ' ', signature)).toBe(false) // tampered body
    const wrongSecret = createHmac('sha256', 'not-the-secret').update(body).digest('hex')
    expect(provider.verifyWebhookSignature(body, wrongSecret)).toBe(false)
    expect(provider.verifyWebhookSignature(body, 'too-short')).toBe(false) // length mismatch must not throw
  })

  it('verifies the checkout signature over order_id|payment_id with the key secret', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const provider = razorpayProvider()
    const signature = createHmac('sha256', KEYS.RAZORPAY_KEY_SECRET).update('order_1|pay_1').digest('hex')

    expect(provider.verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature })).toBe(true)
    expect(provider.verifyCheckoutSignature({ orderId: 'order_2', paymentId: 'pay_1', signature })).toBe(false)
  })
})

describe('REST calls', () => {
  it('creates an order with basic auth, INR, and the receipt', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const fetchMock = vi.fn(async () => Response.json({ id: 'order_test_1' }))
    vi.stubGlobal('fetch', fetchMock)

    const order = await razorpayProvider().createOrder({ amountPaise: 100_000, receipt: 'G09SPK0K' })

    expect(order).toEqual({ orderId: 'order_test_1' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.razorpay.com/v1/orders')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from('rzp_test_key:checkout-secret').toString('base64'),
    )
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 100_000,
      currency: 'INR',
      receipt: 'G09SPK0K',
      notes: {},
    })
  })

  it('lists an order\'s payments and normalises the entity', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({
        entity: 'collection',
        count: 1,
        items: [{
          id: 'pay_1', order_id: 'order_1', amount: 100_000, status: 'captured',
          method: 'upi', error_code: null, error_description: null,
        }],
      }),
    ))

    const payments = await razorpayProvider().listOrderPayments('order_1')

    expect(payments).toEqual([{
      paymentId: 'pay_1', orderId: 'order_1', amountPaise: 100_000, status: 'captured',
      method: 'upi', errorCode: null, errorDescription: null,
    }])
  })

  it('creates a FULL refund: no amount key, speed normal', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const fetchMock = vi.fn(async () => Response.json({ id: 'rfnd_1', status: 'pending' }))
    vi.stubGlobal('fetch', fetchMock)

    const refund = await razorpayProvider().createRefund('pay_1')

    expect(refund).toEqual({ refundId: 'rfnd_1', status: 'pending' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund')
    const body = JSON.parse(init.body as string)
    expect(body.speed).toBe('normal')
    expect('amount' in body).toBe(false)
  })

  it('surfaces a non-2xx answer as an error naming the endpoint and status', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { description: 'Authentication failed' } }), { status: 401 }),
    ))

    await expect(razorpayProvider().createOrder({ amountPaise: 100, receipt: 'X' })).rejects.toThrow(
      /POST \/orders answered 401/,
    )
  })
})
```

- [ ] **Step 3: Run them, confirm they fail on the missing module**

Run: `npx vitest run lib/payments/razorpay.test.ts`
Expected: FAIL — cannot resolve `@/lib/payments/razorpay`.

- [ ] **Step 4: Write the adapter**

`lib/payments/razorpay.ts`:

```ts
import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/env'
import type {
  CreateOrderInput,
  CreatedRefund,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderPaymentStatus,
} from '@/lib/payments/provider'

/**
 * The Razorpay adapter: plain fetch, HTTP basic auth, four endpoints, no SDK
 * (the qrcode runtime-weight lesson). Razorpay's signature scheme is its own —
 * HMAC-SHA256 hex over the raw body (webhook secret) or over
 * `order_id|payment_id` (key secret) — NOT standardwebhooks, which serves the
 * Supabase SMS hook and stays there.
 *
 * Verified against razorpay.com/docs on 2026-08-10; the contract table in
 * docs/plans/2026-08-10-phase-3-payments.md holds the citations.
 */

const BASE_URL = 'https://api.razorpay.com/v1'

export class RazorpayConfigError extends Error {
  constructor() {
    super(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET in .env.local.',
    )
    this.name = 'RazorpayConfigError'
  }
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

/** Constant-time comparison; a length mismatch answers false rather than throwing. */
function safeEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

const PAYMENT_STATUSES = new Set<ProviderPaymentStatus>([
  'created',
  'authorized',
  'captured',
  'refunded',
  'failed',
])

function toProviderPayment(item: unknown): ProviderPayment {
  const record = item as Record<string, unknown>
  const status = record.status as ProviderPaymentStatus
  if (
    typeof record.id !== 'string' ||
    typeof record.order_id !== 'string' ||
    typeof record.amount !== 'number' ||
    !PAYMENT_STATUSES.has(status)
  ) {
    throw new Error(`Razorpay returned a payment entity this adapter does not recognise: ${JSON.stringify(item).slice(0, 200)}`)
  }
  return {
    paymentId: record.id,
    orderId: record.order_id,
    amountPaise: record.amount,
    status,
    method: typeof record.method === 'string' ? record.method : null,
    errorCode: typeof record.error_code === 'string' ? record.error_code : null,
    errorDescription: typeof record.error_description === 'string' ? record.error_description : null,
  }
}

export function razorpayProvider(): PaymentProvider {
  const env = serverEnv()
  const keyId = env.RAZORPAY_KEY_ID
  const keySecret = env.RAZORPAY_KEY_SECRET
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET
  if (!keyId || !keySecret || !webhookSecret) throw new RazorpayConfigError()

  const authorization = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64')

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Razorpay ${method} ${path} answered ${response.status}: ${detail.slice(0, 500)}`)
    }
    return (await response.json()) as T
  }

  return {
    async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
      const order = await request<{ id: string }>('POST', '/orders', {
        amount: input.amountPaise,
        currency: 'INR',
        receipt: input.receipt,
        notes: input.notes ?? {},
      })
      return { orderId: order.id }
    },

    async listOrderPayments(orderId: string): Promise<ProviderPayment[]> {
      const collection = await request<{ items?: unknown[] }>('GET', `/orders/${orderId}/payments`)
      return (collection.items ?? []).map(toProviderPayment)
    },

    async createRefund(providerPaymentId, input = {}): Promise<CreatedRefund> {
      // No `amount` key on purpose: omitting it is Razorpay's full refund.
      // `speed` is explicit because the docs disagree about the default.
      const refund = await request<{ id: string; status: string }>(
        'POST',
        `/payments/${providerPaymentId}/refund`,
        { speed: 'normal', notes: input.notes ?? {} },
      )
      const status = refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending'
      return { refundId: refund.id, status }
    },

    verifyWebhookSignature(rawBody: string, signature: string): boolean {
      return safeEqual(hmacHex(webhookSecret, rawBody), signature)
    },

    verifyCheckoutSignature(input): boolean {
      return safeEqual(hmacHex(keySecret, `${input.orderId}|${input.paymentId}`), input.signature)
    },
  }
}
```

- [ ] **Step 5: Run the tests, confirm they pass**

Run: `npx vitest run lib/payments/razorpay.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/payments/provider.ts lib/payments/razorpay.ts lib/payments/razorpay.test.ts
git commit -m "feat: the PaymentProvider seam and the Razorpay fetch adapter"
```

---

### Task 5: `startPaidCheckout` — the third admin importer

**Files:**
- Create: `lib/payments/service.ts`
- Create: `tests/helpers/payments.ts`
- Modify: `eslint.config.mjs` (the fence), `lib/checkin/service.ts` (the stale "second — and last —" comment)
- Test: `lib/payments/start-paid-checkout.test.ts`

**Interfaces:**
- Consumes: `begin_paid_booking` + `cancel_booking` RPCs (Task 1), `razorpayProvider`/`RazorpayConfigError` (Task 4), `mapPaymentRpcError` (Task 3), `Caller` from `lib/bookings/caller.ts`, `createAdminClient`.
- Produces:
  - `type CheckoutStart = { ok: true; reference: string } | { ok: false; error: string }`
  - `startPaidCheckout(caller: Caller, ticketTypeId: string, quantity: number, attendeeName: string): Promise<CheckoutStart>`
  - `tests/helpers/payments.ts`: `fakeProvider(overrides?: Partial<PaymentProvider>): PaymentProvider` (all methods `vi.fn`; `createOrder` → `{orderId: 'order_test_1'}`, `createRefund` → `{refundId: 'rfnd_test_1', status: 'pending'}`, both verifiers → `true`, `listOrderPayments` → `[]`).

- [ ] **Step 1: Write the test helper**

`tests/helpers/payments.ts`:

```ts
import { vi } from 'vitest'
import type { PaymentProvider, ProviderPayment } from '@/lib/payments/provider'

/** A PaymentProvider of vi.fn()s with happy-path defaults; override per test. */
export function fakeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    createOrder: vi.fn(async () => ({ orderId: 'order_test_1' })),
    listOrderPayments: vi.fn(async (): Promise<ProviderPayment[]> => []),
    createRefund: vi.fn(async () => ({ refundId: 'rfnd_test_1', status: 'pending' as const })),
    verifyWebhookSignature: vi.fn(() => true),
    verifyCheckoutSignature: vi.fn(() => true),
    ...overrides,
  }
}
```

- [ ] **Step 2: Write the failing integration test**

`lib/payments/start-paid-checkout.test.ts`. The provider module is mocked; the database is real. Mint `Caller`s the way `lib/bookings/concurrency.test.ts` does (**read its `callerOf`/cast mechanism first and reuse it**).

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { fakeProvider } from '@/tests/helpers/payments'
import type { Caller } from '@/lib/bookings/caller'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider, RazorpayConfigError } = vi.mocked(await import('@/lib/payments/razorpay'))
const { startPaidCheckout } = await import('@/lib/payments/service')

const db = adminClient()
let paid: SeededEvent
const callerOf = (id: string) => ({ id }) as Caller // match concurrency.test.ts's mechanism

beforeAll(async () => {
  paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
})
afterAll(async () => {
  await cleanupEvent(db, paid)
})

describe('startPaidCheckout', () => {
  it('holds seats, creates the order, records the payments row', async () => {
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)

    const result = await startPaidCheckout(callerOf(paid.attendeeId), paid.ticketTypeId, 2, 'Asha')

    expect(result).toEqual({ ok: true, reference: expect.stringMatching(/^[0-9A-HJ-NP-TV-Z]{8}$/) })
    expect(provider.createOrder).toHaveBeenCalledWith({
      amountPaise: 100_000,
      receipt: (result as { reference: string }).reference,
      notes: { booking_reference: (result as { reference: string }).reference },
    })
    const { data: booking } = await db
      .from('bookings')
      .select('id, status, payments(provider_order_id, status, amount_paise)')
      .eq('reference', (result as { reference: string }).reference)
      .single()
    expect(booking!.status).toBe('awaiting_payment')
    expect(booking!.payments).toEqual([
      { provider_order_id: 'order_test_1', status: 'created', amount_paise: 100_000 },
    ])
    await db.rpc('cancel_booking', { p_booking_id: booking!.id, p_reason: 'test cleanup' })
  })

  it('cancels the hold when order creation fails, and says one sentence', async () => {
    razorpayProvider.mockReturnValue(
      fakeProvider({ createOrder: vi.fn(async () => { throw new Error('razorpay down') }) }),
    )

    const result = await startPaidCheckout(callerOf(paid.attendeeId), paid.ticketTypeId, 1, 'Asha')

    expect(result).toEqual({
      ok: false,
      error: 'Could not start the payment. Nothing was charged — please try again.',
    })
    const { data: bookings } = await db
      .from('bookings')
      .select('status')
      .eq('event_id', paid.eventId)
      .eq('attendee_id', paid.attendeeId)
      .order('created_at', { ascending: false })
      .limit(1)
    expect(bookings![0]!.status).toBe('cancelled') // the hold did not outlive the failure
  })

  it('fails loudly, before any write, when Razorpay is not configured', async () => {
    razorpayProvider.mockImplementation(() => {
      throw new RazorpayConfigError()
    })
    const before = await db.from('bookings').select('*', { count: 'exact', head: true }).eq('event_id', paid.eventId)

    const result = await startPaidCheckout(callerOf(paid.attendeeId), paid.ticketTypeId, 1, 'Asha')

    expect(result).toEqual({ ok: false, error: 'Payments are not set up on this server yet.' })
    const after = await db.from('bookings').select('*', { count: 'exact', head: true }).eq('event_id', paid.eventId)
    expect(after.count).toBe(before.count)
  })

  it('maps a free ticket type to the EH030 sentence', async () => {
    razorpayProvider.mockReturnValue(fakeProvider())
    const free = await seedEvent(db, { quantity: 5, pricePaise: 0, status: 'published' })
    try {
      const result = await startPaidCheckout(callerOf(free.attendeeId), free.ticketTypeId, 1, 'Asha')
      expect(result).toEqual({ ok: false, error: 'This event is free — book it without paying.' })
    } finally {
      await cleanupEvent(db, free)
    }
  })
})
```

- [ ] **Step 3: Run it, confirm it fails on the missing service**

Run: `npx vitest run lib/payments/start-paid-checkout.test.ts`
Expected: FAIL — cannot resolve `@/lib/payments/service`.

- [ ] **Step 4: Write the service (first slice)**

`lib/payments/service.ts`:

```ts
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Caller } from '@/lib/bookings/caller'
import type { PaymentProvider } from '@/lib/payments/provider'
import { razorpayProvider } from '@/lib/payments/razorpay'
import { mapPaymentRpcError } from '@/lib/payments/rpc-errors'

/**
 * The third — and last — file permitted to import lib/supabase/admin.ts,
 * beside lib/bookings/service.ts and lib/checkin/service.ts. The ESLint fence
 * in eslint.config.mjs names all three. RLS grants no client any write to
 * payments, refunds or provider_webhook_events; every authorisation decision
 * in this module is therefore the entire rule. Identity is a Caller
 * throughout — never an id read from a form.
 */

export type CheckoutStart = { ok: true; reference: string } | { ok: false; error: string }

const NOT_CONFIGURED = 'Payments are not set up on this server yet.'
const COULD_NOT_START = 'Could not start the payment. Nothing was charged — please try again.'

/**
 * The paid mirror of bookFreeTickets, stopping at the hold: guards + reserve
 * in begin_paid_booking, then a Razorpay order for exactly total_paise, then
 * the payments row that the webhook processor will complete. If the order or
 * the insert fails the hold is cancelled immediately — an attendee must never
 * sit out a 10-minute hold for a checkout that cannot happen.
 */
export async function startPaidCheckout(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
): Promise<CheckoutStart> {
  let provider: PaymentProvider
  try {
    provider = razorpayProvider()
  } catch (error) {
    // Loudly, per the spec: the sentence for the attendee, the cause for the log.
    console.error('[payments] startPaidCheckout refused: Razorpay env vars missing', error)
    return { ok: false, error: NOT_CONFIGURED }
  }

  const db = createAdminClient()

  const { data: booking, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: ticketTypeId,
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
  })

  if (error) return { ok: false, error: mapPaymentRpcError(error) }

  try {
    const order = await provider.createOrder({
      amountPaise: booking.total_paise,
      receipt: booking.reference,
      notes: { booking_reference: booking.reference },
    })
    const { error: insertError } = await db.from('payments').insert({
      booking_id: booking.id,
      provider: 'razorpay',
      provider_order_id: order.orderId,
      amount_paise: booking.total_paise,
      status: 'created',
    })
    if (insertError) throw new Error(`could not record the order: ${insertError.message}`)
  } catch (cause) {
    console.error('[payments] checkout could not start; cancelling the hold', cause)
    // Best effort: if this cancel itself fails, the 10-minute hold and the
    // sweep still return the seats. The attendee sees one sentence either way.
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'checkout could not start' })
    return { ok: false, error: COULD_NOT_START }
  }

  return { ok: true, reference: booking.reference }
}
```

- [ ] **Step 5: Extend the fence**

`eslint.config.mjs` — the fence block's `ignores` gains the new file and the message names all three:

```js
    ignores: ["lib/bookings/service.ts", "lib/checkin/service.ts", "lib/payments/service.ts", "lib/supabase/admin.ts"],
```

```js
          message:
            "Only lib/bookings/service.ts, lib/checkin/service.ts and lib/payments/service.ts may use the service role. Use @/lib/supabase/server, or add the write to one of those modules.",
```

`lib/checkin/service.ts:8-9`: the header sentence "The second — and last — file permitted to import lib/supabase/admin.ts" is no longer true. Replace that sentence with: "One of exactly three files permitted to import lib/supabase/admin.ts — with lib/bookings/service.ts and lib/payments/service.ts; the ESLint fence names all three."

- [ ] **Step 6: Watch the fence fail, then pass**

Temporarily add `import '@/lib/supabase/admin'` to any `app/` file, run `npm run lint`, and confirm the message (now naming three files) fires; remove it. Then: `npm run lint` clean.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run lib/payments/start-paid-checkout.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suite, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/payments/service.ts lib/payments/start-paid-checkout.test.ts tests/helpers/payments.ts eslint.config.mjs lib/checkin/service.ts
git commit -m "feat: startPaidCheckout holds seats and opens a Razorpay order"
```

---

### Task 6: The webhook processor

**Files:**
- Modify: `lib/payments/service.ts` (the processor slice)
- Modify: `tests/helpers/payments.ts` (`seedPaidBooking`, fixture builders)
- Test: `lib/payments/webhook-processor.test.ts`

**Interfaces:**
- Consumes: `confirm_booking`, `release_expired_holds` RPCs; the `payments`/`refunds`/`provider_webhook_events` tables; `razorpayProvider` (refund path only); `fakeProvider` (tests).
- Produces:
  - `type WebhookOutcome = 'processed' | 'duplicate'`
  - `processWebhookEvent(input: { providerEventId: string; eventType: string; payload: unknown }): Promise<WebhookOutcome>` — records the receipt first, dedups on `(provider, provider_event_id)`, dispatches, stamps `processed_at` or `error`, **throws** on processing failure (the route turns that into a 500 so Razorpay retries).
  - Module-internal (Tasks 8–9 reuse them): `applyPayment(db, payment: ProviderPayment, raw: Json)`, `ensureRefund(db, payment: { id; provider_payment_id; amount_paise }, reason: string)`, `settleRefund(db, refundId: string, providerPaymentId: string | null): Promise<boolean>`.
  - `tests/helpers/payments.ts` gains:
    - `seedPaidBooking(db, seed, opts?: { quantity?: number; attendeeId?: string }): Promise<{ booking: BookingRow; orderId: string }>` — `begin_paid_booking` + a `created` payments row with `provider_order_id: 'order_' + reference`.
    - `capturedEvent({ orderId, paymentId?, amountPaise, eventId? })`, `failedEvent({ orderId, paymentId?, errorCode?, errorDescription?, eventId? })`, `refundEvent(kind: 'processed' | 'failed', { refundId, paymentId, amountPaise, eventId? })` — full Razorpay envelopes (`{entity:'event', account_id:'acc_test', event, contains, created_at, payload:{payment:{entity:{…}}}}`; refunds under `payload.refund.entity`), each with a fresh `evt_…` id by default.

- [ ] **Step 1: Extend the test helpers**

Append to `tests/helpers/payments.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import type { SeededEvent } from '@/tests/helpers/db'

type Db = SupabaseClient<Database>
type BookingRow = Database['public']['Tables']['bookings']['Row']

let eventCounter = 0
function nextEventId(): string {
  eventCounter += 1
  return `evt_test_${Date.now()}_${eventCounter}`
}

/** A paid booking stopped at the hold, with its payments row — the state startPaidCheckout leaves. */
export async function seedPaidBooking(
  db: Db,
  seed: SeededEvent,
  opts: { quantity?: number; attendeeId?: string } = {},
): Promise<{ booking: BookingRow; orderId: string }> {
  const { data: booking, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: opts.attendeeId ?? seed.attendeeId,
    p_quantity: opts.quantity ?? 2,
    p_attendee_name: 'Asha',
  })
  if (error) throw new Error(`seedPaidBooking: ${error.message}`)
  const orderId = `order_${booking.reference}`
  const { error: insertError } = await db.from('payments').insert({
    booking_id: booking.id,
    provider: 'razorpay',
    provider_order_id: orderId,
    amount_paise: booking.total_paise,
    status: 'created',
  })
  if (insertError) throw new Error(`seedPaidBooking payments row: ${insertError.message}`)
  return { booking, orderId }
}

export function capturedEvent(input: { orderId: string; paymentId?: string; amountPaise: number; eventId?: string }) {
  return {
    eventId: input.eventId ?? nextEventId(),
    eventType: 'payment.captured',
    payload: {
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment.captured',
      contains: ['payment'],
      created_at: 1_770_000_000,
      payload: {
        payment: {
          entity: {
            id: input.paymentId ?? 'pay_test_1',
            order_id: input.orderId,
            amount: input.amountPaise,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
            error_code: null,
            error_description: null,
          },
        },
      },
    },
  }
}

export function failedEvent(input: {
  orderId: string
  paymentId?: string
  errorCode?: string
  errorDescription?: string
  eventId?: string
}) {
  return {
    eventId: input.eventId ?? nextEventId(),
    eventType: 'payment.failed',
    payload: {
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment.failed',
      contains: ['payment'],
      created_at: 1_770_000_000,
      payload: {
        payment: {
          entity: {
            id: input.paymentId ?? 'pay_test_failed_1',
            order_id: input.orderId,
            amount: 0,
            currency: 'INR',
            status: 'failed',
            method: 'upi',
            error_code: input.errorCode ?? 'BAD_REQUEST_ERROR',
            error_description: input.errorDescription ?? 'Payment failed',
          },
        },
      },
    },
  }
}

export function refundEvent(
  kind: 'processed' | 'failed',
  input: { refundId: string; paymentId: string; amountPaise: number; eventId?: string },
) {
  return {
    eventId: input.eventId ?? nextEventId(),
    eventType: `refund.${kind}`,
    payload: {
      entity: 'event',
      account_id: 'acc_test',
      event: `refund.${kind}`,
      contains: ['refund'],
      created_at: 1_770_000_000,
      payload: {
        refund: {
          entity: {
            id: input.refundId,
            payment_id: input.paymentId,
            amount: input.amountPaise,
            currency: 'INR',
            status: kind === 'processed' ? 'processed' : 'failed',
          },
        },
      },
    },
  }
}
```

- [ ] **Step 2: Write the failing processor tests**

`lib/payments/webhook-processor.test.ts` (mocked provider module, real DB; one seeded event, one fresh attendee per active booking via `createTestUser`):

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { capturedEvent, failedEvent, fakeProvider, refundEvent, seedPaidBooking } from '@/tests/helpers/payments'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider } = vi.mocked(await import('@/lib/payments/razorpay'))
const { processWebhookEvent } = await import('@/lib/payments/service')

const db = adminClient()
let paid: SeededEvent

beforeAll(async () => {
  paid = await seedEvent(db, { quantity: 50, pricePaise: 50_000, status: 'published' })
})
afterAll(async () => {
  await cleanupEvent(db, paid)
})
beforeEach(() => {
  razorpayProvider.mockReturnValue(fakeProvider())
})

async function freshPaidBooking(quantity = 2) {
  const buyer = await createTestUser(db)
  return seedPaidBooking(db, paid, { quantity, attendeeId: buyer.userId })
}

async function apply(fixture: { eventId: string; eventType: string; payload: unknown }) {
  return processWebhookEvent({ providerEventId: fixture.eventId, eventType: fixture.eventType, payload: fixture.payload })
}

describe('payment.captured', () => {
  it('records the capture and confirms: same tickets as the free path', async () => {
    const { booking, orderId } = await freshPaidBooking(2)

    const outcome = await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    expect(outcome).toBe('processed')
    const { data: after } = await db.from('bookings').select('status, payments(status, provider_payment_id)').eq('id', booking.id).single()
    expect(after!.status).toBe('confirmed')
    expect(after!.payments[0]).toMatchObject({ status: 'captured', provider_payment_id: 'pay_test_1' })
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(2)
  })

  it('the same event id twice: one duplicate, one set of tickets', async () => {
    const { booking, orderId } = await freshPaidBooking(2)
    const fixture = capturedEvent({ orderId, amountPaise: booking.total_paise })

    expect(await apply(fixture)).toBe('processed')
    expect(await apply(fixture)).toBe('duplicate')
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(2)
  })

  it('the same capture under a NEW event id (redelivery): still one set of tickets', async () => {
    const { booking, orderId } = await freshPaidBooking(2)

    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))
    const again = await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    expect(again).toBe('processed') // fresh receipt, no-op application
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(2)
  })

  it('capture after the hold expired: auto-refund, nobody admitted', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)

    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    const { data: after } = await db
      .from('bookings')
      .select('status, payments(id, status, refunds(status, amount_paise, provider_refund_id))')
      .eq('id', booking.id)
      .single()
    expect(after!.status).toBe('expired')
    expect(provider.createRefund).toHaveBeenCalledTimes(1)
    expect(after!.payments[0]!.refunds).toEqual([
      { status: 'pending', amount_paise: booking.total_paise, provider_refund_id: 'rfnd_test_1' },
    ])
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(0)
  })

  it('capture after a cancel: auto-refund, booking stays cancelled', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'changed my mind' })

    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
    expect(after!.status).toBe('cancelled')
    const { data: refunds } = await db.from('refunds').select('status').eq('payment_id', (await paymentIdFor(booking.id))!)
    expect(refunds).toHaveLength(1)
  })

  it('an amount mismatch records, stamps, and admits nobody', async () => {
    const { booking, orderId } = await freshPaidBooking(2)

    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise - 1 }))

    const { data: after } = await db
      .from('bookings')
      .select('status, payments(status, error_code, error_description)')
      .eq('id', booking.id)
      .single()
    expect(after!.status).toBe('awaiting_payment') // untouched; the sweep and a human decide
    expect(after!.payments[0]).toMatchObject({ status: 'captured', error_code: 'amount_mismatch' })
    expect(after!.payments[0]!.error_description).toMatch(/captured 99999 paise against a booking of 100000/)
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(0)
  })
})

describe('payment.failed', () => {
  it('records the failure on the order\'s row', async () => {
    const { booking, orderId } = await freshPaidBooking(1)

    await apply(failedEvent({ orderId, errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'UPI timed out' }))

    const { data: payment } = await db.from('payments').select('status, error_code, error_description').eq('booking_id', booking.id).single()
    expect(payment).toEqual({ status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'UPI timed out' })
  })

  it('a failed arriving after the capture does not regress the row', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    await apply(failedEvent({ orderId, paymentId: 'pay_test_stale' }))

    const { data: payment } = await db.from('payments').select('status, provider_payment_id').eq('booking_id', booking.id).single()
    expect(payment).toEqual({ status: 'captured', provider_payment_id: 'pay_test_1' })
    const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
    expect(after!.status).toBe('confirmed')
  })
})

describe('refund events', () => {
  it('refund.processed settles the row and marks the payment refunded', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise })) // creates the pending refund rfnd_test_1

    await apply(refundEvent('processed', { refundId: 'rfnd_test_1', paymentId: 'pay_test_1', amountPaise: booking.total_paise }))

    const paymentId = await paymentIdFor(booking.id)
    const { data: refund } = await db.from('refunds').select('status').eq('payment_id', paymentId!).single()
    expect(refund!.status).toBe('processed')
    const { data: payment } = await db.from('payments').select('status').eq('id', paymentId!).single()
    expect(payment!.status).toBe('refunded')
  })

  it('refund.failed marks the row failed so a human looks', async () => {
    const { booking, orderId } = await freshPaidBooking(1)
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
    await apply(capturedEvent({ orderId, amountPaise: booking.total_paise }))

    await apply(refundEvent('failed', { refundId: 'rfnd_test_1', paymentId: 'pay_test_1', amountPaise: booking.total_paise }))

    const paymentId = await paymentIdFor(booking.id)
    const { data: refund } = await db.from('refunds').select('status').eq('payment_id', paymentId!).single()
    expect(refund!.status).toBe('failed')
  })
})

describe('bookkeeping', () => {
  it('an unknown event type is recorded and marked processed', async () => {
    const outcome = await processWebhookEvent({
      providerEventId: `evt_unknown_${Date.now()}`,
      eventType: 'invoice.paid',
      payload: { event: 'invoice.paid' },
    })
    expect(outcome).toBe('processed')
  })

  it('a processing failure stamps the receipt and throws', async () => {
    const fixture = capturedEvent({ orderId: 'order_never_created', amountPaise: 1 })

    await expect(apply(fixture)).rejects.toThrow(/no payments row/)
    const { data: receipt } = await db
      .from('provider_webhook_events')
      .select('processed_at, error')
      .eq('provider_event_id', fixture.eventId)
      .single()
    expect(receipt!.processed_at).toBeNull()
    expect(receipt!.error).toMatch(/no payments row/)
  })
})

async function paymentIdFor(bookingId: string): Promise<string | null> {
  const { data } = await db.from('payments').select('id').eq('booking_id', bookingId).maybeSingle()
  return data?.id ?? null
}
```

- [ ] **Step 3: Run it, confirm it fails on the missing export**

Run: `npx vitest run lib/payments/webhook-processor.test.ts`
Expected: FAIL — `processWebhookEvent` is not exported.

- [ ] **Step 4: Write the processor slice**

Append to `lib/payments/service.ts` (below `startPaidCheckout`; `Json` comes from `@/lib/supabase/types`, `ProviderPayment`/`ProviderPaymentStatus` from the seam):

```ts
export type WebhookOutcome = 'processed' | 'duplicate'

type AdminDb = ReturnType<typeof createAdminClient>

/**
 * One processor, two feeders (this entry for the webhook route,
 * reconcileBooking for page loads and the sweep). The receipt goes down FIRST,
 * before any business logic — (provider, provider_event_id) is the dedup — and
 * every write below it is idempotent, so the same truth arriving twice, from
 * either feeder, lands once.
 *
 * Throws on processing failure ON PURPOSE, after stamping the receipt's error:
 * the route answers 500, Razorpay redelivers, and a redelivery is exactly what
 * a half-processed event needs.
 */
export async function processWebhookEvent(input: {
  providerEventId: string
  eventType: string
  payload: unknown
}): Promise<WebhookOutcome> {
  const db = createAdminClient()

  const { data: receipt, error: receiptError } = await db
    .from('provider_webhook_events')
    .upsert(
      {
        provider: 'razorpay',
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        payload: input.payload as Json,
      },
      { onConflict: 'provider,provider_event_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle()

  if (receiptError) throw new Error(`could not record the webhook receipt: ${receiptError.message}`)
  if (!receipt) return 'duplicate'

  try {
    switch (input.eventType) {
      case 'payment.captured':
      case 'payment.failed': {
        const entity = paymentEntity(input.payload)
        await applyPayment(db, entity, entity as unknown as Json)
        break
      }
      case 'refund.processed':
        await applyRefundEvent(db, refundEntity(input.payload), 'processed')
        break
      case 'refund.failed':
        await applyRefundEvent(db, refundEntity(input.payload), 'failed')
        break
      default:
        // We only subscribe to the four above; anything else is recorded in
        // the receipts table (raw payloads live forever) and needs no writes.
        break
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await db.from('provider_webhook_events').update({ error: message }).eq('id', receipt.id)
    throw cause
  }

  await db.from('provider_webhook_events').update({ processed_at: new Date().toISOString() }).eq('id', receipt.id)
  return 'processed'
}

/** payload.payment.entity, shape-checked — a verified sender can still drift its schema. */
function paymentEntity(payload: unknown): ProviderPayment {
  const entity = (payload as { payload?: { payment?: { entity?: Record<string, unknown> } } })?.payload?.payment?.entity
  const status = entity?.status as ProviderPaymentStatus
  if (
    !entity ||
    typeof entity.id !== 'string' ||
    typeof entity.order_id !== 'string' ||
    typeof entity.amount !== 'number' ||
    typeof status !== 'string'
  ) {
    throw new Error('malformed payment webhook payload')
  }
  return {
    paymentId: entity.id,
    orderId: entity.order_id,
    amountPaise: entity.amount,
    status,
    method: typeof entity.method === 'string' ? entity.method : null,
    errorCode: typeof entity.error_code === 'string' ? entity.error_code : null,
    errorDescription: typeof entity.error_description === 'string' ? entity.error_description : null,
  }
}

interface RefundEntityShape {
  refundId: string
  providerPaymentId: string
  amountPaise: number
}

function refundEntity(payload: unknown): RefundEntityShape {
  const entity = (payload as { payload?: { refund?: { entity?: Record<string, unknown> } } })?.payload?.refund?.entity
  if (!entity || typeof entity.id !== 'string' || typeof entity.payment_id !== 'string' || typeof entity.amount !== 'number') {
    throw new Error('malformed refund webhook payload')
  }
  return { refundId: entity.id, providerPaymentId: entity.payment_id, amountPaise: entity.amount }
}

/**
 * The single write path for a payment fact, whichever feeder carried it.
 * One payments row per order, last write wins — except that 'refunded' and
 * 'captured' never regress to 'failed' (Razorpay allows failed attempts and a
 * success against one order, delivered in any order).
 */
async function applyPayment(db: AdminDb, p: ProviderPayment, raw: Json): Promise<void> {
  if (p.status !== 'captured' && p.status !== 'failed') return // created/authorized: not terminal, nothing to record

  const { data: payment, error } = await db
    .from('payments')
    .select('id, booking_id, status, provider_payment_id, amount_paise')
    .eq('provider', 'razorpay')
    .eq('provider_order_id', p.orderId)
    .maybeSingle()
  if (error) throw new Error(`could not read the payments row: ${error.message}`)
  if (!payment) throw new Error(`no payments row for order ${p.orderId}`)

  if (p.status === 'failed') {
    if (payment.status === 'captured' || payment.status === 'refunded') return // stale news
    const { error: failError } = await db
      .from('payments')
      .update({
        provider_payment_id: p.paymentId,
        status: 'failed',
        method: p.method,
        error_code: p.errorCode,
        error_description: p.errorDescription,
        raw_payload: raw,
      })
      .eq('id', payment.id)
    if (failError) throw new Error(`could not record the failure: ${failError.message}`)
    return
  }

  // captured —
  const { data: booking, error: bookingError } = await db
    .from('bookings')
    .select('id, status, ticket_type_id, total_paise')
    .eq('id', payment.booking_id)
    .single()
  if (bookingError) throw new Error(`could not read the booking: ${bookingError.message}`)

  const { error: captureError } = await db
    .from('payments')
    .update({
      provider_payment_id: p.paymentId,
      // A capture never un-refunds: if refund.processed already landed, the
      // row keeps saying so and this write only fills the capture details.
      status: payment.status === 'refunded' ? 'refunded' : 'captured',
      method: p.method,
      error_code: null,
      error_description: null,
      raw_payload: raw,
    })
    .eq('id', payment.id)
  if (captureError) throw new Error(`could not record the capture: ${captureError.message}`)

  // The order amount is server-set, so a mismatch should be unreachable — the
  // EH021 "believed unreachable, one predicate" precedent. Record, stamp for
  // the sweep, admit nobody, answer 200 (a retry cannot fix a wrong amount).
  if (p.amountPaise !== booking.total_paise) {
    await db
      .from('payments')
      .update({
        error_code: 'amount_mismatch',
        error_description: `captured ${p.amountPaise} paise against a booking of ${booking.total_paise}`,
      })
      .eq('id', payment.id)
    console.error(`[payments] amount mismatch on order ${p.orderId}: ${p.amountPaise} vs ${booking.total_paise}`)
    return
  }

  // Force the expiry decision by the clock before looking at status — the
  // same inline call reserve_tickets makes. Without it, "expired" depends on
  // whether the sweeper happened to run.
  const { error: releaseError } = await db.rpc('release_expired_holds', { p_ticket_type_id: booking.ticket_type_id })
  if (releaseError) throw new Error(`could not settle expiries: ${releaseError.message}`)

  const { data: fresh, error: freshError } = await db.from('bookings').select('status').eq('id', booking.id).single()
  if (freshError) throw new Error(`could not re-read the booking: ${freshError.message}`)

  if (fresh.status === 'awaiting_payment') {
    const { error: confirmError } = await db.rpc('confirm_booking', { p_booking_id: booking.id })
    if (confirmError) throw new Error(`could not confirm booking ${booking.id}: ${confirmError.message}`)
    return
  }
  if (fresh.status === 'confirmed') return // replay of a done deal

  // expired or cancelled: money never sits against a seat that does not
  // exist. The booking's ending stands; the refund makes the dawdle harmless.
  await ensureRefund(
    db,
    { id: payment.id, provider_payment_id: p.paymentId, amount_paise: payment.amount_paise },
    'capture after the booking ended',
  )
}

/** At most one refund per payment; the unique provider_refund_id backstops this check. */
async function ensureRefund(
  db: AdminDb,
  payment: { id: string; provider_payment_id: string | null; amount_paise: number },
  reason: string,
): Promise<void> {
  const { data: existing, error: readError } = await db
    .from('refunds')
    .select('id')
    .eq('payment_id', payment.id)
    .maybeSingle()
  if (readError) throw new Error(`could not read refunds: ${readError.message}`)
  if (existing) return

  const { data: row, error: insertError } = await db
    .from('refunds')
    .insert({ payment_id: payment.id, amount_paise: payment.amount_paise, status: 'pending', reason })
    .select('id')
    .single()
  if (insertError) throw new Error(`could not create the refund row: ${insertError.message}`)

  await settleRefund(db, row.id, payment.provider_payment_id)
}

/**
 * The provider half of a refund, separated so the sweep can retry it. Never
 * throws: the row already says a refund is owed; a failed call leaves it
 * pending with no provider_refund_id, which is exactly what the sweep looks
 * for. Returns whether the provider call landed.
 */
async function settleRefund(db: AdminDb, refundId: string, providerPaymentId: string | null): Promise<boolean> {
  if (!providerPaymentId) return false
  try {
    const provider = razorpayProvider()
    const created = await provider.createRefund(providerPaymentId)
    const { error } = await db
      .from('refunds')
      .update({ provider_refund_id: created.refundId, status: created.status })
      .eq('id', refundId)
    if (error) throw new Error(error.message)
    return true
  } catch (cause) {
    console.error(`[payments] refund ${refundId} not sent yet; the sweep retries`, cause)
    return false
  }
}

/**
 * refund.processed / refund.failed move the row; the booking's ending was
 * decided at cancel time and does not change here. A refund with no row was
 * made outside the app (the Razorpay dashboard); it is recorded against the
 * payment so the books stay honest.
 */
async function applyRefundEvent(db: AdminDb, r: RefundEntityShape, status: 'processed' | 'failed'): Promise<void> {
  const { data: row, error } = await db.from('refunds').select('id').eq('provider_refund_id', r.refundId).maybeSingle()
  if (error) throw new Error(`could not read refunds: ${error.message}`)

  if (row) {
    const { error: updateError } = await db.from('refunds').update({ status }).eq('id', row.id)
    if (updateError) throw new Error(`could not move the refund: ${updateError.message}`)
  } else {
    const { data: payment, error: paymentError } = await db
      .from('payments')
      .select('id')
      .eq('provider_payment_id', r.providerPaymentId)
      .maybeSingle()
    if (paymentError) throw new Error(`could not read payments: ${paymentError.message}`)
    if (!payment) throw new Error(`refund ${r.refundId} names a payment this app never saw`)
    const { error: insertError } = await db.from('refunds').insert({
      payment_id: payment.id,
      provider_refund_id: r.refundId,
      amount_paise: r.amountPaise,
      status,
      reason: 'created outside the app',
    })
    if (insertError) throw new Error(`could not record the outside refund: ${insertError.message}`)
  }

  if (status === 'processed') {
    const { error: flipError } = await db
      .from('payments')
      .update({ status: 'refunded' })
      .eq('provider_payment_id', r.providerPaymentId)
    if (flipError) throw new Error(`could not mark the payment refunded: ${flipError.message}`)
  }
}
```

- [ ] **Step 5: Run the tests, confirm they pass**

Run: `npx vitest run lib/payments/webhook-processor.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/payments/service.ts lib/payments/webhook-processor.test.ts tests/helpers/payments.ts
git commit -m "feat: the webhook processor — capture confirms, replays no-op, orphans refund"
```

---

### Task 7: The webhook route

**Files:**
- Create: `app/api/webhooks/razorpay/route.ts`
- Test: `app/api/webhooks/razorpay/route.test.ts`

**Interfaces:**
- Consumes: `razorpayProvider().verifyWebhookSignature` (Task 4), `processWebhookEvent` (Task 6).
- Produces: `POST /api/webhooks/razorpay` — 401 bad signature, 400 missing event id / unparseable body, 500 not-configured or processing failure (Razorpay retries on non-2xx), 200 otherwise (including duplicates).

- [ ] **Step 1: Write the failing route tests**

`app/api/webhooks/razorpay/route.test.ts` (action-test style — both modules mocked, `Request` in, `Response` out; model the mock bootstrap on `app/bookings/actions.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeProvider } from '@/tests/helpers/payments'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})
vi.mock('@/lib/payments/service', () => ({ processWebhookEvent: vi.fn() }))

const { razorpayProvider, RazorpayConfigError } = vi.mocked(await import('@/lib/payments/razorpay'))
const { processWebhookEvent } = vi.mocked(await import('@/lib/payments/service'))
const { POST } = await import('@/app/api/webhooks/razorpay/route')

const BODY = JSON.stringify({ event: 'payment.captured', payload: {} })

function post(input: { body?: string; signature?: string | null; eventId?: string | null } = {}): Promise<Response> {
  const headers = new Headers()
  if (input.signature !== null) headers.set('x-razorpay-signature', input.signature ?? 'sig')
  if (input.eventId !== null) headers.set('x-razorpay-event-id', input.eventId ?? 'evt_1')
  return POST(new Request('http://localhost:3100/api/webhooks/razorpay', { method: 'POST', body: input.body ?? BODY, headers }))
}

beforeEach(() => {
  vi.clearAllMocks()
  razorpayProvider.mockReturnValue(fakeProvider())
  processWebhookEvent.mockResolvedValue('processed')
})

describe('POST /api/webhooks/razorpay', () => {
  it('verifies the signature over the RAW body and processes', async () => {
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)

    const response = await post()

    expect(response.status).toBe(200)
    expect(provider.verifyWebhookSignature).toHaveBeenCalledWith(BODY, 'sig')
    expect(processWebhookEvent).toHaveBeenCalledWith({
      providerEventId: 'evt_1',
      eventType: 'payment.captured',
      payload: JSON.parse(BODY),
    })
  })

  it('answers 401 to a bad signature and writes nothing', async () => {
    razorpayProvider.mockReturnValue(fakeProvider({ verifyWebhookSignature: vi.fn(() => false) }))

    const response = await post()

    expect(response.status).toBe(401)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 401 when the signature header is missing', async () => {
    const response = await post({ signature: null })
    expect(response.status).toBe(401)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 400 when the event id header is missing', async () => {
    const response = await post({ eventId: null })
    expect(response.status).toBe(400)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 400 to an unparseable body', async () => {
    const response = await post({ body: 'not json' })
    expect(response.status).toBe(400)
  })

  it('answers 200 to a duplicate without reprocessing side effects', async () => {
    processWebhookEvent.mockResolvedValue('duplicate')
    const response = await post()
    expect(response.status).toBe(200)
  })

  it('answers 500 when processing throws, so Razorpay redelivers', async () => {
    processWebhookEvent.mockRejectedValue(new Error('half-processed'))
    const response = await post()
    expect(response.status).toBe(500)
  })

  it('answers 500 when Razorpay is not configured', async () => {
    razorpayProvider.mockImplementation(() => {
      throw new RazorpayConfigError()
    })
    const response = await post()
    expect(response.status).toBe(500)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })
})
```

Note: the signature-verification tests here prove the route *calls* the verifier with the raw body; the verifier's own correctness was proven in Task 4 with real HMAC vectors.

- [ ] **Step 2: Run it, confirm it fails on the missing route**

Run: `npx vitest run app/api/webhooks/razorpay/route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Write the route**

`app/api/webhooks/razorpay/route.ts`:

```ts
import { razorpayProvider } from '@/lib/payments/razorpay'
import { processWebhookEvent } from '@/lib/payments/service'
import type { PaymentProvider } from '@/lib/payments/provider'

/**
 * Razorpay's webhook door. POST only; the raw body is read BEFORE any parse,
 * because the signature covers the exact bytes on the wire
 * (app/api/hooks/send-sms/route.ts is the house precedent).
 *
 * Status codes are the contract with Razorpay's redelivery: 2xx swallows the
 * event forever, anything else retries. So a duplicate is 200 (we have it), a
 * bad signature is 401 (not Razorpay's voice), and a processing failure is
 * 500 ON PURPOSE — a retry is exactly what a half-processed event needs.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()

  let provider: PaymentProvider
  try {
    provider = razorpayProvider()
  } catch (error) {
    // A webhook is arriving at a server with no webhook secret: config drift.
    console.error('[razorpay-webhook] refused: Razorpay env vars missing', error)
    return Response.json({ error: 'not configured' }, { status: 500 })
  }

  const signature = request.headers.get('x-razorpay-signature')
  if (!signature || !provider.verifyWebhookSignature(rawBody, signature)) {
    return Response.json({ error: 'invalid signature' }, { status: 401 })
  }

  const providerEventId = request.headers.get('x-razorpay-event-id')
  if (!providerEventId) {
    return Response.json({ error: 'missing event id' }, { status: 400 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'unparseable body' }, { status: 400 })
  }

  const event = (payload as { event?: unknown }).event
  const eventType = typeof event === 'string' ? event : ''

  try {
    await processWebhookEvent({ providerEventId, eventType, payload })
  } catch (error) {
    console.error('[razorpay-webhook] processing failed; Razorpay will retry', error)
    return Response.json({ error: 'processing failed' }, { status: 500 })
  }

  return Response.json({ received: true })
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `npx vitest run app/api/webhooks/razorpay/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add app/api/webhooks/razorpay
git commit -m "feat: the Razorpay webhook route — verify, dedup, dispatch, stamp"
```

---

### Task 8: Refunds on both cancel surfaces

**Files:**
- Modify: `lib/payments/service.ts` (`refundIfOwed`), `lib/bookings/service.ts` (typed initiator + the hand-off), `app/bookings/actions.ts`, `app/host/events/[id]/attendees/actions.ts` (initiators)
- Modify: existing tests that stub or assert `cancelBooking`'s third argument (`app/bookings/actions.test.ts`, `lib/bookings/service.test.ts`, and any attendee-action test — grep for `cancelBooking(` first)
- Test: `lib/payments/cancel-refunds.test.ts`

**Interfaces:**
- Consumes: `refundDecision`, `CancelInitiator` (Task 3); `ensureRefund` (Task 6); `cancel_booking` RPC.
- Produces:
  - `refundIfOwed(bookingId: string, initiator: CancelInitiator): Promise<void>` — never throws; called only after the seat is freed.
  - `cancelBooking(caller: Caller, bookingId: string, initiator: CancelInitiator): Promise<CancelResult>` — the `reason?` string parameter is replaced; the stored prose stays `'cancelled by attendee'` / `'cancelled by host'`.
  - Booking endings: attendee-inside-cutoff and host-any-time → `refunded`; attendee-outside-cutoff → `cancelled`; free/uncaptured → `cancelled` untouched by this module.

- [ ] **Step 1: Write the failing cancel-matrix test**

`lib/payments/cancel-refunds.test.ts` (mocked provider, real DB; each case seeds its own event so `starts_at` and the cutoff differ; a captured-and-confirmed paid booking is built by running the Task 6 fixtures through `processWebhookEvent`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { capturedEvent, fakeProvider, seedPaidBooking } from '@/tests/helpers/payments'
import type { Caller } from '@/lib/bookings/caller'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider } = vi.mocked(await import('@/lib/payments/razorpay'))
const { processWebhookEvent } = await import('@/lib/payments/service')
const { cancelBooking } = await import('@/lib/bookings/service')

const db = adminClient()
const callerOf = (id: string) => ({ id }) as Caller // match concurrency.test.ts's mechanism

beforeEach(() => {
  razorpayProvider.mockReturnValue(fakeProvider())
})

/** A paid, captured, confirmed booking on an event that starts `hoursOut` from now. */
async function confirmedPaidBooking(hoursOut: number, cutoffHours = 24) {
  const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
  await db
    .from('events')
    .update({
      starts_at: new Date(Date.now() + hoursOut * 3600_000).toISOString(),
      refund_cutoff_hours: cutoffHours,
    })
    .eq('id', seed.eventId)
  const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
  const fixture = capturedEvent({ orderId, amountPaise: booking.total_paise })
  await processWebhookEvent({ providerEventId: fixture.eventId, eventType: fixture.eventType, payload: fixture.payload })
  return { seed, booking }
}

async function endState(bookingId: string) {
  const { data } = await db
    .from('bookings')
    .select('status, payments(id, refunds(status, provider_refund_id, amount_paise))')
    .eq('id', bookingId)
    .single()
  return { status: data!.status, refunds: data!.payments[0]?.refunds ?? [] }
}

describe('the cancel matrix', () => {
  it('attendee inside the cutoff: refunded, one refund row, provider called once', async () => {
    const { seed, booking } = await confirmedPaidBooking(48, 24)
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)
    try {
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('refunded')
      expect(after.refunds).toEqual([
        { status: 'pending', provider_refund_id: 'rfnd_test_1', amount_paise: booking.total_paise },
      ])
      expect(provider.createRefund).toHaveBeenCalledTimes(1)
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('attendee past the cutoff: cancelled, seat freed, no money moves', async () => {
    const { seed, booking } = await confirmedPaidBooking(2, 24)
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)
    try {
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('cancelled')
      expect(after.refunds).toEqual([])
      expect(provider.createRefund).not.toHaveBeenCalled()
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('host removal past the cutoff: still a full refund', async () => {
    const { seed, booking } = await confirmedPaidBooking(2, 24)
    try {
      const result = await cancelBooking(callerOf(seed.hostProfileId), booking.id, 'host')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('refunded')
      expect(after.refunds).toHaveLength(1)
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('cancelling twice creates at most one refund', async () => {
    const { seed, booking } = await confirmedPaidBooking(48, 24)
    try {
      await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      const again = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(again).toEqual({ ok: true }) // cancel_booking is idempotent
      const after = await endState(booking.id)
      expect(after.refunds).toHaveLength(1)
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('a free booking cancels with no refund machinery', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    try {
      const { data: booking } = await db.rpc('book_free_tickets', {
        p_ticket_type_id: seed.ticketTypeId,
        p_attendee_id: seed.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
        p_attendee_note: null,
      })
      const result = await cancelBooking(callerOf(seed.attendeeId), booking!.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const { count } = await db.from('refunds').select('*', { count: 'exact', head: true })
      const after = await endState(booking!.id)
      expect(after.status).toBe('cancelled')
      expect(after.refunds).toEqual([])
      void count
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('an uncaptured (awaiting_payment) cancel releases the hold, no refund', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true })
      const after = await endState(booking.id)
      expect(after.status).toBe('cancelled')
      expect(after.refunds).toEqual([])
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('a failed provider call leaves the row pending for the sweep, booking still refunded', async () => {
    const { seed, booking } = await confirmedPaidBooking(48, 24)
    razorpayProvider.mockReturnValue(
      fakeProvider({ createRefund: vi.fn(async () => { throw new Error('razorpay down') }) }),
    )
    try {
      const result = await cancelBooking(callerOf(seed.attendeeId), booking.id, 'attendee')
      expect(result).toEqual({ ok: true }) // the seat decision does not wait on Razorpay
      const after = await endState(booking.id)
      expect(after.status).toBe('refunded')
      expect(after.refunds).toEqual([
        { status: 'pending', provider_refund_id: null, amount_paise: booking.total_paise },
      ])
    } finally {
      await cleanupEvent(db, seed)
    }
  })
})
```

(`seed.hostProfileId` — the host's `profiles.id`, which `mayCancel` compares against. **Check `SeededEvent`'s field name for it first**; if the helper exposes only the `hosts.id`, look up `hosts.profile_id` in the test.)

- [ ] **Step 2: Run it, confirm it fails on the signature**

Run: `npx vitest run lib/payments/cancel-refunds.test.ts`
Expected: FAIL — `cancelBooking` does not accept `'attendee'` (type error at the very least; run with `--typecheck` off it still fails on missing `refundIfOwed` behavior).

- [ ] **Step 3: Add `refundIfOwed` to the payments service**

Append to `lib/payments/service.ts`:

```ts
import type { CancelInitiator } from '@/lib/payments/refund-policy'
import { refundDecision } from '@/lib/payments/refund-policy'
```

(merge with the existing import lines at the top of the file), then:

```ts
/**
 * Money, after the seat. Called by lib/bookings/service.cancelBooking once
 * cancel_booking has freed the inventory — both cancel surfaces keep that one
 * front door. Looks for a captured payment (none: free bookings and abandoned
 * checkouts cost nothing extra), applies the pure cutoff rule, creates at most
 * one refund, and flips the booking to 'refunded' — at refund creation, not at
 * Razorpay settlement, because the attendee's seat decision is final at cancel
 * time.
 *
 * Never throws: the cancel already succeeded, and a refund that could not be
 * sent is a pending row the sweep retries, not a reason to tell the attendee
 * their cancel failed.
 */
export async function refundIfOwed(bookingId: string, initiator: CancelInitiator): Promise<void> {
  try {
    const db = createAdminClient()

    const { data: booking, error } = await db
      .from('bookings')
      .select('id, status, events(starts_at, refund_cutoff_hours)')
      .eq('id', bookingId)
      .maybeSingle()
    if (error || !booking) {
      console.error('[payments] could not read the booking for a refund decision', error)
      return
    }

    const { data: payment, error: paymentError } = await db
      .from('payments')
      .select('id, provider_payment_id, amount_paise')
      .eq('booking_id', bookingId)
      .eq('status', 'captured')
      .maybeSingle()
    if (paymentError) {
      console.error('[payments] could not read payments for a refund decision', paymentError)
      return
    }
    if (!payment) return

    const decision = refundDecision({
      initiator,
      startsAt: booking.events.starts_at,
      cutoffHours: booking.events.refund_cutoff_hours,
    })
    if (decision === 'none') return

    await ensureRefund(db, payment, `cancelled by ${initiator}`)

    // 'refunded' means "refund created", not "settled" — settlement lag lives
    // in refunds.status. Scoped to 'cancelled' so a replayed call is a no-op.
    const { error: flipError } = await db
      .from('bookings')
      .update({ status: 'refunded' })
      .eq('id', bookingId)
      .eq('status', 'cancelled')
    if (flipError) console.error('[payments] refund created but the booking still says cancelled', flipError)
  } catch (cause) {
    console.error('[payments] refundIfOwed failed; the money state is inspectable in payments/refunds', cause)
  }
}
```

- [ ] **Step 4: Give `cancelBooking` its typed initiator**

`lib/bookings/service.ts`:

```ts
import { refundIfOwed } from '@/lib/payments/service'
import type { CancelInitiator } from '@/lib/payments/refund-policy'
```

Signature and reason derivation (the stored prose is unchanged — dashboards and the EH021 comment already speak it):

```ts
export async function cancelBooking(
  caller: Caller,
  bookingId: string,
  initiator: CancelInitiator,
): Promise<CancelResult> {
```

with, where `reason` was previously used:

```ts
  const reason = initiator === 'attendee' ? 'cancelled by attendee' : 'cancelled by host'
```

and, after the `cancel_booking` RPC succeeds and before `return { ok: true }`:

```ts
  // Seat first, then money. refundIfOwed never throws; a refund that could
  // not be sent is the sweep's job, not a failed cancel.
  await refundIfOwed(bookingId, initiator)
```

Call sites:
- `app/bookings/actions.ts:34`: `cancelBooking(caller, bookingId, 'cancelled by attendee')` → `cancelBooking(caller, bookingId, 'attendee')`
- `app/host/events/[id]/attendees/actions.ts:36`: `'cancelled by host'` → `'host'`

Update every test that passes or asserts the old third argument (grep `cancelBooking(`): the mocks in `app/bookings/actions.test.ts` now expect `'attendee'`, the attendees-action test `'host'`, and any direct `lib/bookings/service.test.ts` calls pass an initiator.

- [ ] **Step 5: Run the matrix, then everything**

Run: `npx vitest run lib/payments/cancel-refunds.test.ts`
Expected: PASS.
Run: `npm test && npm run typecheck && npm run lint`
Expected: all green (the updated action tests included).

- [ ] **Step 6: Commit**

```bash
git add lib/payments/service.ts lib/payments/cancel-refunds.test.ts lib/bookings/service.ts app/bookings/actions.ts "app/host/events/[id]/attendees/actions.ts" app/bookings/actions.test.ts lib/bookings/service.test.ts
git commit -m "feat: refunds follow the cutoff on both cancel surfaces"
```

(Include whichever other test files Step 4's grep touched.)

---

### Task 9: Reconciliation — the second feeder and the ops sweep

**Files:**
- Modify: `lib/payments/service.ts` (`reconcileBooking`, `reconcileAfterCheckout`, `runReconciliationSweep`)
- Create: `scripts/reconcile.ts`
- Modify: `package.json` (the `reconcile` script)
- Test: `lib/payments/reconcile.test.ts`

**Interfaces:**
- Consumes: `applyPayment`, `settleRefund` (Task 6 internals), `razorpayProvider`, `provider.listOrderPayments`, `provider.verifyCheckoutSignature`.
- Produces:
  - `reconcileBooking(bookingId: string): Promise<void>` — pulls the order's payments from Razorpay and pushes them through `applyPayment`; **never throws** (it runs inside page renders).
  - `reconcileAfterCheckout(bookingId: string, attempt: { paymentId: string; signature: string }): Promise<void>` — verifies the checkout signature against the **stored** order id, then reconciles once; never throws.
  - `runReconciliationSweep(): Promise<{ reconciled: number; released: number; refundsRetried: number }>`
  - `npm run reconcile` — the where-nobody-is-looking sweep.

- [ ] **Step 1: Write the failing tests**

`lib/payments/reconcile.test.ts` (mocked provider, real DB):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminClient, cleanupEvent, seedEvent } from '@/tests/helpers/db'
import { fakeProvider, seedPaidBooking } from '@/tests/helpers/payments'
import type { ProviderPayment } from '@/lib/payments/provider'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})

const { razorpayProvider } = vi.mocked(await import('@/lib/payments/razorpay'))
const { reconcileBooking, reconcileAfterCheckout, runReconciliationSweep } = await import('@/lib/payments/service')

const db = adminClient()

function capturedAnswer(orderId: string, amountPaise: number): ProviderPayment[] {
  return [{
    paymentId: 'pay_reconciled_1',
    orderId,
    amountPaise,
    status: 'captured',
    method: 'upi',
    errorCode: null,
    errorDescription: null,
  }]
}

beforeEach(() => {
  razorpayProvider.mockReturnValue(fakeProvider())
})

describe('reconcileBooking', () => {
  it('heals a dropped webhook: Razorpay says captured, the booking confirms', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
      razorpayProvider.mockReturnValue(
        fakeProvider({ listOrderPayments: vi.fn(async () => capturedAnswer(orderId, booking.total_paise)) }),
      )

      await reconcileBooking(booking.id)

      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('confirmed')
      const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
      expect(count).toBe(1)
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('does nothing when Razorpay reports no terminal attempt', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })

      await reconcileBooking(booking.id)

      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('awaiting_payment')
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('never throws — a provider outage logs and leaves the page alive', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })
      razorpayProvider.mockReturnValue(
        fakeProvider({ listOrderPayments: vi.fn(async () => { throw new Error('razorpay down') }) }),
      )

      await expect(reconcileBooking(booking.id)).resolves.toBeUndefined()
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('is a no-op for a booking with no payments row', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 0, status: 'published' })
    try {
      const { data: booking } = await db.rpc('book_free_tickets', {
        p_ticket_type_id: seed.ticketTypeId,
        p_attendee_id: seed.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
        p_attendee_note: null,
      })
      await expect(reconcileBooking(booking!.id)).resolves.toBeUndefined()
    } finally {
      await cleanupEvent(db, seed)
    }
  })
})

describe('reconcileAfterCheckout', () => {
  it('verifies against the STORED order id, then reconciles', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
      const provider = fakeProvider({ listOrderPayments: vi.fn(async () => capturedAnswer(orderId, booking.total_paise)) })
      razorpayProvider.mockReturnValue(provider)

      await reconcileAfterCheckout(booking.id, { paymentId: 'pay_reconciled_1', signature: 'sig' })

      expect(provider.verifyCheckoutSignature).toHaveBeenCalledWith({
        orderId, // ours, not the client's
        paymentId: 'pay_reconciled_1',
        signature: 'sig',
      })
      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('confirmed')
    } finally {
      await cleanupEvent(db, seed)
    }
  })

  it('a bad checkout signature reconciles nothing and waits for the webhook', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      const { booking } = await seedPaidBooking(db, seed, { quantity: 1 })
      const provider = fakeProvider({ verifyCheckoutSignature: vi.fn(() => false) })
      razorpayProvider.mockReturnValue(provider)

      await reconcileAfterCheckout(booking.id, { paymentId: 'pay_x', signature: 'forged' })

      expect(provider.listOrderPayments).not.toHaveBeenCalled()
      const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
      expect(after!.status).toBe('awaiting_payment')
    } finally {
      await cleanupEvent(db, seed)
    }
  })
})

describe('runReconciliationSweep', () => {
  it('reconciles lapsed holds with orders, releases pure abandonments, retries stuck refunds', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, status: 'published' })
    try {
      // A dropped-webhook capture on a lapsed hold…
      const { booking, orderId } = await seedPaidBooking(db, seed, { quantity: 1 })
      await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
      // …and a refund we owe but could not send (no provider_refund_id).
      const { data: payment } = await db.from('payments').select('id').eq('booking_id', booking.id).single()
      await db.from('refunds').insert({ payment_id: payment!.id, amount_paise: 100, status: 'pending', reason: 'test seed' })
      await db.from('payments').update({ provider_payment_id: 'pay_for_stuck_refund', status: 'captured' }).eq('id', payment!.id)

      const provider = fakeProvider({ listOrderPayments: vi.fn(async () => capturedAnswer(orderId, booking.total_paise)) })
      razorpayProvider.mockReturnValue(provider)

      const counts = await runReconciliationSweep()

      expect(counts.reconciled).toBeGreaterThanOrEqual(1)
      expect(counts.refundsRetried).toBeGreaterThanOrEqual(1)
      const { data: refund } = await db.from('refunds').select('provider_refund_id, status').eq('payment_id', payment!.id).single()
      expect(refund!.provider_refund_id).toBe('rfnd_test_1')
    } finally {
      await cleanupEvent(db, seed)
    }
  })
})
```

Note the sweep test seeds a slightly artificial state (a pending refund beside a to-be-reconciled hold) to exercise both arms in one pass; the arms are independent, so this is coverage economy, not a real-world claim. Also note: because the sweep reconciles a **lapsed** hold, the Task 6 capture path will judge it expired and auto-refund — the assertion on `reconciled` counts the attempt, not a confirm. A capture that beat the hold but lost its webhook is healed by the **page-load** reconcile (tested above); the sweep, arriving minutes later, deliberately applies the by-the-clock rule. This asymmetry is the spec's, recorded here so nobody "fixes" it.

- [ ] **Step 2: Run it, confirm it fails on the missing exports**

Run: `npx vitest run lib/payments/reconcile.test.ts`
Expected: FAIL — `reconcileBooking` is not exported.

- [ ] **Step 3: Write the reconciliation slice**

Append to `lib/payments/service.ts`:

```ts
/**
 * The second feeder. Fetches the order's payments from Razorpay and pushes
 * them through the same applyPayment the webhook route uses; the unique
 * constraints make double-application a no-op. Never throws — its callers are
 * a page render and the sweep, and healing must not take either down.
 *
 * A useful side effect: local dev and the physical-phone test can complete a
 * paid booking WITHOUT a webhook tunnel — this does the same work the webhook
 * would have.
 */
export async function reconcileBooking(bookingId: string): Promise<void> {
  try {
    const db = createAdminClient()
    const { data: payment, error } = await db
      .from('payments')
      .select('provider_order_id')
      .eq('booking_id', bookingId)
      .maybeSingle()
    if (error || !payment) return

    const provider = razorpayProvider()
    const attempts = await provider.listOrderPayments(payment.provider_order_id)

    // One row per order, last write wins — and a capture outranks any failure,
    // so apply at most one terminal fact, preferring the capture.
    const terminal = attempts.find((a) => a.status === 'captured') ?? attempts.find((a) => a.status === 'failed')
    if (!terminal) return

    await applyPayment(db, terminal, terminal as unknown as Json)
  } catch (cause) {
    console.error('[payments] reconcile failed; the webhook or the sweep will try again', cause)
  }
}

/**
 * The first status poll after the sheet reports success carries
 * {payment_id, signature}. Verifying that checkout signature — against OUR
 * stored order id, never the client's — earns an immediate reconcile, so
 * confirmation does not wait on webhook latency; the write is still made from
 * Razorpay's API answer, never from the client's claim.
 */
export async function reconcileAfterCheckout(
  bookingId: string,
  attempt: { paymentId: string; signature: string },
): Promise<void> {
  try {
    const db = createAdminClient()
    const { data: payment } = await db
      .from('payments')
      .select('provider_order_id')
      .eq('booking_id', bookingId)
      .maybeSingle()
    if (!payment) return

    const provider = razorpayProvider()
    const genuine = provider.verifyCheckoutSignature({
      orderId: payment.provider_order_id,
      paymentId: attempt.paymentId,
      signature: attempt.signature,
    })
    if (!genuine) {
      console.warn('[payments] checkout signature did not verify; waiting for the webhook')
      return
    }
    await reconcileBooking(bookingId)
  } catch (cause) {
    console.error('[payments] post-checkout reconcile failed; the webhook will land', cause)
  }
}

/**
 * The where-nobody-is-looking sweep (npm run reconcile). Three arms:
 * lapsed holds that have an order (a dropped webhook may hide a capture),
 * then a global release of pure abandonments, then refunds owed but not yet
 * sent. No pg_cron and no deploy-target cron yet — that joins the
 * environment-setup note the day a second environment exists.
 */
export async function runReconciliationSweep(): Promise<{
  reconciled: number
  released: number
  refundsRetried: number
}> {
  const db = createAdminClient()

  const { data: stale, error: staleError } = await db
    .from('bookings')
    .select('id, payments(id)')
    .eq('status', 'awaiting_payment')
    .lt('hold_expires_at', new Date().toISOString())
  if (staleError) throw new Error(`the sweep could not list lapsed holds: ${staleError.message}`)

  let reconciled = 0
  for (const booking of stale ?? []) {
    if (booking.payments.length === 0) continue // no order was ever created; release below
    await reconcileBooking(booking.id)
    reconciled += 1
  }

  const { data: released, error: releaseError } = await db.rpc('release_expired_holds')
  if (releaseError) throw new Error(`the sweep could not release holds: ${releaseError.message}`)

  const { data: stuck, error: stuckError } = await db
    .from('refunds')
    .select('id, payments(provider_payment_id)')
    .eq('status', 'pending')
    .is('provider_refund_id', null)
  if (stuckError) throw new Error(`the sweep could not list stuck refunds: ${stuckError.message}`)

  let refundsRetried = 0
  for (const refund of stuck ?? []) {
    if (await settleRefund(db, refund.id, refund.payments.provider_payment_id)) refundsRetried += 1
  }

  return { reconciled, released: released ?? 0, refundsRetried }
}
```

(If the generated embed type for `refund.payments` is an array rather than an object — `refunds.payment_id` is a to-one FK, so it should be an object — adjust the access accordingly; `lib/bookings/service.ts`'s embed comment explains how the generated types decide.)

- [ ] **Step 4: The ops script**

`scripts/reconcile.ts`:

```ts
/**
 * The reconcile sweep, hand-run: `npm run reconcile`.
 *
 * Runs under `--conditions=react-server` so the `import 'server-only'`
 * markers inside lib/payments resolve to that package's empty react-server
 * build instead of throwing; tsx resolves the repo's `@/` tsconfig paths.
 * Env comes from .env.local the same way tests/helpers/db.ts loads it.
 */
import { config } from 'dotenv'

config({ path: '.env.local' })
config({ path: '.env' })

const { runReconciliationSweep } = await import('@/lib/payments/service')

const counts = await runReconciliationSweep()
console.log(
  `[reconcile] bookings reconciled: ${counts.reconciled}, holds released: ${counts.released}, refunds retried: ${counts.refundsRetried}`,
)
```

(Match the dotenv invocation style `tests/helpers/db.ts` actually uses — read it first; the two `config` calls above mirror "`.env.local` then `.env`".)

`package.json` scripts, after `"db:types"`:

```json
    "reconcile": "node --conditions=react-server --import=tsx scripts/reconcile.ts",
```

- [ ] **Step 5: Run the tests, then the script against the local stack**

Run: `npx vitest run lib/payments/reconcile.test.ts`
Expected: PASS.

Run: `npm run reconcile`
Expected: one log line with three counts (likely zeros on a quiet dev DB) and exit code 0. If module resolution trips on the `@/` alias under tsx, switch the script's import to a relative `../lib/payments/service` — tsx accepts both forms; record whichever worked.

- [ ] **Step 6: Full suite, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/payments/service.ts lib/payments/reconcile.test.ts scripts/reconcile.ts package.json
git commit -m "feat: reconciliation — page-load healing and the ops sweep"
```

---

### Task 10: The paid path on the event page

**Files:**
- Modify: `lib/events/queries.ts` (`PublicEvent` + select), `app/e/[slug]/actions.ts`, `app/e/[slug]/book-panel.tsx`, `app/e/[slug]/page.tsx`
- Test: `app/e/[slug]/start-paid-checkout-action.test.ts` (new file — do not extend the segment's existing action test)

**Interfaces:**
- Consumes: `startPaidCheckout` service (Task 5), `refundPolicySentence` (Task 3), `formatPaise`.
- Produces: `startPaidCheckout(_previous: BookState, formData: FormData): Promise<BookState>` form action in `app/e/[slug]/actions.ts`; `BookPanel` accepts `paid?: boolean`.

- [ ] **Step 1: Write the failing action test**

`app/e/[slug]/start-paid-checkout-action.test.ts` — action-test style, modeled mock-for-mock on the segment's existing action test (read it first: `next/cache`, `next/navigation` with a throwing redirect, `next/headers`, `@/lib/bookings/caller` are mocked there; this file mocks `@/lib/payments/service` instead of the bookings service):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/payments/service', () => ({ startPaidCheckout: vi.fn() }))
// …plus the segment's standard next/cache, next/navigation, next/headers and
// currentCaller mocks, copied from the existing action test in this directory.

const { startPaidCheckout: serviceMock } = vi.mocked(await import('@/lib/payments/service'))
const { startPaidCheckout } = await import('@/app/e/[slug]/actions')

function formDataFor(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('ticketTypeId', '11111111-2222-4333-8444-555555555555')
  data.set('slug', 'diwali-supper-club')
  data.set('quantity', '2')
  data.set('attendeeName', 'Asha')
  for (const [name, value] of Object.entries(overrides)) data.set(name, value)
  return data
}

describe('startPaidCheckout (form action)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serviceMock.mockResolvedValue({ ok: true, reference: 'G09SPK0K' })
  })

  it('redirects to the checkout home with the reference', async () => {
    // assert the RedirectSignal/threw-redirect the segment's tests use, to /bookings/G09SPK0K
    await expect(startPaidCheckout({}, formDataFor())).rejects.toMatchObject({ digest: expect.stringContaining('/bookings/G09SPK0K') })
    expect(serviceMock).toHaveBeenCalledWith(expect.anything(), '11111111-2222-4333-8444-555555555555', 2, 'Asha')
  })

  it('returns the service sentence on refusal', async () => {
    serviceMock.mockResolvedValue({ ok: false, error: 'This event has already started.' })
    await expect(startPaidCheckout({}, formDataFor())).resolves.toEqual({ error: 'This event has already started.' })
  })

  it('refuses a garbled quantity before touching the service', async () => {
    await expect(startPaidCheckout({}, formDataFor({ quantity: 'lots' }))).resolves.toEqual({
      error: 'Choose how many seats you need.',
    })
    expect(serviceMock).not.toHaveBeenCalled()
  })

  it('requires a name for the host', async () => {
    await expect(startPaidCheckout({}, formDataFor({ attendeeName: '   ' }))).resolves.toEqual({
      error: 'Tell the host who to expect.',
    })
    expect(serviceMock).not.toHaveBeenCalled()
  })
})
```

(Adopt the exact redirect-assertion idiom from the neighbouring test file rather than the `digest` sketch above — it already knows how the repo's `redirect` mock throws.)

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run "app/e/[slug]/start-paid-checkout-action.test.ts"`
Expected: FAIL — the action does not exist.

- [ ] **Step 3: Write the action**

`app/e/[slug]/actions.ts` — add beside `bookEvent`, mirroring its shape line for line (identity from `currentCaller()`, the same field reads, the same revalidates, the same redirect), with the service swapped:

```ts
import { startPaidCheckout as startPaidCheckoutService } from '@/lib/payments/service'
```

```ts
/** The paid twin of bookEvent: same guards, same redirect, money instead of a confirm. */
export async function startPaidCheckout(_previous: BookState, formData: FormData): Promise<BookState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  // Field validation: copy bookEvent's reads verbatim (ticketTypeId shape
  // check, integer quantity ≥ 1, trimmed 80-char attendeeName) — the two
  // actions must refuse identically, or the paid path leaks different
  // sentences for the same mistake.

  const result = await startPaidCheckoutService(caller, ticketTypeId, quantity, attendeeName)
  if (!result.ok) return { error: result.error }

  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`)
  revalidatePath('/')
  redirect(`/bookings/${result.reference}`)
}
```

(The comment block stands in for bookEvent's exact validation lines — copy them from the function directly above; they are already written and tested.)

- [ ] **Step 4: Teach the panel the paid mode**

`app/e/[slug]/book-panel.tsx`:

- Props gain `paid?: boolean` (default `false`).
- `import { bookEvent, startPaidCheckout, type BookState } from './actions'`
- `useActionState<BookState, FormData>(paid ? startPaidCheckout : bookEvent, {})`
- Button label: `pending ? (paid ? 'Starting payment…' : 'Booking…') : paid ? \`Pay ${priceLabel}\` : 'Book'`

`app/e/[slug]/page.tsx`:

- Split the gate (the current `bookable` keeps its meaning for free events):

```ts
  const common = !!ticket && !soldOut && !started && !event.requires_approval
  const bookableFree = common && ticket.price_paise === 0
  const bookablePaid = common && ticket.price_paise > 0
```

- Render `<BookPanel …/>` when `bookableFree` exactly as today; when `bookablePaid`, render it with `paid` and the price:

```tsx
          <BookPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={maxSeats}
            priceLabel={formatPaise(ticket.price_paise)}
            seatsLabel={seatsLabel}
            paid
          />
```

- The inert fallback button loses its price-implies-unbookable arm (`'Booking opens soon'` stays only for whatever remains genuinely unbookable).
- The policy sentence, shown for priced events near the when/where details (server component, plain `<p>`):

```tsx
        {!!ticket && ticket.price_paise > 0 && (
          <p className="text-muted text-sm">{refundPolicySentence(event.refund_cutoff_hours)}</p>
        )}
```

`lib/events/queries.ts`: `PublicEvent` gains `refund_cutoff_hours: number`; `getPublishedEventBySlug`'s select string gains `refund_cutoff_hours` (beside `requires_approval, allows_cash`).

- [ ] **Step 5: Look at it**

`npm run dev`, sign in, create a paid event (₹500, cutoff 24), publish, open `/e/<slug>` on `localhost:3100`: the bar shows **Pay ₹500.00**, the policy sentence reads "Free cancellation until 24 h before start." Submitting sends you to `/bookings/<ref>` (which still renders the plain awaiting_payment shell — Task 11 builds the checkout there). With the `RAZORPAY_*` vars absent from `.env.local`, submitting must show "Payments are not set up on this server yet." inline.

- [ ] **Step 6: Tests, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/events/queries.ts "app/e/[slug]"
git commit -m "feat: the event page grows the paid path"
```

---

### Task 11: The checkout home on the booking page

**Files:**
- Modify: `lib/bookings/queries.ts` (`BOOKING_COLUMNS`, `MyBooking`), plus its column-shape tests (`lib/bookings/queries.test.ts` / `queries-embeds.test.ts` — grep for `BOOKING_COLUMNS` assertions)
- Modify: `app/bookings/[reference]/page.tsx`
- Create: `app/bookings/[reference]/checkout-panel.tsx`
- Create: `app/bookings/[reference]/actions.ts`
- Test: `app/bookings/[reference]/poll-action.test.ts`

**Interfaces:**
- Consumes: `reconcileBooking`, `reconcileAfterCheckout` (Task 9), `refundPolicySentence` (Task 3), `serverEnv().RAZORPAY_KEY_ID`, `getBookingByReference`.
- Produces:
  - `BOOKING_COLUMNS` grows to `'id, reference, quantity, status, created_at, total_paise, hold_expires_at, attendee_name, events(id, slug, title, starts_at, city, venue_name, refund_cutoff_hours), payments(provider_order_id, status)'`; `MyBooking` gains `total_paise: number`, `hold_expires_at: string | null`, `attendee_name: string | null`, `events.refund_cutoff_hours: number`, `payments: { provider_order_id: string; status: string }[]`.
  - `pollBookingStatus(reference: string, attempt?: { paymentId: string; signature: string }): Promise<{ status: string }>` Server Action.
  - `CheckoutPanel` client component (sheet + countdown + polling).

- [ ] **Step 1: Extend the query columns**

`lib/bookings/queries.ts`: update `BOOKING_COLUMNS` and `MyBooking` to the shapes above. RLS already lets an attendee read their own `payments` rows (`payments_select_own`); for a host viewing someone's booking the embed simply comes back empty — no branch needed. Update the queries tests that assert returned shapes; run `npx vitest run lib/bookings` until green.

- [ ] **Step 2: Write the failing poll-action test**

`app/bookings/[reference]/poll-action.test.ts` (action-test style; mock `@/lib/payments/service` and `@/lib/bookings/queries`, plus the segment-standard `currentCaller`/`next/*` mocks copied from `app/bookings/actions.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/payments/service', () => ({
  reconcileAfterCheckout: vi.fn(),
  reconcileBooking: vi.fn(),
}))
vi.mock('@/lib/bookings/queries', () => ({ getBookingByReference: vi.fn() }))
// …plus currentCaller / next mocks per app/bookings/actions.test.ts.

const { reconcileAfterCheckout } = vi.mocked(await import('@/lib/payments/service'))
const { getBookingByReference } = vi.mocked(await import('@/lib/bookings/queries'))
const { pollBookingStatus } = await import('@/app/bookings/[reference]/actions')

const AWAITING = { id: 'b-1', status: 'awaiting_payment' }
const CONFIRMED = { id: 'b-1', status: 'confirmed' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pollBookingStatus', () => {
  it('is a plain read without a checkout attempt', async () => {
    getBookingByReference.mockResolvedValue(AWAITING as never)
    await expect(pollBookingStatus('G09SPK0K')).resolves.toEqual({ status: 'awaiting_payment' })
    expect(reconcileAfterCheckout).not.toHaveBeenCalled()
  })

  it('hands a first-poll checkout attempt to the service, then re-reads', async () => {
    getBookingByReference.mockResolvedValueOnce(AWAITING as never).mockResolvedValueOnce(CONFIRMED as never)
    const result = await pollBookingStatus('G09SPK0K', { paymentId: 'pay_1', signature: 'sig' })
    expect(reconcileAfterCheckout).toHaveBeenCalledWith('b-1', { paymentId: 'pay_1', signature: 'sig' })
    expect(result).toEqual({ status: 'confirmed' })
  })

  it('shrugs at a malformed reference without touching the database', async () => {
    await expect(pollBookingStatus('../etc')).resolves.toEqual({ status: 'unknown' })
    expect(getBookingByReference).not.toHaveBeenCalled()
  })

  it('answers unknown for a reference that resolves to nothing', async () => {
    getBookingByReference.mockResolvedValue(null)
    await expect(pollBookingStatus('AAAAAAAA')).resolves.toEqual({ status: 'unknown' })
  })

  it('ignores a checkout attempt on a booking that is not awaiting payment', async () => {
    getBookingByReference.mockResolvedValue(CONFIRMED as never)
    await expect(pollBookingStatus('G09SPK0K', { paymentId: 'pay_1', signature: 'sig' })).resolves.toEqual({ status: 'confirmed' })
    expect(reconcileAfterCheckout).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run it, confirm it fails; write the action**

`app/bookings/[reference]/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { currentCaller } from '@/lib/bookings/caller'
import { loginPath } from '@/lib/auth/session'
import { getBookingByReference } from '@/lib/bookings/queries'
import { reconcileAfterCheckout } from '@/lib/payments/service'

/** The booking reference alphabet (Crockford-ish base32, no I L O U). */
const REFERENCE_PATTERN = /^[0-9A-HJ-NP-TV-Z]{8}$/
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]+$/

export interface BookingStatus {
  status: string
}

/**
 * The small status action the checkout page polls. The first poll after the
 * sheet's success handler carries {payment_id, signature}; the service
 * verifies that proof and reconciles from Razorpay's API — the client's claim
 * triggers a lookup, never a write. Every later poll is a plain RLS read.
 */
export async function pollBookingStatus(
  reference: string,
  attempt?: { paymentId: string; signature: string },
): Promise<BookingStatus> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  if (!REFERENCE_PATTERN.test(reference)) return { status: 'unknown' }

  const booking = await getBookingByReference(reference)
  if (!booking) return { status: 'unknown' }

  if (
    attempt &&
    booking.status === 'awaiting_payment' &&
    PAYMENT_ID_PATTERN.test(attempt.paymentId) &&
    typeof attempt.signature === 'string'
  ) {
    await reconcileAfterCheckout(booking.id, { paymentId: attempt.paymentId, signature: attempt.signature })
    const after = await getBookingByReference(reference)
    return { status: after?.status ?? 'unknown' }
  }

  return { status: booking.status }
}
```

Run: `npx vitest run "app/bookings/[reference]/poll-action.test.ts"` — PASS.

- [ ] **Step 4: The checkout panel**

`app/bookings/[reference]/checkout-panel.tsx`:

```tsx
'use client'

import Script from 'next/script'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { formatPaise } from '@/lib/money'
import { pollBookingStatus } from './actions'

/**
 * The pay button, the Razorpay sheet, the hold countdown, and the
 * status polling — everything client-side about checkout, and none of it
 * authoritative: the server confirms from Razorpay's own answers, this
 * component only watches for the flip and refreshes.
 */

interface RazorpaySheet {
  open(): void
  close(): void
}

interface RazorpayOptions {
  key: string
  amount: number
  currency: string
  name: string
  order_id: string
  handler: (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => void
  modal?: { ondismiss?: () => void }
  prefill?: { name?: string }
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpaySheet
  }
}

const POLL_MS = 2500

function secondsLeft(until: string): number {
  const ms = new Date(until).getTime() - Date.now()
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 1000))
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function CheckoutPanel({
  reference,
  orderId,
  amountPaise,
  keyId,
  eventTitle,
  holdExpiresAt,
  attendeeName,
}: {
  reference: string
  orderId: string
  amountPaise: number
  keyId: string
  eventTitle: string
  holdExpiresAt: string
  attendeeName: string | null
}) {
  const router = useRouter()
  const [scriptReady, setScriptReady] = useState(false)
  const [remaining, setRemaining] = useState(() => secondsLeft(holdExpiresAt))
  const [paid, setPaid] = useState<{ paymentId: string; signature: string } | null>(null)
  const sheetRef = useRef<RazorpaySheet | null>(null)

  // The hold countdown. At zero the sheet closes and the server re-renders
  // this page into its expired shape; a capture that raced the deadline is
  // the processor's auto-refund case, not this component's problem.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const left = secondsLeft(holdExpiresAt)
      setRemaining(left)
      if (left <= 0) {
        sheetRef.current?.close()
        window.clearInterval(interval)
        router.refresh()
      }
    }, 1000)
    return () => window.clearInterval(interval)
  }, [holdExpiresAt, router])

  // Polling starts when the sheet reports success. The first tick carries the
  // checkout proof; after that it is a plain read every POLL_MS until the
  // status flips, then a server re-render swaps this panel for the QR view.
  useEffect(() => {
    if (!paid) return
    let firstTick: { paymentId: string; signature: string } | null = paid
    const interval = window.setInterval(async () => {
      const attempt = firstTick
      firstTick = null
      try {
        const result = await pollBookingStatus(reference, attempt ?? undefined)
        if (result.status !== 'awaiting_payment' && result.status !== 'unknown') {
          window.clearInterval(interval)
          router.refresh()
        }
      } catch {
        // transient; the next tick tries again, and the webhook is landing anyway
      }
    }, POLL_MS)
    return () => window.clearInterval(interval)
  }, [paid, reference, router])

  function openSheet() {
    if (!window.Razorpay) return
    const sheet = new window.Razorpay({
      key: keyId,
      amount: amountPaise,
      currency: 'INR',
      name: eventTitle,
      order_id: orderId,
      handler: (response) =>
        setPaid({ paymentId: response.razorpay_payment_id, signature: response.razorpay_signature }),
      modal: { ondismiss: () => {} }, // an abandoned sheet resumes from this same page
      prefill: attendeeName ? { name: attendeeName } : {},
    })
    sheetRef.current = sheet
    sheet.open()
  }

  const expired = remaining <= 0

  return (
    <section className="border-line rounded-lg border p-4">
      <Script src="https://checkout.razorpay.com/v1/checkout.js" onLoad={() => setScriptReady(true)} />
      <div aria-live="polite">
        {paid ? (
          <p className="text-sm">Payment received — issuing your tickets…</p>
        ) : expired ? (
          <p className="text-sm">This hold has expired. Nothing was charged.</p>
        ) : (
          <>
            <button
              type="button"
              onClick={openSheet}
              disabled={!scriptReady}
              className="bg-accent w-full rounded-lg px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              Pay {formatPaise(amountPaise)}
            </button>
            <p className="text-muted mt-2 text-center font-mono text-[12px]">
              Seats held for another {clock(remaining)}
            </p>
          </>
        )}
      </div>
    </section>
  )
}
```

(Match the button's classes to whatever the booking form's primary button actually uses — read `book-panel.tsx` and copy its classes rather than trusting the ones sketched here.)

- [ ] **Step 5: The page branches**

`app/bookings/[reference]/page.tsx`:

- After the `notFound()` guard, the page-load heal — a dropped webhook fixed exactly where someone is staring at "payment pending":

```tsx
  let booking = await getBookingByReference(reference)
  if (!booking) notFound()

  if (booking.status === 'awaiting_payment' && booking.payments.length > 0) {
    await reconcileBooking(booking.id)
    booking = await getBookingByReference(reference)
    if (!booking) notFound()
  }
```

- The status line grows the new endings (replacing the bare `Booking ${booking.status}` fallback):

```tsx
  const STATUS_LINE: Record<string, string> = {
    confirmed: "You're going",
    awaiting_payment: 'Complete your payment',
    pending_approval: 'Waiting for the host',
    expired: 'This booking expired — nothing was charged',
    cancelled: 'Booking cancelled',
    refunded: 'Booking cancelled — refund on its way',
  }
```

- Mount the panel for a live paid hold (below the details `<dl>`):

```tsx
  const payment = booking.payments[0] ?? null
  const keyId = serverEnv().RAZORPAY_KEY_ID
  const holdLive = !!booking.hold_expires_at && new Date(booking.hold_expires_at).getTime() > Date.now()
```

```tsx
      {booking.status === 'awaiting_payment' && payment && holdLive && keyId && event && (
        <CheckoutPanel
          reference={booking.reference}
          orderId={payment.provider_order_id}
          amountPaise={booking.total_paise}
          keyId={keyId}
          eventTitle={event.title}
          holdExpiresAt={booking.hold_expires_at!}
          attendeeName={booking.attendee_name}
        />
      )}
```

(`booking.hold_expires_at!` is justified by `holdLive` on the same line; if the repo style prefers it, hoist a narrowed `const holdExpiresAt` instead.)

- The policy sentence for paid bookings, in the details section:

```tsx
      {booking.total_paise > 0 && event && (
        <p className="text-muted text-sm">{refundPolicySentence(event.refund_cutoff_hours)}</p>
      )}
```

(`event.refund_cutoff_hours` comes from the Step 1 embed; add it to the `MyBooking['events']` type.)

- [ ] **Step 6: Walk the local loop without a webhook tunnel**

With Razorpay **test-mode keys** in `.env.local`: book a paid event → land on `/bookings/<ref>` → countdown ticking → Pay → the test sheet → success → "issuing your tickets…" → the QR view appears (the poll's first tick verified the signature and reconciled — no tunnel needed). Then abandon one: book, close the sheet, wait out the ten minutes (or `update bookings set hold_expires_at = now()` via `supabase db query`), reload — the expired shape, no charge. If no test keys are at hand, defer this walk to the launch checklist and say so in the task report.

- [ ] **Step 7: Tests, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add lib/bookings/queries.ts lib/bookings/queries.test.ts "app/bookings/[reference]"
git commit -m "feat: the booking page becomes the checkout home"
```

(Plus whichever queries-shape test files Step 1 touched.)

---

### Task 12: Consequences before the tap

**Files:**
- Modify: `app/bookings/page.tsx`, `app/bookings/cancel-button.tsx`
- Modify: `app/host/events/[id]/attendees/page.tsx` and its cancel control (**read the directory first** — the control is the client component beside `checkInAttendee`)
- Modify: `lib/bookings/queries.ts` (`EventAttendee` + `listEventAttendees` select gain `total_paise`; the events embed there gains `starts_at, refund_cutoff_hours` if not already selected)

**Interfaces:**
- Consumes: `cancelConsequence` (Task 3); the Task 11 `BOOKING_COLUMNS` additions (already flowing into `listMyBookings`).
- Produces: the money consequence stated beside every cancel affordance, before the tap.

- [ ] **Step 1: The attendee's own list**

`app/bookings/page.tsx` — where each row renders its `CancelButton`, compute the sentence server-side (only confirmed paid bookings have money at stake; `cancelConsequence` returns null for free ones):

```tsx
              consequence={
                booking.status === 'confirmed' && booking.events
                  ? cancelConsequence({
                      initiator: 'attendee',
                      totalPaise: booking.total_paise,
                      startsAt: booking.events.starts_at,
                      cutoffHours: booking.events.refund_cutoff_hours,
                    })
                  : null
              }
```

`app/bookings/cancel-button.tsx` — props gain `consequence?: string | null`; render it inside the existing `aria-live` container, above the error line:

```tsx
        {consequence && <p className="text-muted mt-1 text-[13px]">{consequence}</p>}
```

- [ ] **Step 2: The host's guest list**

`lib/bookings/queries.ts`: `EventAttendee` gains `total_paise: number`; `listEventAttendees`'s select gains `total_paise`. The host's sentence needs no clock — host removal always refunds in full — so the page computes:

```tsx
  const consequence =
    attendee.status === 'confirmed' && attendee.total_paise > 0
      ? `Removing refunds ${formatPaise(attendee.total_paise)} in full.`
      : null
```

and threads it into the remove control the same way Step 1 did. (This duplicates `cancelConsequence`'s host arm as one line; if the page already has the event's `starts_at`/cutoff in scope, calling `cancelConsequence({ initiator: 'host', … })` instead is equally right — pick whichever reads better in that file.)

- [ ] **Step 3: Look at both surfaces**

Dev server: `/bookings` shows "You'll be refunded ₹500.00." inside the window and "Past the refund window — no refund." outside it (create one of each by editing `refund_cutoff_hours` via the edit form); the guest list shows "Removing refunds ₹500.00 in full." on paid rows and nothing on free rows.

- [ ] **Step 4: Tests, typecheck, lint; commit**

```bash
npm test && npm run typecheck && npm run lint
git add app/bookings lib/bookings/queries.ts "app/host/events/[id]/attendees"
git commit -m "feat: cancel surfaces state the money consequence before the tap"
```

---

### Task 13: Final verification and merge

**Files:**
- No new code. The whole branch, reviewed and merged.

- [ ] **Step 1: The full gate**

```bash
npm test && npm run typecheck && npm run lint && npm run build
npm run reconcile   # against the running local stack: three counts, exit 0
```

Expected: everything green; the suite grew from the Task 1 baseline by the new payment tests and lost none.

- [ ] **Step 2: Whole-branch review**

Request a whole-branch review (superpowers:requesting-code-review) over `git diff master...phase-3-payments`, with the spec as the yardstick. Fix anything above Minor before merging; record deferred minors in the session handoff.

- [ ] **Step 3: Merge, keep the branch**

```bash
git checkout master
git merge --no-ff phase-3-payments -m "Merge Phase 3: Razorpay checkout, webhook truth, cutoff refunds"
git push origin master phase-3-payments
npm run db:stop   # C: is ~99% full; the stack backs up on stop
```

---

## Deliberately manual — the launch checklist, not CI

Per the spec's Testing section, these are **not** plan tasks:

- The Playwright journey against Razorpay **test mode** (publish → pay → QR → scan), run before any host onboards.
- One real **₹1 transaction in live mode**, refunded through the host cancel surface, before any host onboards.
- Configuring the webhook (URL `<site>/api/webhooks/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`, events: `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`) in the Razorpay dashboard — webhooks cannot reach a laptop; the reconcile path covers the local loop until then.

## Known limitations, carried from the spec on purpose

- One active booking per attendee per event, paid included (`EH033`); cancel-and-rebook or a friend's phone are the workarounds.
- No partial refunds; `full` or `none`.
- `refunded` means "refund created", not "settled" — settlement lag is visible in `refunds.status`.
- One order per booking's lifetime; a lapsed hold means a fresh booking.
- The **sweep** applies the by-the-clock rule to a lapsed hold whose webhook was dropped: the capture is auto-refunded even though it happened in time. Money is never lost — the attendee is refunded in full — and the page-load reconcile heals the common case first. Recorded in Task 9's test notes.
- Still no un-check-in (Phase 2b), no cash, no approvals, no waitlists, no notifications, no payout automation.
