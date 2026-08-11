# Phase 5a — Approvals and Cash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `requires_approval` event runs request → host approves/declines → pay-within-24h (or confirm directly for free/cash) → the same per-seat QR every other booking gets; an `allows_cash` event books instant-confirm cash seats — all on the SQL machinery Phase 0 built, recreated to current conventions.

**Architecture:** One migration recreates `request_booking` (drop-first — the signature grows name/note/mode) with the modern guard block, gives `approve_booking` a new body under its unchanged signature (started guard; cash/free confirm straight from `pending_approval`, which `confirm_booking` already tolerates; online-paid keeps the 24h hold), and adds `book_cash_tickets` (guards + `reserve_tickets(mode: 'cash')` + confirm, one transaction — the cash mirror of `book_free_tickets`). `lib/bookings/service.ts` grows the four Caller-first writes; `lib/payments/service.ts` grows `beginApprovedCheckout`, the missing piece between an approval and the Phase 3 checkout rails (order created lazily on the explicit Pay tap, idempotent, and — unlike `startPaidCheckout` — never cancelling the booking on failure, because the approval hold is the host's yes and must survive a retry). Decline is not a new function: `cancel_booking` with reason `'declined by host'`. No new admin importers, no new deps, no notification code (Phase 4).

**Tech Stack:** Postgres 17 (local Supabase), plpgsql, Next.js 16.3 App Router, React 19.2, TypeScript, Tailwind 4 (paper-palette tokens), supabase-js 2.x, Vitest 4. **No new runtime dependencies, no new env vars.**

**Spec:** [`docs/specs/2026-08-11-phase-5a-approvals-cash-design.md`](../specs/2026-08-11-phase-5a-approvals-cash-design.md)

## Global Constraints

- **Identity never comes from a form.** Every write takes a `Caller` from `lib/bookings/caller.ts`; only `currentCaller()` can produce one.
- **The ESLint admin-import fence does not grow.** `lib/supabase/admin.ts` stays importable by exactly `lib/bookings/service.ts`, `lib/checkin/service.ts`, `lib/payments/service.ts` — every Phase 5a write lands in the first or third.
- **RLS does not protect service-role writes.** Every authorisation decision in the two service files is the whole of the rule; `mayApprove` is pure and exhaustively tested like `mayCancel`.
- **Money is integer paise** (`lib/money.ts`); display via `formatPaise`. **Fees and commission stay 0**: `approveBooking` passes no fee arguments — `approve_booking`'s defaults do it — and cash zeroes both by construction.
- **Requests take no inventory.** `reserved_count` moves only at approval (`approve_booking`) or reservation (`reserve_tickets`); a test asserting otherwise is wrong, not the code.
- **EH05x is this phase's SQLSTATE block** (EH050–EH059, allocation in Task 1); refusals that `reserve_tickets` already words for a human pass through unmapped.
- **`params` and `searchParams` are Promises** in Next.js 16 — use the generated `PageProps<'/route'>` helpers. `cookies()` is async.
- **Run `npm run db:types` after the migration.** `lib/supabase/types.ts` is committed, never hand-edited.
- **Apply the migration with `npx supabase migration up` — NOT `supabase db reset`.** The dev DB holds live evidence rows (the walkthrough event, a settled refund) the user is keeping; reset wipes them.
- **`npm test` needs `npm run db:start`,** which needs Docker Desktop, which starts only via PowerShell: `powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`. A `createTestUser failed: fetch failed` error means the stack is down, not an app bug.
- **Dev server: `localhost:3100`, never `127.0.0.1:3100`** (the IP form 403s dev chunks and React never hydrates).
- **Subagents dispatched with `model: "sonnet"` fail on this Foundry deployment.** Use the inherited session model or `haiku`.
- **The session mock installs as an import side effect**; a module under test that needs mocks must be imported with a top-level `await import` after `vi.mock` calls.
- **`lib/events/actions.test.ts` is order-dependent; do not append to it.** New tests go in new files.
- **Baseline suite: 482 tests / 46 files, all green** (at `781b51f`; re-record the exact count in Task 1 — commits since are docs-only). Never finish a task with a red suite.
- **Colours come from the `globals.css` tokens** (`paper/ink/muted/line/accent/raised`); semantic green/amber/red stay Tailwind hues. No hex literals in components.
- **`C:` is ~99% full.** `npm run db:stop` when the session ends.
- **Work on branch `phase-5a-approvals-cash`** (created in Task 1, merged `--no-ff` after the final review).

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260811000004_approvals_and_cash.sql` | **New.** `request_booking` dropped and recreated (name/note/mode, EH050–EH054); `approve_booking` body replaced (EH055–EH056, cash-aware); `book_cash_tickets` (EH054, EH057–EH059); `payments_one_per_booking` unique index; revoke/grant pairs. |
| `lib/supabase/types.ts` | **Regenerated.** |
| `lib/bookings/rpc-errors.ts` | **Modified.** EH050–EH059 → sentences. |
| `lib/bookings/authorize.ts` | **Modified.** `mayApprove` beside `mayCancel`. |
| `lib/payments/refund-policy.ts` | **Modified.** `cancelConsequence` learns `paymentMode`; cash → `null` (no money moves). |
| `lib/bookings/service.ts` | **Modified.** `requestBooking`, `approveBooking`, `declineBooking`, `bookCashTickets`. |
| `lib/bookings/queries.ts` | **Modified.** `BOOKING_COLUMNS` gains `attendee_id, attendee_note, payment_mode, approved_at, cancellation_reason` + `events.venue_address, hide_venue_until_approved`; `EventAttendee.payment_mode`; new `listEventRequests`, `listApprovedUnpaid`. |
| `lib/payments/service.ts` | **Modified.** `beginApprovedCheckout(caller, bookingId)`. |
| `app/e/[slug]/actions.ts` | **Modified.** `requestToJoin`, `bookCashEvent`. |
| `app/e/[slug]/request-panel.tsx` | **New.** Client: name, seats, note, optional online/cash radio, "Request to join". |
| `app/e/[slug]/book-panel.tsx` | **Modified.** `cash` prop → second submit button (`formAction`) for cash. |
| `app/e/[slug]/page.tsx` | **Modified.** Approval events render the request panel (open at capacity); cash prop wired. |
| `app/bookings/[reference]/page.tsx` | **Modified.** Note echo, approved-pay panel (attendee only), cash banner, declined sentence, venue-address reveal, deadline label. |
| `app/bookings/[reference]/approved-pay-panel.tsx` | **New.** Client: "You're approved — pay ₹X by <deadline>" + Pay → `startApprovedPayment`. |
| `app/bookings/[reference]/actions.ts` | **Modified.** `startApprovedPayment` beside `pollBookingStatus`. |
| `app/bookings/[reference]/checkout-panel.tsx` | **Modified.** `deadlineLabel` prop: >1 h shows "Pay by …", else the mm:ss clock. |
| `app/bookings/page.tsx`, `app/bookings/cancel-button.tsx` | **Modified.** Withdraw on `pending_approval` rows; `paymentMode` into `cancelConsequence`. |
| `app/host/events/[id]/attendees/page.tsx` | **Modified.** Requests section + Approved-unpaid strip above the untouched confirmed guest list. |
| `app/host/events/[id]/attendees/actions.ts` | **Modified.** `approveRequest`, `declineRequest`. |
| `app/host/events/[id]/attendees/approve-request-button.tsx`, `decline-request-button.tsx` | **New.** Client buttons, `cancel-attendee-button.tsx`'s pattern. |

---

### Task 1: The approvals-and-cash migration

**Files:**
- Create: `supabase/migrations/20260811000004_approvals_and_cash.sql`
- Create: `lib/bookings/approvals.test.ts`
- Create: `lib/bookings/cash.test.ts`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Consumes: `reserve_tickets`, `confirm_booking`, `cancel_booking`, `release_expired_holds`, `generate_booking_reference` (all in `20260808000002_reservation_functions.sql` — read it first), `tests/helpers/db.ts` (`adminClient`, `createTestUser`, `seedEvent`, `cleanupEvent`; `SeedOptions` already supports `requiresApproval`, `allowsCash`, `maxPerOrder`).
- Produces (later tasks call these over `.rpc()` as the service role):
  - `request_booking(p_ticket_type_id uuid, p_attendee_id uuid, p_quantity integer, p_attendee_name text, p_attendee_note text default null, p_payment_mode payment_mode default 'online') returns bookings` — `pending_approval`, **no inventory**, money 0/0/0, name/note/mode stored.
  - `approve_booking(p_booking_id uuid, p_convenience_fee_paise bigint default 0, p_commission_paise bigint default 0, p_hold_hours integer default 24) returns bookings` — unchanged signature; online-paid → `awaiting_payment` + 24h hold + `approved_at`; cash or ₹0 total → `confirmed` with tickets, fee/commission zeroed for cash.
  - `book_cash_tickets(p_ticket_type_id uuid, p_attendee_id uuid, p_quantity integer, p_attendee_name text, p_attendee_note text default null) returns bookings` — `confirmed`, `payment_mode 'cash'`, commission 0, tickets issued.
  - SQLSTATEs: `EH050` request-on-non-approval-event, `EH051` request-started, `EH052` request-cash-not-allowed, `EH053` request-over-max-per-order, `EH054` already-active-booking (request + cash, shared), `EH055` approve-started, `EH056` approve-not-pending, `EH057` cash-free-ticket, `EH058` cash-needs-approval, `EH059` cash-started. Published / availability / reserve's cash guard pass through as `check_violation` sentences.
  - `payments_one_per_booking` unique index on `payments (booking_id)` — formalises Phase 3's "one order per booking's lifetime"; Task 5's idempotency leans on it.

- [ ] **Step 1: Branch, stack up, record the baseline**

```bash
git checkout -b phase-5a-approvals-cash
npm run db:start   # Docker via PowerShell first if it is down
npm test           # record the exact test/file count for Task 9
```

- [ ] **Step 2: Write the migration**

`supabase/migrations/20260811000004_approvals_and_cash.sql`:

```sql
-- Phase 5a: the approval flow and the cash option become reachable.
--
-- Phase 0 wrote request_booking and approve_booking ahead of any caller. This
-- migration recreates them to the conventions later phases established --
-- started-event guards (the WhatsApp link outlives the feed), max_per_order at
-- request time (request_booking never calls reserve_tickets, so nothing else
-- checks it), EH-coded refusals, an attendee name for the door list, and a
-- payment mode chosen at request time -- and adds the cash mirror of
-- book_free_tickets. Decline needs no function: cancel_booking on a
-- pending_approval row already returns no inventory (none was taken).

-- ---------------------------------------------------------------------------
-- request_booking -- recreated
-- ---------------------------------------------------------------------------
-- The signature grows, and `create or replace` cannot change a signature: it
-- would create an overload beside the old function and PostgREST would refuse
-- the ambiguous name. Drop first (the 20260811000002 precedent).
--
-- Still deliberately does NOT consume inventory: a curated supper club will
-- get more requests than seats, and that is the point. Inventory is taken at
-- approval time, which can legitimately fail if the host over-approves.
--
--   EH050  the event does not use approvals; book it directly
--   EH051  the event has already started
--   EH052  cash was requested but the event does not allow it
--   EH053  more seats than max_per_order allows
--   EH054  this attendee already has an active booking on this event
--
-- Unlike book_free_tickets, the name needs no post-insert UPDATE: this
-- function owns its INSERT, so name, note and mode go in directly.

drop function request_booking(uuid, uuid, integer, text);

create function request_booking(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text,
  p_attendee_note  text default null,
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
  -- v_ prefix is not decoration: an unprefixed `reference` collides with
  -- bookings.reference and Postgres raises 42702 (ambiguous column reference).
  v_reference text;
  attempts    integer := 0;
begin
  if p_quantity < 1 then
    raise exception 'quantity must be at least 1'
      using errcode = 'check_violation';
  end if;

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

  if not ev.requires_approval then
    raise exception 'this event does not use approvals; book it directly'
      using errcode = 'EH050';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH051';
  end if;

  if p_payment_mode = 'cash' and not ev.allows_cash then
    raise exception 'this event does not accept cash payment'
      using errcode = 'EH052';
  end if;

  -- reserve_tickets checks this for every other booking kind; requests never
  -- reach it, so the cap must be enforced here or nowhere.
  if p_quantity > tt.max_per_order then
    raise exception 'cannot request more than % per order', tt.max_per_order
      using errcode = 'EH053';
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
      using errcode = 'EH054';
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
    attendee_name, attendee_note
  )
  values (
    v_reference, ev.id, tt.id, p_attendee_id, p_quantity,
    'pending_approval', p_payment_mode,
    -- Priced at approval time, not request time.
    0, 0, 0, 0,
    nullif(btrim(p_attendee_name), ''), p_attendee_note
  )
  returning * into booking;

  return booking;

exception
  -- The pre-check loses the race sometimes; the index never does. Same
  -- remap, and the same reasoning, as book_free_tickets' handler.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH054';
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- approve_booking -- new body, same signature
-- ---------------------------------------------------------------------------
-- `create or replace` suffices: the signature is unchanged, so the existing
-- grants survive. What changes:
--   * a started-event guard (EH055) -- approving admits someone to a supper
--     club that is already eating;
--   * the not-pending refusal gets a code (EH056) so the host UI can say
--     "already handled" instead of raw Postgres;
--   * cash confirms DIRECTLY (Phase 0 auto-confirmed only at total 0, which
--     would strand a cash request in awaiting_payment asking for online
--     money), with fee and commission zeroed to mirror reserve_tickets;
--   * free keeps its direct confirm; both go straight from pending_approval,
--     which confirm_booking has tolerated since Phase 0.
-- Over-approval keeps its human sentence and passes through unmapped.

create or replace function approve_booking(
  p_booking_id            uuid,
  p_convenience_fee_paise bigint default 0,
  p_commission_paise      bigint default 0,
  p_hold_hours            integer default 24
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  booking   bookings%rowtype;
  ev        events%rowtype;
  tt        ticket_types%rowtype;
  available integer;
  subtotal  bigint;
  fee       bigint;
begin
  select * into booking from bookings where id = p_booking_id for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if booking.status <> 'pending_approval' then
    raise exception 'booking is not awaiting approval (status: %)', booking.status
      using errcode = 'EH056';
  end if;

  select * into ev from events where id = booking.event_id;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH055';
  end if;

  -- Reclaim lapsed holds before judging availability, otherwise abandoned
  -- checkouts make the room look full to the host saying yes.
  perform release_expired_holds(booking.ticket_type_id);

  select * into tt from ticket_types where id = booking.ticket_type_id for update;

  available := tt.quantity - tt.reserved_count;
  if available < booking.quantity then
    raise exception 'only % seats remain; cannot approve this request', available
      using errcode = 'check_violation';
  end if;

  subtotal := tt.price_paise * booking.quantity;
  -- Cash pays the ticket price at the door: no online fee to collect, no
  -- commission during the pilot -- the same zeroing reserve_tickets applies.
  fee := case when booking.payment_mode = 'cash' then 0 else p_convenience_fee_paise end;

  update ticket_types
     set reserved_count = reserved_count + booking.quantity
   where id = tt.id;

  if booking.payment_mode = 'cash' or subtotal + fee = 0 then
    -- Nothing to pay online: stamp the money and confirm straight from
    -- pending_approval. No awaiting_payment, no hold -- the seat is theirs.
    update bookings
       set approved_at = now(),
           subtotal_paise = subtotal,
           convenience_fee_paise = fee,
           total_paise = subtotal + fee,
           commission_paise = case when booking.payment_mode = 'cash' then 0
                                   else p_commission_paise end
     where id = p_booking_id;

    return confirm_booking(p_booking_id);
  end if;

  update bookings
     set status = 'awaiting_payment',
         approved_at = now(),
         subtotal_paise = subtotal,
         convenience_fee_paise = fee,
         total_paise = subtotal + fee,
         commission_paise = p_commission_paise,
         hold_expires_at = now() + make_interval(hours => p_hold_hours)
   where id = p_booking_id
  returning * into booking;

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- book_cash_tickets -- the cash mirror of book_free_tickets
-- ---------------------------------------------------------------------------
-- Reserve + confirm in one transaction: a cash booking is confirmed the
-- moment it is made -- the host opted into no-show risk by ticking the box,
-- and can free the seat by removing the guest. Commission is zeroed by
-- reserve_tickets for cash; the convenience fee stays at its 0 default.
--
--   EH054  this attendee already has an active booking on this event
--   EH057  the ticket type is free; the free path is the right door
--   EH058  the event requires approval; cash goes through a request instead
--   EH059  the event has already started
--
-- reserve_tickets itself refuses cash where allows_cash is false, with a
-- sentence already written for a human -- it passes through unmapped.
--
-- `extensions` on the search_path because confirm_booking needs pgcrypto's
-- gen_random_bytes for ticket codes, and it inherits this setting when
-- called from here (the book_free_tickets precedent).

create function book_cash_tickets(
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

  if tt.price_paise = 0 then
    raise exception 'this ticket type is free; use the free booking path'
      using errcode = 'EH057';
  end if;

  if ev.requires_approval then
    raise exception 'this event requires host approval; request instead'
      using errcode = 'EH058';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH059';
  end if;

  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH054';
  end if;

  -- Published status, the sales window, max_per_order, availability under the
  -- row lock, and the allows_cash refusal are reserve_tickets' job; its
  -- sentences pass through.
  booking := reserve_tickets(
    p_ticket_type_id => p_ticket_type_id,
    p_attendee_id    => p_attendee_id,
    p_quantity       => p_quantity,
    p_payment_mode   => 'cash',
    p_attendee_note  => p_attendee_note
  );

  -- reserve_tickets has no name parameter and should not grow one (see
  -- 20260810000003). Written here, inside the same transaction.
  update bookings
     set attendee_name = nullif(btrim(p_attendee_name), '')
   where id = booking.id;

  return confirm_booking(booking.id);

exception
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH054';
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- One order per booking's lifetime, now as a constraint
-- ---------------------------------------------------------------------------
-- Phase 3 stated the rule; Phase 5a leans on it (beginApprovedCheckout's
-- idempotency is a read-then-insert that this index makes race-safe, the
-- refunds_one_per_payment precedent). Every existing booking has at most one
-- payments row, so this backfills clean.

create unique index payments_one_per_booking on payments (booking_id);

-- ---------------------------------------------------------------------------
-- Lock down: service role only, never reachable over public RPC.
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default, so revoking from PUBLIC
-- removes it for everyone -- service_role included -- and each function has
-- to be granted back explicitly. approve_booking kept its signature, so its
-- existing revoke/grant survives the replace and is not restated.

revoke execute on function request_booking(uuid, uuid, integer, text, text, payment_mode)
  from public, anon, authenticated;
revoke execute on function book_cash_tickets(uuid, uuid, integer, text, text)
  from public, anon, authenticated;

grant execute on function request_booking(uuid, uuid, integer, text, text, payment_mode)
  to service_role;
grant execute on function book_cash_tickets(uuid, uuid, integer, text, text)
  to service_role;
```

- [ ] **Step 3: Apply it and regenerate types**

```bash
npx supabase migration up   # NOT db reset -- the dev DB holds kept evidence rows
npm run db:types
git diff --stat lib/supabase/types.ts   # should show request_booking's new Args, book_cash_tickets
```

- [ ] **Step 4: Write the failing approval-matrix tests**

`lib/bookings/approvals.test.ts`. Model setup on `lib/payments/begin-paid-booking.test.ts` (read it first). Teardown order matters — bookings before users (`ON DELETE RESTRICT`) — and one attendee can hold only one active booking per event, so tests that need two live requests mint a second attendee with `createTestUser`.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

async function reservedCount(ticketTypeId: string): Promise<number> {
  const { data } = await db.from('ticket_types').select('reserved_count').eq('id', ticketTypeId).single()
  return data!.reserved_count
}

describe('request_booking', () => {
  let paid: SeededEvent
  beforeAll(async () => {
    paid = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true, maxPerOrder: 3 })
  })
  afterAll(async () => {
    await cleanupEvent(db, paid)
  })

  it('stores the request without touching inventory', async () => {
    const before = await reservedCount(paid.ticketTypeId)
    const { data, error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Asha  ',
      p_attendee_note: 'first-timer, friend of Ravi',
      p_payment_mode: 'online',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'pending_approval',
      quantity: 2,
      subtotal_paise: 0,
      total_paise: 0,
      payment_mode: 'online',
      attendee_name: 'Asha',
      attendee_note: 'first-timer, friend of Ravi',
    })
    expect(data!.hold_expires_at).toBeNull()
    expect(await reservedCount(paid.ticketTypeId)).toBe(before)
    // a second request from the same attendee refuses
    const dup = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(dup.error?.code).toBe('EH054')
    await db.rpc('cancel_booking', { p_booking_id: data!.id, p_reason: 'test cleanup' })
  })

  it('refuses more seats than max_per_order with EH053', async () => {
    const { error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 4,
      p_attendee_name: 'Asha',
    })
    expect(error?.code).toBe('EH053')
  })

  it('refuses cash where the event does not allow it with EH052', async () => {
    const { error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
      p_payment_mode: 'cash',
    })
    expect(error?.code).toBe('EH052')
  })

  it('refuses a non-approval event with EH050 and a started one with EH051', async () => {
    const direct = await seedEvent(db, { pricePaise: 50_000 })
    const { error: eh050 } = await db.rpc('request_booking', {
      p_ticket_type_id: direct.ticketTypeId,
      p_attendee_id: direct.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(eh050?.code).toBe('EH050')
    await cleanupEvent(db, direct)

    const started = await seedEvent(db, { pricePaise: 50_000, requiresApproval: true })
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', started.eventId)
    const { error: eh051 } = await db.rpc('request_booking', {
      p_ticket_type_id: started.ticketTypeId,
      p_attendee_id: started.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(eh051?.code).toBe('EH051')
    await cleanupEvent(db, started)
  })

  it('allows a fresh request after a decline', async () => {
    const { data: first } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    await db.rpc('cancel_booking', { p_booking_id: first!.id, p_reason: 'declined by host' })
    const { data: second, error } = await db.rpc('request_booking', {
      p_ticket_type_id: paid.ticketTypeId,
      p_attendee_id: paid.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    expect(error).toBeNull()
    expect(second!.status).toBe('pending_approval')
    await db.rpc('cancel_booking', { p_booking_id: second!.id, p_reason: 'test cleanup' })
  })
})

describe('approve_booking', () => {
  it('online paid: reprices, takes inventory, sets the 24h hold', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 2,
      p_attendee_name: 'Asha',
    })
    const { data, error } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'awaiting_payment',
      subtotal_paise: 100_000,
      total_paise: 100_000,
      convenience_fee_paise: 0,
      commission_paise: 0,
    })
    expect(data!.approved_at).toBeTruthy()
    const holdMs = new Date(data!.hold_expires_at!).getTime() - Date.now()
    expect(holdMs).toBeGreaterThan(23 * 3600_000)
    expect(holdMs).toBeLessThan(25 * 3600_000)
    expect(await reservedCount(seed.ticketTypeId)).toBe(2)
    // approving again is EH056, not a double-take of inventory
    const again = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(again.error?.code).toBe('EH056')
    await cleanupEvent(db, seed)
  })

  it('free: confirms straight from pending_approval and issues tickets', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 0, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 2,
      p_attendee_name: 'Asha',
    })
    const { data, error } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'confirmed', total_paise: 0 })
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', data!.id)
    expect(count).toBe(2)
    await cleanupEvent(db, seed)
  })

  it('cash: confirms directly with fee and commission zeroed', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true, allowsCash: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
      p_payment_mode: 'cash',
    })
    // fee args passed on purpose: cash must zero them even when offered
    const { data, error } = await db.rpc('approve_booking', {
      p_booking_id: request!.id,
      p_convenience_fee_paise: 5_000,
      p_commission_paise: 5_000,
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'confirmed',
      payment_mode: 'cash',
      subtotal_paise: 50_000,
      total_paise: 50_000,
      convenience_fee_paise: 0,
      commission_paise: 0,
    })
    expect(data!.hold_expires_at).toBeNull()
    await cleanupEvent(db, seed)
  })

  it('refuses once the event has started with EH055', async () => {
    const seed = await seedEvent(db, { pricePaise: 50_000, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId,
      p_attendee_id: seed.attendeeId,
      p_quantity: 1,
      p_attendee_name: 'Asha',
    })
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', seed.eventId)
    const { error } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    expect(error?.code).toBe('EH055')
    await cleanupEvent(db, seed)
  })

  it('over-approval refuses with the seats-remaining sentence', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    const second = await createTestUser(db)
    const { data: a } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: seed.attendeeId,
      p_quantity: 1, p_attendee_name: 'Asha',
    })
    const { data: b } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: second,
      p_quantity: 1, p_attendee_name: 'Bala',
    })
    const first = await db.rpc('approve_booking', { p_booking_id: a!.id })
    expect(first.error).toBeNull()
    const overflow = await db.rpc('approve_booking', { p_booking_id: b!.id })
    expect(overflow.error?.message).toContain('seats remain')
    await db.from('bookings').delete().eq('id', b!.id)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(second).catch(() => {})
  })

  it('two concurrent approvals of the last seat: exactly one wins', async () => {
    const seed = await seedEvent(db, { quantity: 1, pricePaise: 50_000, requiresApproval: true })
    const second = await createTestUser(db)
    const { data: a } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: seed.attendeeId,
      p_quantity: 1, p_attendee_name: 'Asha',
    })
    const { data: b } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: second,
      p_quantity: 1, p_attendee_name: 'Bala',
    })
    const [ra, rb] = await Promise.all([
      db.rpc('approve_booking', { p_booking_id: a!.id }),
      db.rpc('approve_booking', { p_booking_id: b!.id }),
    ])
    const wins = [ra, rb].filter((r) => r.error === null)
    expect(wins).toHaveLength(1)
    expect(await reservedCount(seed.ticketTypeId)).toBe(1)
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(second).catch(() => {})
  })

  it('a lapsed 24h hold flows through release_expired_holds and frees the seat', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
    const { data: request } = await db.rpc('request_booking', {
      p_ticket_type_id: seed.ticketTypeId, p_attendee_id: seed.attendeeId,
      p_quantity: 2, p_attendee_name: 'Asha',
    })
    const { data: approved } = await db.rpc('approve_booking', { p_booking_id: request!.id })
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', approved!.id)
    await db.rpc('release_expired_holds')
    const { data: after } = await db.from('bookings').select('status').eq('id', approved!.id).single()
    expect(after!.status).toBe('expired')
    expect(await reservedCount(seed.ticketTypeId)).toBe(0)
    await cleanupEvent(db, seed)
  })
})
```

- [ ] **Step 5: Write the failing cash tests**

`lib/bookings/cash.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'

const db = adminClient()

describe('book_cash_tickets', () => {
  let cash: SeededEvent
  beforeAll(async () => {
    cash = await seedEvent(db, { quantity: 10, pricePaise: 50_000, allowsCash: true })
  })
  afterAll(async () => {
    await cleanupEvent(db, cash)
  })

  it('confirms in one transaction with commission zeroed and tickets issued', async () => {
    const { data, error } = await db.rpc('book_cash_tickets', {
      p_ticket_type_id: cash.ticketTypeId,
      p_attendee_id: cash.attendeeId,
      p_quantity: 2,
      p_attendee_name: '  Chitra  ',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'confirmed',
      payment_mode: 'cash',
      subtotal_paise: 100_000,
      total_paise: 100_000,
      convenience_fee_paise: 0,
      commission_paise: 0,
      attendee_name: 'Chitra',
    })
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', data!.id)
    expect(count).toBe(2)
    const { data: tt } = await db.from('ticket_types').select('reserved_count').eq('id', cash.ticketTypeId).single()
    expect(tt!.reserved_count).toBe(2)
    // cancelling returns the seats and creates no refunds row (no payment exists)
    await db.rpc('cancel_booking', { p_booking_id: data!.id, p_reason: 'test cleanup' })
    const { data: freed } = await db.from('ticket_types').select('reserved_count').eq('id', cash.ticketTypeId).single()
    expect(freed!.reserved_count).toBe(0)
  })

  it('refuses a free ticket with EH057, approval events with EH058, started with EH059', async () => {
    const free = await seedEvent(db, { pricePaise: 0, allowsCash: true })
    expect(
      (await db.rpc('book_cash_tickets', {
        p_ticket_type_id: free.ticketTypeId, p_attendee_id: free.attendeeId,
        p_quantity: 1, p_attendee_name: 'C',
      })).error?.code,
    ).toBe('EH057')
    await cleanupEvent(db, free)

    const approval = await seedEvent(db, { pricePaise: 50_000, allowsCash: true, requiresApproval: true })
    expect(
      (await db.rpc('book_cash_tickets', {
        p_ticket_type_id: approval.ticketTypeId, p_attendee_id: approval.attendeeId,
        p_quantity: 1, p_attendee_name: 'C',
      })).error?.code,
    ).toBe('EH058')
    await cleanupEvent(db, approval)

    const started = await seedEvent(db, { pricePaise: 50_000, allowsCash: true })
    await db.from('events').update({ starts_at: new Date(Date.now() - 3600_000).toISOString() }).eq('id', started.eventId)
    expect(
      (await db.rpc('book_cash_tickets', {
        p_ticket_type_id: started.ticketTypeId, p_attendee_id: started.attendeeId,
        p_quantity: 1, p_attendee_name: 'C',
      })).error?.code,
    ).toBe('EH059')
    await cleanupEvent(db, started)
  })

  it("passes reserve_tickets' cash refusal through where allows_cash is false", async () => {
    const noCash = await seedEvent(db, { pricePaise: 50_000, allowsCash: false })
    const { error } = await db.rpc('book_cash_tickets', {
      p_ticket_type_id: noCash.ticketTypeId, p_attendee_id: noCash.attendeeId,
      p_quantity: 1, p_attendee_name: 'C',
    })
    expect(error?.message).toContain('cash')
    await cleanupEvent(db, noCash)
  })
})
```

- [ ] **Step 6: Run the two new files; make them pass**

```bash
npx vitest run lib/bookings/approvals.test.ts lib/bookings/cash.test.ts
```

Expected: all pass against the applied migration. If a guard misfires, fix the SQL, re-apply with `npx supabase migration up` after a `drop`/`create` amendment inside the SAME migration file (it has not shipped anywhere).

- [ ] **Step 7: Full suite green, then commit**

```bash
npm test
git add supabase/migrations/20260811000004_approvals_and_cash.sql lib/supabase/types.ts lib/bookings/approvals.test.ts lib/bookings/cash.test.ts
git commit -m "feat: recreate the approval functions to convention and add cash bookings"
```

### Task 2: The pure units — error map, mayApprove, cash consequence

**Files:**
- Modify: `lib/bookings/rpc-errors.ts`
- Modify: `lib/bookings/authorize.ts`
- Modify: `lib/payments/refund-policy.ts`
- Test: extend `lib/bookings/authorize.test.ts`, `lib/payments/refund-policy.test.ts`, and the existing rpc-errors test file (locate with `npx vitest list | grep -i rpc-errors` or Glob; if none exists for `lib/bookings/rpc-errors.ts`, create `lib/bookings/rpc-errors.test.ts`)

**Interfaces:**
- Consumes: `Caller` (`lib/bookings/caller.ts`), `formatPaise` (`lib/money.ts`).
- Produces:
  - `mapBookingRpcError(error: PostgrestError): string` — now also maps EH050–EH059.
  - `mayApprove(caller: Caller, booking: { event_host_profile_id: string }): boolean` — host of this event only.
  - `cancelConsequence(input: { initiator, totalPaise, startsAt, cutoffHours, paymentMode?, now? }): string | null` — `paymentMode: 'cash'` → `null` (no money moves; the free-booking precedent). The parameter is optional so existing call sites compile unchanged.

- [ ] **Step 1: Write the failing unit tests**

Append to `lib/bookings/authorize.test.ts` (it exists — `mayCancel` is "unit-tested exhaustively"; mirror its style):

```ts
describe('mayApprove', () => {
  const host = { id: 'host-profile' } as unknown as Caller
  const attendee = { id: 'attendee' } as unknown as Caller
  const blank = { id: '' } as unknown as Caller

  it('allows only the host of the event', () => {
    expect(mayApprove(host, { event_host_profile_id: 'host-profile' })).toBe(true)
    expect(mayApprove(attendee, { event_host_profile_id: 'host-profile' })).toBe(false)
  })
  it('never matches an absent id against an absent column', () => {
    expect(mayApprove(blank, { event_host_profile_id: '' })).toBe(false)
  })
})
```

Append to `lib/payments/refund-policy.test.ts`:

```ts
describe('cancelConsequence for cash', () => {
  it('promises nothing when the money never moved', () => {
    expect(
      cancelConsequence({
        initiator: 'host',
        totalPaise: 50_000,
        startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
        cutoffHours: 24,
        paymentMode: 'cash',
      }),
    ).toBeNull()
  })
  it('still promises the refund for online money', () => {
    expect(
      cancelConsequence({
        initiator: 'host',
        totalPaise: 50_000,
        startsAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
        cutoffHours: 24,
        paymentMode: 'online',
      }),
    ).toBe('Removing refunds ₹500 in full.')
  })
})
```

rpc-errors tests (extend or create; assert exact sentences):

```ts
import { describe, expect, it } from 'vitest'
import type { PostgrestError } from '@supabase/supabase-js'
import { mapBookingRpcError } from '@/lib/bookings/rpc-errors'

const err = (code: string, message = 'raw postgres text'): PostgrestError =>
  ({ code, message, details: '', hint: '', name: 'PostgrestError' }) as PostgrestError

describe('mapBookingRpcError EH05x', () => {
  it('maps every Phase 5a code to a sentence', () => {
    expect(mapBookingRpcError(err('EH050'))).toBe("This event doesn't take requests — book it directly.")
    expect(mapBookingRpcError(err('EH051'))).toBe('This event has already started.')
    expect(mapBookingRpcError(err('EH052'))).toBe("This event doesn't take cash bookings.")
    expect(mapBookingRpcError(err('EH053'))).toBe("That's more seats than this event allows per booking.")
    expect(mapBookingRpcError(err('EH054'))).toBe('You have already booked this event. Cancel that booking first to change it.')
    expect(mapBookingRpcError(err('EH055'))).toBe('This event has already started.')
    expect(mapBookingRpcError(err('EH056'))).toBe('This request was already handled — refresh to see where it stands.')
    expect(mapBookingRpcError(err('EH057'))).toBe('This event is free — book it without paying.')
    expect(mapBookingRpcError(err('EH058'))).toBe('This host approves guests first — send a request instead.')
    expect(mapBookingRpcError(err('EH059'))).toBe('This event has already started.')
  })
  it('passes unmapped refusals through', () => {
    expect(mapBookingRpcError(err('23514', 'only 3 seats remain'))).toBe('only 3 seats remain')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run lib/bookings/authorize.test.ts lib/payments/refund-policy.test.ts lib/bookings/rpc-errors.test.ts
```

Expected: FAIL — `mayApprove` not exported, `paymentMode` not a parameter, EH05x unmapped.

- [ ] **Step 3: Implement**

`lib/bookings/rpc-errors.ts` — add below the existing constants (keep the file's comment style):

```ts
/** Phase 5a: the request/approve/cash block. */
const NOT_AN_APPROVAL_EVENT = 'EH050'
const REQUEST_STARTED = 'EH051'
const CASH_NOT_ALLOWED = 'EH052'
const OVER_MAX_PER_ORDER = 'EH053'
const ALREADY_ACTIVE = 'EH054'
const APPROVE_STARTED = 'EH055'
const NOT_PENDING = 'EH056'
const CASH_ON_FREE = 'EH057'
const CASH_NEEDS_APPROVAL = 'EH058'
const CASH_STARTED = 'EH059'
```

and in `mapBookingRpcError`, before the final passthrough:

```ts
  if (error.code === NOT_AN_APPROVAL_EVENT) return "This event doesn't take requests — book it directly."
  if (error.code === REQUEST_STARTED || error.code === APPROVE_STARTED || error.code === CASH_STARTED) {
    return 'This event has already started.'
  }
  if (error.code === CASH_NOT_ALLOWED) return "This event doesn't take cash bookings."
  if (error.code === OVER_MAX_PER_ORDER) return "That's more seats than this event allows per booking."
  if (error.code === ALREADY_ACTIVE) {
    return 'You have already booked this event. Cancel that booking first to change it.'
  }
  if (error.code === NOT_PENDING) return 'This request was already handled — refresh to see where it stands.'
  if (error.code === CASH_ON_FREE) return 'This event is free — book it without paying.'
  if (error.code === CASH_NEEDS_APPROVAL) return 'This host approves guests first — send a request instead.'
```

`lib/bookings/authorize.ts` — append:

```ts
/** The fields of a booking that decide who may approve or decline its request. */
export interface ApprovableBooking {
  /** `profiles.id` of the host who owns the event this request is for. */
  event_host_profile_id: string
}

/**
 * Who may approve or decline a request: the host whose event it is, and
 * nobody else — the attendee withdraws via cancelBooking, which mayCancel
 * already permits. Pure and separately tested for the same reason mayCancel
 * is: the write goes through the service role, so this function is the whole
 * of the rule.
 */
export function mayApprove(caller: Caller, booking: ApprovableBooking): boolean {
  // An absent id must never match an absent column. Two blanks are equal.
  if (!caller.id) return false
  return caller.id === booking.event_host_profile_id
}
```

`lib/payments/refund-policy.ts` — `cancelConsequence` gains the mode:

```ts
/** What the cancel tap will do to the money, stated before the tap. Null when no money moved. */
export function cancelConsequence(input: {
  initiator: CancelInitiator
  totalPaise: number
  startsAt: string
  cutoffHours: number
  /** 'cash' means no money ever moved online, so there is nothing to promise. */
  paymentMode?: 'online' | 'cash'
  now?: Date
}): string | null {
  if (input.totalPaise === 0) return null
  if (input.paymentMode === 'cash') return null
  if (input.initiator === 'host') return `Removing refunds ${formatPaise(input.totalPaise)} in full.`
  return refundDecision(input) === 'full'
    ? `You'll be refunded ${formatPaise(input.totalPaise)}.`
    : 'Past the refund window — no refund.'
}
```

- [ ] **Step 4: Run to verify they pass, then the full suite**

```bash
npx vitest run lib/bookings/authorize.test.ts lib/payments/refund-policy.test.ts lib/bookings/rpc-errors.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add lib/bookings/rpc-errors.ts lib/bookings/authorize.ts lib/payments/refund-policy.ts lib/bookings/authorize.test.ts lib/payments/refund-policy.test.ts lib/bookings/rpc-errors.test.ts
git commit -m "feat: EH05x sentences, mayApprove, and the cash branch of cancelConsequence"
```

---

### Task 3: The booking service — request, approve, decline, cash

**Files:**
- Modify: `lib/bookings/service.ts`
- Test: `lib/bookings/approvals-service.test.ts`

**Interfaces:**
- Consumes: `mayApprove` (Task 2), `mapBookingRpcError` (Task 2), the Task 1 RPCs, `createAdminClient`, `Caller`.
- Produces (Tasks 6–8 call these from Server Actions):
  - `requestBooking(caller: Caller, ticketTypeId: string, quantity: number, attendeeName: string, paymentMode: 'online' | 'cash', note?: string): Promise<BookingResult>`
  - `bookCashTickets(caller: Caller, ticketTypeId: string, quantity: number, attendeeName: string, note?: string): Promise<BookingResult>`
  - `approveBooking(caller: Caller, bookingId: string): Promise<ApproveResult>` where `export type ApproveResult = { ok: true } | { ok: false; error: string }`
  - `declineBooking(caller: Caller, bookingId: string): Promise<ApproveResult>`

- [ ] **Step 1: Write the failing tests**

`lib/bookings/approvals-service.test.ts`. Before writing it, read one existing service-level test that exercises `cancelBooking` authorisation (Grep for `cancelBooking` under `lib/bookings/*.test.ts`) and mirror how it mints `Caller`s — the cast below is the established test-only escape hatch:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import type { Caller } from '@/lib/bookings/caller'
import { approveBooking, declineBooking, requestBooking, bookCashTickets, cancelBooking } from '@/lib/bookings/service'

const db = adminClient()
const asCaller = (id: string) => ({ id }) as unknown as Caller

describe('the approval service', () => {
  let seed: SeededEvent
  let stranger: string
  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
    stranger = await createTestUser(db)
  })
  afterAll(async () => {
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
    await db.auth.admin.deleteUser(stranger).catch(() => {})
  })

  it('requests as the caller, never as a form value', async () => {
    const result = await requestBooking(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online', 'note')
    expect(result.ok).toBe(true)
    const { data } = await db.from('bookings').select('attendee_id, status').eq('event_id', seed.eventId).single()
    expect(data).toMatchObject({ attendee_id: seed.attendeeId, status: 'pending_approval' })
  })

  it('refuses approval from a stranger and from the attendee themselves', async () => {
    const { data: booking } = await db.from('bookings').select('id').eq('event_id', seed.eventId).single()
    for (const who of [stranger, seed.attendeeId]) {
      const result = await approveBooking(asCaller(who), booking!.id)
      expect(result).toEqual({ ok: false, error: 'That request is not yours to decide.' })
    }
    const { data: after } = await db.from('bookings').select('status').eq('id', booking!.id).single()
    expect(after!.status).toBe('pending_approval')
  })

  it('approves as the host', async () => {
    const { data: booking } = await db.from('bookings').select('id').eq('event_id', seed.eventId).single()
    const result = await approveBooking(asCaller(seed.hostProfileId), booking!.id)
    expect(result).toEqual({ ok: true })
    const { data: after } = await db.from('bookings').select('status, approved_at').eq('id', booking!.id).single()
    expect(after!.status).toBe('awaiting_payment')
    expect(after!.approved_at).toBeTruthy()
    await db.rpc('cancel_booking', { p_booking_id: booking!.id, p_reason: 'test cleanup' })
  })

  it('declines with the stored reason and without a refunds row', async () => {
    const request = await requestBooking(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(request.ok).toBe(true)
    const { data: booking } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'pending_approval').single()

    const refused = await declineBooking(asCaller(stranger), booking!.id)
    expect(refused.ok).toBe(false)

    const declined = await declineBooking(asCaller(seed.hostProfileId), booking!.id)
    expect(declined).toEqual({ ok: true })
    const { data: after } = await db
      .from('bookings').select('status, cancellation_reason').eq('id', booking!.id).single()
    expect(after).toMatchObject({ status: 'cancelled', cancellation_reason: 'declined by host' })

    const again = await declineBooking(asCaller(seed.hostProfileId), booking!.id)
    expect(again.ok).toBe(false) // already handled — not pending any more
  })

  it('lets the attendee withdraw their own request via cancelBooking', async () => {
    const request = await requestBooking(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Asha', 'online')
    expect(request.ok).toBe(true)
    const { data: booking } = await db
      .from('bookings').select('id').eq('event_id', seed.eventId).eq('status', 'pending_approval').single()
    const result = await cancelBooking(asCaller(seed.attendeeId), booking!.id, 'attendee')
    expect(result).toEqual({ ok: true })
  })
})

describe('the cash service', () => {
  it('books and the host removal creates no refund', async () => {
    const seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, allowsCash: true })
    const booked = await bookCashTickets(asCaller(seed.attendeeId), seed.ticketTypeId, 1, 'Chitra')
    expect(booked.ok).toBe(true)
    const { data: booking } = await db.from('bookings').select('id').eq('event_id', seed.eventId).single()
    const removed = await cancelBooking(asCaller(seed.hostProfileId), booking!.id, 'host')
    expect(removed).toEqual({ ok: true })
    const { count } = await db.from('refunds').select('*', { count: 'exact', head: true })
    // no refund row was created FOR THIS BOOKING: scope by reading payments first
    const { data: payments } = await db.from('payments').select('id').eq('booking_id', booking!.id)
    expect(payments).toHaveLength(0)
    expect(count).toBeGreaterThanOrEqual(0) // sanity only; the real assertion is the empty payments list
    const { data: after } = await db.from('bookings').select('status').eq('id', booking!.id).single()
    expect(after!.status).toBe('cancelled') // cancelled, never 'refunded' — no money moved
    await cleanupEvent(db, seed)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/bookings/approvals-service.test.ts
```

Expected: FAIL — the four functions are not exported.

- [ ] **Step 3: Implement in `lib/bookings/service.ts`**

Add beside the existing exports (`mayApprove` joins the `mayCancel` import; the file keeps its header essay unchanged):

```ts
/** One refusal for approve and decline alike — "not yours", "does not exist"
 *  and "the lookup failed" must be indistinguishable from outside. */
const NOT_YOURS_TO_DECIDE = 'That request is not yours to decide.'

export type ApproveResult = { ok: true } | { ok: false; error: string }

export async function requestBooking(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  paymentMode: 'online' | 'cash',
  note?: string,
): Promise<BookingResult> {
  const db = createAdminClient()
  const { data, error } = await db.rpc('request_booking', {
    p_ticket_type_id: ticketTypeId,
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
    p_attendee_note: note,
    p_payment_mode: paymentMode,
  })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: data.reference }
}

export async function bookCashTickets(
  caller: Caller,
  ticketTypeId: string,
  quantity: number,
  attendeeName: string,
  note?: string,
): Promise<BookingResult> {
  const db = createAdminClient()
  const { data, error } = await db.rpc('book_cash_tickets', {
    p_ticket_type_id: ticketTypeId,
    p_attendee_id: caller.id,
    p_quantity: quantity,
    p_attendee_name: attendeeName,
    p_attendee_note: note,
  })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true, reference: data.reference }
}

/** The host-scoped read approve and decline share: the booking's status and
 *  its event's host, in one round trip, service-role like every read that
 *  precedes a service-role write. Null means "refuse with the one sentence". */
async function readForDecision(
  db: ReturnType<typeof createAdminClient>,
  bookingId: string,
): Promise<{ status: string; event_host_profile_id: string } | null> {
  const { data: booking, error } = await db
    .from('bookings')
    .select('status, events(hosts(profile_id))')
    .eq('id', bookingId)
    .maybeSingle()
  if (error) {
    console.error('[bookings] could not read booking for an approval decision', error)
    return null
  }
  if (!booking) return null
  return { status: booking.status, event_host_profile_id: booking.events.hosts.profile_id }
}

export async function approveBooking(caller: Caller, bookingId: string): Promise<ApproveResult> {
  const db = createAdminClient()
  const booking = await readForDecision(db, bookingId)
  if (!booking || !mayApprove(caller, booking)) {
    return { ok: false, error: NOT_YOURS_TO_DECIDE }
  }
  // Fees deliberately not passed: they stay 0 this pilot and the RPC's
  // defaults do it. approve_booking's fee parameters are the future wiring
  // point for lib/pricing, not this call's business.
  const { error } = await db.rpc('approve_booking', { p_booking_id: bookingId })
  if (error) return { ok: false, error: mapBookingRpcError(error) }
  return { ok: true }
}

export async function declineBooking(caller: Caller, bookingId: string): Promise<ApproveResult> {
  const db = createAdminClient()
  const booking = await readForDecision(db, bookingId)
  if (!booking || !mayApprove(caller, booking)) {
    return { ok: false, error: NOT_YOURS_TO_DECIDE }
  }
  // Declining is only meaningful while the request is pending. Anything else
  // already left the queue — say so rather than cancelling a paid seat under
  // a button labelled Decline.
  if (booking.status !== 'pending_approval') {
    return { ok: false, error: 'This request was already handled — refresh to see where it stands.' }
  }
  const { error } = await db.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_reason: 'declined by host',
  })
  if (error) return { ok: false, error: error.message }
  // No refundIfOwed: a pending_approval booking cannot have a payment — the
  // order is only ever created after approval.
  return { ok: true }
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

```bash
npx vitest run lib/bookings/approvals-service.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add lib/bookings/service.ts lib/bookings/approvals-service.test.ts
git commit -m "feat: request, approve, decline and cash-book through the booking service"
```

---

### Task 4: The reads — booking columns, the request queue, the unpaid strip

**Files:**
- Modify: `lib/bookings/queries.ts`
- Test: `lib/bookings/approval-queries.test.ts`

**Interfaces:**
- Consumes: the RLS policies as they stand (no policy changes in this phase — `bookings_select_for_host` and `profiles_select_for_host` already cover the new reads), `tests/helpers/db.ts`, `userClient`.
- Produces (Tasks 7–8 render these):
  - `BOOKING_COLUMNS` grows `attendee_id, attendee_note, payment_mode, approved_at, cancellation_reason` and the events embed grows `venue_address, hide_venue_until_approved`; `MyBooking` matches.
  - `listEventRequests(eventId): Promise<EventRequest[]>` — `pending_approval` rows, oldest first, host-scoped.
  - `listApprovedUnpaid(eventId): Promise<ApprovedUnpaid[]>` — `awaiting_payment` rows with `approved_at` set, host-scoped.

- [ ] **Step 1: Write the failing tests**

`lib/bookings/approval-queries.test.ts`. These functions run on the RLS-scoped *server* client (`lib/supabase/server.ts` needs cookies), so test them the way the existing queries are tested — find that file first (Grep `listEventAttendees` under `lib/` and `app/` `*.test.ts`) and mirror its session installation exactly. If the existing pattern instead tests the underlying query shape via `userClient`, mirror that: the assertions below are what matter —

```ts
// Shape of the assertions, whatever the session mechanics:
// 1. the host of the event sees the pending_approval rows from listEventRequests,
//    oldest first, each carrying attendee_name, attendee_note, payment_mode,
//    quantity and profiles.phone;
// 2. a stranger (another signed-in user) gets [] from both new functions;
// 3. listApprovedUnpaid returns ONLY awaiting_payment rows that have
//    approved_at set — a Phase 3 checkout hold (awaiting_payment, approved_at
//    null) on the same event must NOT appear;
// 4. listEventAttendees still returns only confirmed rows (the load-bearing
//    filter did not loosen) and now carries payment_mode.
```

Seed: one approval event; one `request_booking` row; one approved-unpaid (request → `approve_booking` on a paid event); one `begin_paid_booking` hold from a second attendee (the approved_at-null decoy); one confirmed cash booking via `book_cash_tickets` on a second, `allowsCash` event.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/bookings/approval-queries.test.ts
```

- [ ] **Step 3: Implement in `lib/bookings/queries.ts`**

The new column string:

```ts
const BOOKING_COLUMNS =
  'id, reference, quantity, status, created_at, total_paise, hold_expires_at, attendee_id, attendee_name, attendee_note, payment_mode, approved_at, cancellation_reason, events(id, slug, title, starts_at, city, venue_name, venue_address, hide_venue_until_approved, refund_cutoff_hours), payments(provider_order_id, status)'
```

`MyBooking` gains the matching fields:

```ts
  attendee_id: string
  attendee_note: string | null
  payment_mode: string
  approved_at: string | null
  cancellation_reason: string | null
  // and inside events:
  venue_address: string | null
  hide_venue_until_approved: boolean
```

`listEventAttendees`' select string gains `payment_mode` and `EventAttendee` gains `payment_mode: string`.

The two new reads, sharing `listEventAttendees`' scoping (the `events!inner(hosts!inner(profile_id))` hop IS the meaning of "hosts it" — copy its comment block's reasoning, do not reinvent it):

```ts
export interface EventRequest {
  id: string
  reference: string
  attendee_name: string | null
  attendee_note: string | null
  payment_mode: string
  quantity: number
  created_at: string
  profiles: { phone: string } | null
}

/** Pending requests for one event, oldest first — the host's approval queue.
 *  Empty unless the caller hosts it, by the same !inner scoping as the guest
 *  list. */
export async function listEventRequests(eventId: string): Promise<EventRequest[]> {
  const session = await signedInClient()
  if (!session) return []

  const { data, error } = await session.supabase
    .from('bookings')
    .select(
      'id, reference, attendee_name, attendee_note, payment_mode, quantity, created_at, profiles(phone), events!inner(hosts!inner(profile_id))',
    )
    .eq('event_id', eventId)
    .eq('events.hosts.profile_id', session.userId)
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Could not load the requests: ${error.message}`)
  return (data ?? []) as unknown as EventRequest[]
}

export interface ApprovedUnpaid {
  id: string
  reference: string
  attendee_name: string | null
  quantity: number
  total_paise: number
  hold_expires_at: string | null
  profiles: { phone: string } | null
}

/** Approved but not yet paid: awaiting_payment rows that carry approved_at.
 *  The approved_at filter is load-bearing — a Phase 3 checkout hold is also
 *  awaiting_payment and must not read as an approval to chase. */
export async function listApprovedUnpaid(eventId: string): Promise<ApprovedUnpaid[]> {
  const session = await signedInClient()
  if (!session) return []

  const { data, error } = await session.supabase
    .from('bookings')
    .select(
      'id, reference, attendee_name, quantity, total_paise, hold_expires_at, profiles(phone), events!inner(hosts!inner(profile_id))',
    )
    .eq('event_id', eventId)
    .eq('events.hosts.profile_id', session.userId)
    .eq('status', 'awaiting_payment')
    .not('approved_at', 'is', null)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Could not load the approved bookings: ${error.message}`)
  return (data ?? []) as unknown as ApprovedUnpaid[]
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

```bash
npx vitest run lib/bookings/approval-queries.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add lib/bookings/queries.ts lib/bookings/approval-queries.test.ts
git commit -m "feat: the approval queue reads and the widened booking columns"
```

---

### Task 5: beginApprovedCheckout — the approval joins the Phase 3 rails

**Files:**
- Modify: `lib/payments/service.ts`
- Test: `lib/payments/approved-checkout.test.ts`

**Interfaces:**
- Consumes: `razorpayProvider` (mocked via `vi.mock('@/lib/payments/razorpay')` + `fakeProvider` from `tests/helpers/payments.ts`), the Task 1 RPCs, `payments_one_per_booking` (Task 1), `capturedEvent` fixture builder and `processWebhookEvent` for the join test.
- Produces (Task 7's action calls this):
  - `beginApprovedCheckout(caller: Caller, bookingId: string): Promise<ApprovedCheckoutStart>` where `export type ApprovedCheckoutStart = { ok: true } | { ok: false; error: string }` — owner-only; requires `awaiting_payment` + `approved_at` + `payment_mode 'online'` + a live hold; creates the order and `payments` row once; a second call (or a lost race) returns `{ ok: true }` without a second order; **never cancels the booking on failure**.

- [ ] **Step 1: Write the failing tests**

`lib/payments/approved-checkout.test.ts`. Model the mock plumbing on `lib/payments/cancel-refunds.test.ts` (read it first — `vi.mock` before a top-level `await import`):

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

async function approvedBooking(seed: SeededEvent): Promise<{ id: string; reference: string; total: number }> {
  const { data: request } = await db.rpc('request_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: seed.attendeeId,
    p_quantity: 1,
    p_attendee_name: 'Asha',
  })
  const { data: approved } = await db.rpc('approve_booking', { p_booking_id: request!.id })
  return { id: approved!.id, reference: approved!.reference, total: approved!.total_paise }
}

describe('beginApprovedCheckout', () => {
  let seed: SeededEvent
  let provider: ReturnType<typeof fakeProvider>

  beforeAll(async () => {
    seed = await seedEvent(db, { quantity: 10, pricePaise: 50_000, requiresApproval: true })
  })
  beforeEach(() => {
    provider = fakeProvider()
    vi.mocked(razorpayProvider).mockReturnValue(provider)
  })
  afterAll(async () => {
    await db.from('payments').delete().neq('id', crypto.randomUUID())  // this file's rows; see the cleanup note in cancel-refunds.test.ts
    await db.from('bookings').delete().eq('event_id', seed.eventId)
    await cleanupEvent(db, seed)
  })

  it('creates the order once; the second call reuses it', async () => {
    const booking = await approvedBooking(seed)
    const first = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(first).toEqual({ ok: true })
    const second = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(second).toEqual({ ok: true })
    expect(provider.createOrder).toHaveBeenCalledTimes(1)
    const { data: payments } = await db.from('payments').select('amount_paise, status').eq('booking_id', booking.id)
    expect(payments).toHaveLength(1)
    expect(payments![0]).toMatchObject({ amount_paise: booking.total, status: 'created' })
    await db.from('payments').delete().eq('booking_id', booking.id)
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'test cleanup' })
  })

  it('refuses everyone but the attendee, and every state but approved-awaiting-online', async () => {
    const booking = await approvedBooking(seed)
    const stranger = await createTestUser(db)

    expect((await beginApprovedCheckout(asCaller(stranger), booking.id)).ok).toBe(false)
    expect((await beginApprovedCheckout(asCaller(seed.hostProfileId), booking.id)).ok).toBe(false)

    // lapsed hold
    await db.from('bookings').update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', booking.id)
    expect((await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)).ok).toBe(false)
    expect(provider.createOrder).not.toHaveBeenCalled()

    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'test cleanup' })
    await db.auth.admin.deleteUser(stranger).catch(() => {})
  })

  it('a failed order leaves the booking approved and retryable — never cancelled', async () => {
    const booking = await approvedBooking(seed)
    provider.createOrder.mockRejectedValueOnce(new Error('razorpay down'))
    const failed = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(failed.ok).toBe(false)
    const { data: after } = await db.from('bookings').select('status, approved_at').eq('id', booking.id).single()
    expect(after!.status).toBe('awaiting_payment')   // NOT cancelled
    expect(after!.approved_at).toBeTruthy()
    const retried = await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    expect(retried).toEqual({ ok: true })
    await db.from('payments').delete().eq('booking_id', booking.id)
    await db.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: 'test cleanup' })
  })

  it('the join: order → captured webhook → confirmed with tickets', async () => {
    const booking = await approvedBooking(seed)
    await beginApprovedCheckout(asCaller(seed.attendeeId), booking.id)
    const { data: payment } = await db.from('payments').select('provider_order_id').eq('booking_id', booking.id).single()

    await processWebhookEvent(
      capturedEvent({ orderId: payment!.provider_order_id, amountPaise: booking.total }),
    )

    const { data: after } = await db.from('bookings').select('status').eq('id', booking.id).single()
    expect(after!.status).toBe('confirmed')
    const { count } = await db.from('tickets').select('*', { count: 'exact', head: true }).eq('booking_id', booking.id)
    expect(count).toBe(1)
    // teardown order: receipts and refunds before payments before cleanupEvent
    await db.from('provider_webhook_events').delete().neq('id', crypto.randomUUID())
    await db.from('payments').delete().eq('booking_id', booking.id)
  })
})
```

**Before running:** open `tests/helpers/payments.ts` and check `capturedEvent`'s actual parameter names (`orderId`/`amountPaise` above are the believed shape; the helper is the authority — adjust the call, not the helper). Same for `fakeProvider`'s mock function names.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/payments/approved-checkout.test.ts
```

Expected: FAIL — `beginApprovedCheckout` is not exported.

- [ ] **Step 3: Implement in `lib/payments/service.ts`**

Below `startPaidCheckout` (it shares `NOT_CONFIGURED` and `COULD_NOT_START`):

```ts
export type ApprovedCheckoutStart = { ok: true } | { ok: false; error: string }

/** One refusal for "not yours", "does not exist" and "the lookup failed". */
const NOT_YOURS_TO_PAY = 'That booking is not yours to pay for.'
const NOT_PAYABLE = 'There is nothing to pay on this booking right now.'

/**
 * The missing piece between an approval and the Phase 3 rails: the Razorpay
 * order, created lazily on the explicit Pay tap — never on a page load — for
 * a booking approve_booking left awaiting_payment. Once the payments row
 * exists, the existing CheckoutPanel, first-poll proof, webhook and
 * reconcile paths run unchanged.
 *
 * Idempotent by the payments_one_per_booking index: a second tap (or a lost
 * race) finds or collides with the existing row and reports ok — one order
 * per booking's lifetime, Phase 3's rule.
 *
 * Unlike startPaidCheckout, a failure here never cancels the booking: the
 * approval hold is the host's yes, and it must survive a Razorpay outage so
 * the attendee can retry inside the 24-hour window.
 */
export async function beginApprovedCheckout(
  caller: Caller,
  bookingId: string,
): Promise<ApprovedCheckoutStart> {
  let provider: PaymentProvider
  try {
    provider = razorpayProvider()
  } catch (error) {
    console.error('[payments] beginApprovedCheckout refused: Razorpay env vars missing', error)
    return { ok: false, error: NOT_CONFIGURED }
  }

  const db = createAdminClient()

  const { data: booking, error } = await db
    .from('bookings')
    .select('id, attendee_id, status, total_paise, reference, approved_at, payment_mode, hold_expires_at')
    .eq('id', bookingId)
    .maybeSingle()
  if (error) {
    console.error('[payments] could not read the booking for an approved checkout', error)
    return { ok: false, error: NOT_YOURS_TO_PAY }
  }
  // Same answer for missing and not-theirs — no oracle for strangers.
  if (!booking || booking.attendee_id !== caller.id) return { ok: false, error: NOT_YOURS_TO_PAY }

  if (
    booking.status !== 'awaiting_payment' ||
    !booking.approved_at ||
    booking.payment_mode !== 'online' ||
    !booking.hold_expires_at ||
    new Date(booking.hold_expires_at).getTime() <= Date.now()
  ) {
    return { ok: false, error: NOT_PAYABLE }
  }

  const { data: existing, error: existingError } = await db
    .from('payments')
    .select('id')
    .eq('booking_id', booking.id)
    .maybeSingle()
  if (existingError) {
    console.error('[payments] could not read payments for an approved checkout', existingError)
    return { ok: false, error: COULD_NOT_START }
  }
  if (existing) return { ok: true }

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
    if (insertError) {
      // Two taps raced past the read: payments_one_per_booking let exactly
      // one insert win, and the loser's order dies unpaid at Razorpay. The
      // attendee has an order either way.
      if (insertError.code === '23505') return { ok: true }
      throw new Error(`could not record the order: ${insertError.message}`)
    }
  } catch (cause) {
    console.error('[payments] approved checkout could not start; the Pay button retries', cause)
    return { ok: false, error: COULD_NOT_START }
  }

  return { ok: true }
}
```

- [ ] **Step 4: Run to verify pass, then the full suite**

```bash
npx vitest run lib/payments/approved-checkout.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add lib/payments/service.ts lib/payments/approved-checkout.test.ts
git commit -m "feat: beginApprovedCheckout joins approvals to the checkout rails"
```

### Task 6: The public event page — request to join, pay cash at the door

**Files:**
- Modify: `app/e/[slug]/actions.ts`
- Create: `app/e/[slug]/request-panel.tsx`
- Modify: `app/e/[slug]/book-panel.tsx`
- Modify: `app/e/[slug]/page.tsx`
- Test: `app/e/[slug]/request-actions.test.ts`

**Interfaces:**
- Consumes: `requestBooking`, `bookCashTickets` (Task 3), the existing `BookState`, `currentCaller`, `loginPath`.
- Produces: `requestToJoin(previous: BookState, formData: FormData): Promise<BookState>` and `bookCashEvent(previous: BookState, formData: FormData): Promise<BookState>` — both redirect to `/bookings/{reference}` on success.

- [ ] **Step 1: Write the failing action tests**

`app/e/[slug]/request-actions.test.ts`. Model the mock plumbing on `app/bookings/actions.test.ts` (read it first — `vi.mock` for `next/navigation`, `next/cache`, `@/lib/bookings/caller`, `@/lib/auth/session`, and the service module, then top-level `await import`). Assert:

```ts
// 1. signed out → redirect(loginPath()) for both actions;
// 2. requestToJoin passes (ticketTypeId, quantity, trimmed name capped at 80,
//    mode from paymentMode field defaulting to 'online', note trimmed capped
//    at 280 and undefined when blank) to requestBooking, with the caller —
//    never a form value — as identity;
// 3. a service refusal surfaces as { error: sentence } without redirecting;
// 4. success calls redirect('/bookings/REF'); requestToJoin does NOT
//    revalidate the event page or the feed (a request moves no inventory),
//    while bookCashEvent revalidates `/e/{slug}` and '/' (a cash booking
//    does) before redirecting;
// 5. junk quantity ('abc', 0) → { error: 'Choose how many seats you need.' }.
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run app/e/[slug]/request-actions.test.ts
```

- [ ] **Step 3: Implement the actions**

Append to `app/e/[slug]/actions.ts` (the three field reads are `bookEvent`'s, kept character for character — the actions must refuse the same mistake with the same sentence; the reasons are documented once, on `bookEvent`):

```ts
export async function requestToJoin(_previous: BookState, formData: FormData): Promise<BookState> {
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

  // The note is the request's pitch — optional, capped like the name is, and
  // omitted rather than sent as ''. The mode is a two-value parse: anything
  // that is not the literal 'cash' is online, so a handcrafted POST cannot
  // invent a third mode.
  const note = String(formData.get('note') ?? '').trim().slice(0, 280) || undefined
  const paymentMode = formData.get('paymentMode') === 'cash' ? ('cash' as const) : ('online' as const)

  const result = await requestBooking(caller, ticketTypeId, quantity, attendeeName, paymentMode, note)
  if (!result.ok) return { error: result.error }

  // No revalidatePath pair here, unlike bookEvent: a request moves no
  // inventory, so neither the event payload nor the feed changed.
  redirect(`/bookings/${result.reference}`)
}

export async function bookCashEvent(_previous: BookState, formData: FormData): Promise<BookState> {
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

  const result = await bookCashTickets(caller, ticketTypeId, quantity, attendeeName)
  if (!result.ok) return { error: result.error }

  // The same pair as bookEvent, for the same reasons (see the essay above):
  // a cash booking reserves and confirms, so reserved_count just moved.
  const slug = String(formData.get('slug') ?? '')
  if (slug) revalidatePath(`/e/${slug}`)
  revalidatePath('/')
  redirect(`/bookings/${result.reference}`)
}
```

(Imports: `requestBooking`, `bookCashTickets` join the existing `bookFreeTickets` import from `@/lib/bookings/service`.)

- [ ] **Step 4: The request panel**

`app/e/[slug]/request-panel.tsx` — a taller cousin of `BookPanel` (the bottom bar stays; the note needs a block layout):

```tsx
'use client'

import { useActionState, useState } from 'react'
import { requestToJoin, type BookState } from './actions'

interface Props {
  ticketTypeId: string
  slug: string
  /** Upper bound of the picker: min(max_per_order, quantity) — NOT seats
   *  remaining. Requests stay open at capacity; over-requesting is the
   *  curation model. */
  maxSeats: number
  priceLabel: string
  /** Offer the online/cash choice — allows_cash events with a price. */
  offerCash: boolean
}

export function RequestPanel({ ticketTypeId, slug, maxSeats, priceLabel, offerCash }: Props) {
  const [state, action, pending] = useActionState<BookState, FormData>(requestToJoin, {})
  const [mode, setMode] = useState<'online' | 'cash'>('online')

  return (
    <form action={action} className="mx-auto max-w-2xl space-y-2">
      <input type="hidden" name="ticketTypeId" value={ticketTypeId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="paymentMode" value={mode} />

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[19px] leading-tight font-semibold">{priceLabel}</p>
          <p className="text-muted font-mono text-[12px]">
            {state.error ?? 'The host approves each guest.'}
          </p>
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
            {pending ? 'Sending…' : 'Request to join'}
          </button>
        </div>
      </div>

      <label className="sr-only" htmlFor="note">Tell the host who's coming</label>
      <input
        id="note"
        name="note"
        type="text"
        maxLength={280}
        placeholder="Tell the host who's coming (optional)"
        disabled={pending}
        className="border-line w-full rounded-lg border px-3 py-2 text-[14px]"
      />

      {offerCash && (
        <fieldset className="flex gap-4 font-mono text-[12px]">
          <legend className="sr-only">How you'll pay if approved</legend>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="paymentModeChoice"
              checked={mode === 'online'}
              onChange={() => setMode('online')}
              disabled={pending}
            />
            Pay online after approval
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

(The radio pair is display state; the hidden `paymentMode` input is what the action reads — one field, one parse.)

- [ ] **Step 5: The cash button on the paid panel**

`app/e/[slug]/book-panel.tsx` — add a `cash?: boolean` prop and, in the paid rendering, a second submit button that posts the same form to the cash action via React 19's per-button `formAction`:

```tsx
// new import
import { bookCashEvent, bookEvent, startPaidCheckout, type BookState } from './actions'

// new prop beside `paid`
  /** Offers "cash at the door" beside the online button. Paid panels only. */
  cash?: boolean

// a second useActionState for the cash path (two dispatchers, one form —
// each button names its action, each action owns its pending/error state)
  const [cashState, cashAction, cashPending] = useActionState<BookState, FormData>(bookCashEvent, {})
  const busy = pending || cashPending
```

Replace every `disabled={pending}` in the form with `disabled={busy}`, surface `state.error ?? cashState.error ?? seatsLabel` in the status line, and under the existing submit button add:

```tsx
        {paid && cash && (
          <button
            type="submit"
            formAction={cashAction}
            disabled={busy}
            className="border-line text-ink rounded-lg border px-4 py-3 text-[14px] font-medium disabled:opacity-60"
          >
            {cashPending ? 'Booking…' : 'Cash at the door'}
          </button>
        )}
```

- [ ] **Step 6: The page gate**

`app/e/[slug]/page.tsx` — the bottom-bar branch. Above the existing `common` line add:

```ts
  // Requests stay open at capacity: over-requesting IS the curation model —
  // the host approves as seats free up. Only a started event closes the door.
  const requestable = !!ticket && !started && event.requires_approval
  // For requests the picker caps at max_per_order, not seats remaining:
  // a full room can still be asked.
  const requestMax = ticket ? Math.max(1, Math.min(ticket.quantity, ticket.max_per_order ?? 10)) : 1
```

and render, as the FIRST branch of the bottom bar (before `bookableFree`):

```tsx
        {requestable && ticket ? (
          <RequestPanel
            ticketTypeId={ticket.id}
            slug={slug}
            maxSeats={requestMax}
            priceLabel={ticket.price_paise === 0 ? 'Free' : `${formatPaise(ticket.price_paise)} after approval`}
            offerCash={event.allows_cash && ticket.price_paise > 0}
          />
        ) : bookableFree && ticket ? (
```

and thread cash into the paid branch:

```tsx
            paid
            cash={event.allows_cash}
```

The `common` gate keeps its `!event.requires_approval` clause — the three panels stay mutually exclusive by construction. The inert fallback no longer needs to cover approval events; its copy is unchanged.

- [ ] **Step 7: Run tests, lint, full suite; walk it once**

```bash
npx vitest run app/e/[slug]/request-actions.test.ts
npm test
npx next lint
```

Then `npm run dev`, publish a draft approval event (or flip one in Studio), and eyeball: request panel renders, note field present, cash radio only on approval+cash events, paid+cash events show two buttons.

- [ ] **Step 8: Commit**

```bash
git add app/e/[slug]/
git commit -m "feat: the event page takes requests and cash bookings"
```

---

### Task 7: The booking surfaces — approved-pay, cash banner, declined, withdraw

**Files:**
- Modify: `app/bookings/[reference]/actions.ts`
- Create: `app/bookings/[reference]/approved-pay-panel.tsx`
- Modify: `app/bookings/[reference]/page.tsx`
- Modify: `app/bookings/[reference]/checkout-panel.tsx`
- Modify: `app/bookings/page.tsx`, `app/bookings/cancel-button.tsx`
- Test: `app/bookings/[reference]/approved-pay.test.ts`

**Interfaces:**
- Consumes: `beginApprovedCheckout` (Task 5), the Task 4 columns (`attendee_id`, `attendee_note`, `payment_mode`, `approved_at`, `cancellation_reason`, `events.venue_address`, `events.hide_venue_until_approved`), `requireUser` (returns `User`), `formatIst`, `cancelConsequence` with `paymentMode` (Task 2).
- Produces: `startApprovedPayment(previous: ApprovedPayState, formData: FormData): Promise<ApprovedPayState>` where `export interface ApprovedPayState { error?: string }`.

- [ ] **Step 1: Write the failing action tests**

`app/bookings/[reference]/approved-pay.test.ts`, same mock plumbing as Task 6's (plus `vi.mock` of `@/lib/bookings/queries` and `@/lib/payments/service`). Assert:

```ts
// 1. signed out → redirect(loginPath());
// 2. a malformed reference ('../../etc', lowercase, 7 chars) returns the
//    reload-sentence WITHOUT calling getBookingByReference;
// 3. an unresolvable reference returns the reload-sentence;
// 4. success: beginApprovedCheckout called with (caller, booking.id),
//    revalidatePath(`/bookings/REF`) called, {} returned;
// 5. a service refusal ({ ok: false, error }) surfaces as { error } and does
//    NOT revalidate.
```

- [ ] **Step 2: Run to verify failure, then implement the action**

Append to `app/bookings/[reference]/actions.ts` (it already imports `currentCaller`, `loginPath`, `getBookingByReference`, `REFERENCE_PATTERN`; add `revalidatePath` from `next/cache` and `beginApprovedCheckout` from `@/lib/payments/service`):

```ts
export interface ApprovedPayState {
  error?: string
}

/**
 * The Pay tap on an approved booking. Orders are created here, on the
 * explicit action — never on a page load — and the service re-checks that
 * the caller IS the attendee: getBookingByReference deliberately also
 * resolves for the event's host, and a host must not be able to open an
 * order against a guest's approval.
 */
export async function startApprovedPayment(
  _previous: ApprovedPayState,
  formData: FormData,
): Promise<ApprovedPayState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const reference = String(formData.get('reference') ?? '')
  if (!REFERENCE_PATTERN.test(reference)) {
    return { error: 'Something went wrong. Reload the page and try again.' }
  }

  const booking = await getBookingByReference(reference)
  if (!booking) return { error: 'Something went wrong. Reload the page and try again.' }

  const result = await beginApprovedCheckout(caller, booking.id)
  if (!result.ok) return { error: result.error }

  // The payments row now exists; the server re-render mounts CheckoutPanel.
  revalidatePath(`/bookings/${reference}`)
  return {}
}
```

- [ ] **Step 3: The approved-pay panel**

`app/bookings/[reference]/approved-pay-panel.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { startApprovedPayment, type ApprovedPayState } from './actions'

/**
 * "You're approved — pay by <deadline>." One tap creates the order; the
 * server re-render then swaps this panel for the checkout sheet. Everything
 * authoritative happens server-side; this is a form with a sentence.
 */
export function ApprovedPayPanel({
  reference,
  amountLabel,
  deadlineLabel,
}: {
  reference: string
  amountLabel: string
  deadlineLabel: string
}) {
  const [state, action, pending] = useActionState<ApprovedPayState, FormData>(startApprovedPayment, {})

  return (
    <section className="border-line mt-8 rounded-lg border p-4">
      <form action={action}>
        <input type="hidden" name="reference" value={reference} />
        <p className="text-sm">
          You&rsquo;re approved! Pay {amountLabel} by {deadlineLabel} to confirm your seat.
        </p>
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

- [ ] **Step 4: The booking page states**

`app/bookings/[reference]/page.tsx` changes, in order:

1. `const user = await requireUser()` (capture the return — it was discarded) and after the booking loads: `const isAttendee = booking.attendee_id === user.id`. **This guard is load-bearing:** the `payments` embed is RLS-scoped to the attendee, so it is `[]` for a host viewing a guest's booking — without `isAttendee`, the "no order yet" condition below would show the HOST a Pay button for someone else's approval.
2. New imports: `formatPaise` from `@/lib/money`, `ApprovedPayPanel` from `./approved-pay-panel`.
3. `STATUS_LINE.pending_approval` becomes the spec's sentence: `'Request sent — the host will review it'`. The status line then becomes a computed value (the declined ending is a cancel with a particular stored reason — the same prose-as-fact pattern the initiator uses):

```ts
  const statusLine =
    booking.status === 'cancelled' && booking.cancellation_reason === 'declined by host'
      ? "The host couldn't fit you in this time"
      : (STATUS_LINE[booking.status] ?? `Booking ${booking.status}`)
```

4. The venue reveal — the address joins the Where row only once the viewer is entitled (this is what makes `hide_venue_until_approved`'s public-page promise true):

```tsx
  const venueRevealed =
    !event?.hide_venue_until_approved || !!booking.approved_at || booking.status === 'confirmed'
```

and inside the Where `<dd>` block, under the existing venue/city line:

```tsx
              {event.venue_address && venueRevealed && (
                <p className="text-muted text-[13px] break-words">{event.venue_address}</p>
              )}
```

5. The note echo, after the `<dl>`:

```tsx
      {booking.status === 'pending_approval' && booking.attendee_note && (
        <p className="text-muted mt-4 text-sm">Your note to the host: “{booking.attendee_note}”</p>
      )}
```

6. The refund-policy sentence gains a cash guard (`booking.payment_mode !== 'cash'` joins the existing condition) — a cutoff sentence under a cash booking promises money movement that cannot happen.
7. The cash banner, beside the ticket section:

```tsx
      {booking.status === 'confirmed' && booking.payment_mode === 'cash' && (
        <p className="border-line mt-6 rounded-lg border p-3 text-sm">
          Pay {formatPaise(booking.total_paise)} in cash at the door.
        </p>
      )}
```

8. The approved-pay mount, directly above the existing CheckoutPanel mount:

```tsx
      {booking.status === 'awaiting_payment' &&
        booking.approved_at &&
        isAttendee &&
        !payment &&
        holdLive &&
        keyId &&
        event && (
          <ApprovedPayPanel
            reference={booking.reference}
            amountLabel={formatPaise(booking.total_paise)}
            deadlineLabel={formatIst(new Date(booking.hold_expires_at!))}
          />
        )}
```

9. The CheckoutPanel call gains `deadlineLabel={formatIst(new Date(booking.hold_expires_at!))}`.

- [ ] **Step 5: The 24-hour countdown copy**

`app/bookings/[reference]/checkout-panel.tsx` — the prop:

```ts
  /** Preformatted IST deadline; shown instead of the mm:ss clock when the
   *  hold is longer than an hour (the 24h approval window). */
  deadlineLabel: string
```

and the countdown line becomes:

```tsx
            <p className="text-muted mt-2 text-center font-mono text-[12px]">
              {remaining > 3600 ? `Pay by ${deadlineLabel}` : `Seats held for another ${clock(remaining)}`}
            </p>
```

(The interval math is untouched — at zero the sheet still closes and the page re-renders expired.)

- [ ] **Step 6: Withdraw on /bookings**

`app/bookings/cancel-button.tsx`: read the file first; add an optional `label?: string` prop defaulting to the current button text (whatever it literally is — do not rename it), used for both the idle label and any confirm copy that repeats it.

`app/bookings/page.tsx`: the cancel control renders for requests too, and the consequence learns the mode:

```tsx
              {(booking.status === 'confirmed' || booking.status === 'pending_approval') && (
                <CancelButton
                  bookingId={booking.id}
                  slug={booking.events?.slug ?? ''}
                  label={booking.status === 'pending_approval' ? 'Withdraw request' : undefined}
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

(A pending request has no money and frees no inventory — `cancel_booking` knows; the consequence is null by construction.)

- [ ] **Step 7: Run tests and the suite; walk it once**

```bash
npx vitest run app/bookings/[reference]/approved-pay.test.ts
npm test
npx next lint
```

Dev-server walk: request on an approval event → booking page says "Waiting for the host" with the note; approve it in Studio (`select approve_booking('<id>');` via `npx supabase db query` or the Task 8 UI once it exists) → page shows "You're approved — pay ₹X by <deadline>" → Pay opens the panel → (keys present) the sheet; a declined row reads its own sentence; a cash booking shows the banner.

- [ ] **Step 8: Commit**

```bash
git add app/bookings/
git commit -m "feat: the booking page speaks approval, cash and declined states"
```

---

### Task 8: The host's approval queue

**Files:**
- Modify: `app/host/events/[id]/attendees/actions.ts`
- Create: `app/host/events/[id]/attendees/approve-request-button.tsx`
- Create: `app/host/events/[id]/attendees/decline-request-button.tsx`
- Modify: `app/host/events/[id]/attendees/page.tsx`
- Test: `app/host/events/[id]/attendees/approval-actions.test.ts`

**Interfaces:**
- Consumes: `approveBooking`, `declineBooking` (Task 3), `listEventRequests`, `listApprovedUnpaid`, `EventRequest` (Task 4), `cancelConsequence` with `paymentMode` (Task 2), `formatPaise`, `formatIst`, the existing `UUID_PATTERN`, `isEventSlug`, `dialable`, `CancelAttendeeButton`.
- Produces: `approveRequest` / `declineRequest` server actions, both `(previous: ApprovalActionState, formData: FormData) => Promise<ApprovalActionState>` where `export interface ApprovalActionState { error?: string }`.

- [ ] **Step 1: Write the failing action tests**

`app/host/events/[id]/attendees/approval-actions.test.ts`, mirroring the existing tests for `cancelAttendeeBooking` in this directory (find and read them first). Assert:

```ts
// 1. signed out → redirect(loginPath()) for both;
// 2. empty bookingId → the reload-sentence, service never called;
// 3. approveRequest: service called with (caller, bookingId); on ok,
//    revalidates `/host/events/{eventId}/attendees` (uuid-shaped only),
//    `/e/{slug}` (slug-shaped only) and '/' — approval moves reserved_count;
// 4. declineRequest: service called with (caller, bookingId); on ok
//    revalidates ONLY the attendees path — a decline moves no inventory;
// 5. a service refusal surfaces as { error } with no revalidation;
// 6. a junk eventId ('../../../login') never reaches revalidatePath.
```

- [ ] **Step 2: Run to verify failure, then implement the actions**

Append to `app/host/events/[id]/attendees/actions.ts` (imports gain `approveBooking, declineBooking` from `@/lib/bookings/service`):

```ts
export interface ApprovalActionState {
  error?: string
}

export async function approveRequest(
  _previous: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  const eventId = String(formData.get('eventId') ?? '')
  if (!bookingId) return { error: 'Something went wrong. Reload the page and try again.' }

  // The same posture as cancelAttendeeBooking above: the service owns the
  // decision (mayApprove against the booking's real event), and eventId/slug
  // from the form are used for revalidation only, shape-checked because both
  // are interpolated into paths.
  const result = await approveBooking(caller, bookingId)
  if (!result.ok) return { error: result.error }

  if (UUID_PATTERN.test(eventId)) revalidatePath(`/host/events/${eventId}/attendees`)

  // Approval takes inventory, so the public page's seats-left line and the
  // feed payload both just moved — the cancel action's pair, pointing the
  // other way.
  const slug = String(formData.get('slug') ?? '')
  if (isEventSlug(slug)) revalidatePath(`/e/${slug}`)
  revalidatePath('/')
  return {}
}

export async function declineRequest(
  _previous: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const caller = await currentCaller()
  if (!caller) redirect(await loginPath())

  const bookingId = String(formData.get('bookingId') ?? '')
  const eventId = String(formData.get('eventId') ?? '')
  if (!bookingId) return { error: 'Something went wrong. Reload the page and try again.' }

  const result = await declineBooking(caller, bookingId)
  if (!result.ok) return { error: result.error }

  // A decline moves no inventory — the request never held any — so only the
  // queue itself needs repainting.
  if (UUID_PATTERN.test(eventId)) revalidatePath(`/host/events/${eventId}/attendees`)
  return {}
}
```

- [ ] **Step 3: The two buttons**

Read `app/host/events/[id]/attendees/cancel-attendee-button.tsx` first and match its structure (pending state, error line placement, class names). The shape:

`approve-request-button.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { approveRequest, type ApprovalActionState } from './actions'

export function ApproveRequestButton({
  bookingId,
  eventId,
  slug,
  consequence,
}: {
  bookingId: string
  eventId: string
  slug: string
  consequence: string
}) {
  const [state, action, pending] = useActionState<ApprovalActionState, FormData>(approveRequest, {})

  return (
    <form action={action} className="text-right">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="slug" value={slug} />
      <button
        type="submit"
        disabled={pending}
        className="bg-ink text-paper rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-60"
      >
        {pending ? 'Approving…' : 'Approve'}
      </button>
      <p className="text-muted mt-1 font-mono text-[11px]">{state.error ?? consequence}</p>
    </form>
  )
}
```

`decline-request-button.tsx` — the same skeleton with `declineRequest`, no `slug` input, a bordered secondary button (`border-line text-ink rounded-lg border px-4 py-2 …`), labels `Decline`/`Declining…`, and the static line `They can request again.` under it.

- [ ] **Step 4: The page**

`app/host/events/[id]/attendees/page.tsx`:

1. Imports gain `listEventRequests, listApprovedUnpaid, type EventRequest` (`@/lib/bookings/queries`), `formatPaise` (`@/lib/money`), `formatIst` (`@/lib/events/datetime`), the two buttons.
2. Fetch beside the guest list: `const [attendees, requests, unpaid] = await Promise.all([listEventAttendees(id), listEventRequests(id), listApprovedUnpaid(id)])`.
3. The consequence sentence, computed where the price is known (`event.ticket_types[0]?.price_paise ?? 0` — `getOwnedEvent` carries it):

```ts
function approveConsequence(request: EventRequest, pricePaise: number): string {
  const total = pricePaise * request.quantity
  const seats = `${request.quantity} ${request.quantity === 1 ? 'seat' : 'seats'}`
  if (total === 0) return `Approving confirms ${seats}.`
  if (request.payment_mode === 'cash') {
    return `Approving takes ${seats}; they pay ${formatPaise(total)} at the door.`
  }
  return `Approving takes ${seats}; they pay ${formatPaise(total)} within 24 hours.`
}
```

4. The Requests section, above the guest list (render only when `requests.length > 0`): heading `Requests` with a count line, then a `divide-line divide-y` list where each row shows `attendee_name ?? 'Guest'`, the seats/reference mono line with the requested-at (`formatIst`), the note in quotes when present, the `tel:` link via the existing `dialable`, and on the right the two buttons stacked (`flex shrink-0 flex-col items-end gap-2`), `ApproveRequestButton` fed `approveConsequence(request, price)`.
5. The Approved-unpaid strip between requests and the guest list (render only when `unpaid.length > 0`): heading `Approved — payment pending`, rows showing name, seats, `formatPaise(total_paise)`, `Pay by {formatIst(new Date(hold_expires_at!))}` (fallback `'—'` when null), the phone link, and a `CancelAttendeeButton` with `consequence={null}` — cancelling an unpaid approval frees the seat and owes nothing.
6. The confirmed guest-list block is untouched except one line: `cancelConsequence` gains `paymentMode: a.payment_mode === 'cash' ? 'cash' : 'online'` — removing a cash guest must not promise a refund.
7. The header count line still counts confirmed only; add beside it, when either list is non-empty: `· {requests.length} requested · {unpaid.length} approved unpaid` (mono, muted — the host's one-glance answer).

- [ ] **Step 5: Run tests and the suite; walk it once**

```bash
npx vitest run app/host/events/[id]/attendees/approval-actions.test.ts
npm test
npx next lint
```

Dev-server walk: request as one user → the queue shows the note and consequence → Approve on a paid event moves it to the unpaid strip → the attendee's page offers Pay; Decline frees the row and the attendee reads the declined sentence; over-approve a 1-seat event and read the seats-remaining sentence inline.

- [ ] **Step 6: Commit**

```bash
git add app/host/events/[id]/attendees/
git commit -m "feat: the host approval queue and the approved-unpaid strip"
```

---

### Task 9: Finale — suite, build, spec cross-check, merge

**Files:** none new.

- [ ] **Step 1: The full gauntlet**

```bash
npm test          # every file; count must be >= Task 1's baseline + this phase's new tests
npx next lint
npx tsc --noEmit
npm run build
```

- [ ] **Step 2: Cross-check the spec**

Open `docs/specs/2026-08-11-phase-5a-approvals-cash-design.md` and verify each is true in code, ticking them off:

- request → approve → pay → confirm works end-to-end (Task 5's join test)
- approve-free and approve-cash confirm directly (Task 1 tests)
- decline = cancel with `'declined by host'`, re-request allowed (Tasks 1, 3)
- cash instant-confirm, commission 0, no payments row ever (Tasks 1, 3)
- requests stay open at capacity (Task 6's `requestable` gate has no `soldOut`)
- `hide_venue_until_approved` reveal on the booking page (Task 7)
- consequence copy: approve (online/cash/free), decline, cash-cancel (Tasks 2, 7, 8)
- host queue + unpaid strip; confirmed guest list untouched (Tasks 4, 8)
- no new admin importers, no fees, no notifications (grep `admin.ts` imports; grep `p_convenience_fee_paise` callers)

- [ ] **Step 3: Merge**

```bash
git checkout master
git merge --no-ff phase-5a-approvals-cash -m "Merge Phase 5a: approval flow and cash bookings"
```

Keep the branch. Push only when the user confirms. `npm run db:stop` if the session is ending (C: is ~99% full).


