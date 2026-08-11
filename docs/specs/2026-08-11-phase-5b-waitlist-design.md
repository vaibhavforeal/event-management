# Phase 5b — The waitlist: demand past capacity, kept

**Date:** 2026-08-11
**Status:** approved in brainstorming; planned in [`docs/plans/2026-08-11-phase-5b-waitlist.md`](../plans/2026-08-11-phase-5b-waitlist.md)
**Builds on:** [`2026-08-08-event-platform-v1-design.md`](2026-08-08-event-platform-v1-design.md) (build order row 5),
[`2026-08-11-phase-5a-approvals-cash-design.md`](2026-08-11-phase-5a-approvals-cash-design.md),
[`2026-08-10-phase-3-payments-design.md`](2026-08-10-phase-3-payments-design.md)

## Goal

A sold-out instant-book event stops refusing people and starts keeping
them: an attendee joins the line, a freed seat is offered to the head of
that line automatically with a 24-hour window to take it, and the offer
pays or claims through exactly the rails every other booking uses. 5a gave
approval events this for free — requests stay open at capacity; this phase
gives the same courtesy to events where the host doesn't vet guests.

## Scope

In: a `has_waitlist` toggle for instant-book events; `join_waitlist` and
the `waitlisted` booking state; automatic strict-FIFO promotion with a
24-hour offer hold at every seat-freeing seam; pay (online) and claim
(free/cash) on the offer; the waitlist section on the host attendees page;
position display for the attendee; the `EH06x` refusal block.

Out, deliberately: notifications of any kind (Phase 4 — the attendee
discovers the offer on-page; the host chases from the payment-pending
strip); waitlists on approval events (their request queue already is one);
any change to the checkout, webhook, refund, or reconciliation machinery
(offers ride it unchanged); fees and commission (still ₹0, cash still
zeroes commission).

## What already exists

Phase 5a built almost the entire offer path without knowing it:

- `request_booking` proves the pattern of a booking that **consumes no
  inventory** and stores 0/0/0 money until promoted.
- `approve_booking` proves offer mechanics: inventory under the ticket-type
  row lock, repriced from the current `price_paise`, a 24-hour
  `awaiting_payment` hold with `approved_at` stamped.
- The `ApprovedPayPanel` + `beginApprovedCheckout` + first-poll proof +
  webhook/reconcile chain turns any `awaiting_payment` + `approved_at`
  booking into a paid, confirmed one. The expiry machinery
  (`release_expired_holds`, `bookings_expiring_idx`) is hold-duration
  agnostic and already called inline at every reserve/read seam plus the
  sweep — no cron.
- `bookings_one_active_per_attendee` partially indexes the live statuses;
  `cancel_booking` knows rows that hold no inventory; `mayCancel` already
  arbitrates attendee-withdraws and host-removes.
- The public page already computes `soldOut` and shows an inert line for it.

What does not exist: any way to express interest in a sold-out
instant-book event, the `waitlisted` status, and the promotion engine.

## Decisions taken in brainstorming

**Auto-offer with a timed hold.** A freed seat is offered to the head of
the line automatically; no host action per seat. Rejected: host-promotes
(a chore per freed seat on events the host explicitly didn't want to
curate — vetting hosts have the approval toggle) and signal-only
(joining a list that confers nothing).

**A toggle, instant-book events only.** `events.has_waitlist`, opt-in on
the form like `requires_approval` and `allows_cash`; hidden on approval
events, whose request queue already captures unlimited demand. Rejected:
automatic-on-sold-out (hosts who don't want stragglers get a queue anyway)
and layering onto approval events (two queues on one attendees page).

**24-hour offer window.** The product's one number — the approval pay-hold
uses it, the machinery is duration-agnostic, the copy patterns exist.
Rejected: 12 hours (a second window number for marginal rot reduction)
and hold-until-start (one inattentive person strands the seat forever).

**Multi-seat entries, strict FIFO.** Join for up to `max_per_order` seats;
an offer fires only when the freed pool fits the head of the line — a
3-seat head waits even while 1 seat sits free, and nobody passes them.
Rejected: skip-to-fit (starves groups, and "why did they jump me" has no
good sentence) and single-seat-only (couples gamble on two phones).

**A waitlist entry is a bookings row with a new `waitlisted` status.**
The entry inherits the reference, the page, the one-active-per-event rule,
cancel/withdraw, and — because promotion stamps `approved_at` and sets the
hold — the entire 5a approved-pay surface, unchanged. `requires_approval`
vs `has_waitlist` tells every page which sentence to say (the toggles are
mutually exclusive by guard, so an `awaiting_payment` + `approved_at` row
on a waitlist event is always an offer). Rejected: a separate
`waitlist_entries` table (duplicates identity/money/reference plumbing and
needs its own attendee page until conversion) and reusing
`pending_approval` (every query and copy branch would consult event flags
to know which queue it is looking at).

**Waitlist priority is enforced in SQL, not just the page.** Freed seats
are promoted before any walk-up reservation can see them (see flows), and
the public page stays in join-waitlist mode while the line is non-empty —
a queue nobody can cut is the only kind worth joining.

## Schema delta

Two migrations — Postgres cannot add an enum value and use it in the same
transaction, and each migration file runs in one.

**`20260811000005_waitlist_enum.sql`** — `alter type booking_status add
value 'waitlisted'` (after `pending_approval`), nothing else.

**`20260811000006_waitlist.sql`** — everything that uses it:

- `events.has_waitlist boolean not null default false`.
- `bookings_one_active_per_attendee` recreated to include `'waitlisted'`
  in its predicate — one live entry per attendee per event, same rule,
  same `EH065` remap of the `unique_violation`.
- **`join_waitlist(p_ticket_type_id, p_attendee_id, p_quantity,
  p_attendee_name, p_payment_mode payment_mode default 'online')`** — the
  `request_booking` shape: settles expiries first (the `reserve_tickets`
  pattern, so "available" is truthful), modern guard block, inserts a
  `waitlisted` row that consumes no inventory and stores 0/0/0 money,
  name written in the same transaction. No note field — the host isn't
  vetting anyone. Guards, `EH06x`-coded: waitlist not enabled or event
  requires approval (`EH060`), started (`EH061`), cash where not
  `allows_cash` (`EH062`), over `max_per_order` (`EH063`), seats open and
  the line empty — book instead (`EH064`), duplicate active
  booking/entry (`EH065`). Published passes through as the existing
  check_violation sentence, as in 5a.
- **`promote_from_waitlist(p_ticket_type_id, p_hold_hours integer default
  24)`** — the offer engine. Under the ticket-type row lock: loop — take
  the oldest `waitlisted` row (`created_at`, id); if its quantity fits
  `quantity - reserved_count`, reprice from the current `price_paise`
  (commission stays 0 — pilot-wide, and cash zeroes it anyway), take the
  inventory, set `awaiting_payment` + `hold_expires_at = now() + hold` +
  `approved_at = now()`; repeat until the head doesn't fit or the line is
  empty. **No-ops once the event has started** — nobody is offered a seat
  to an event in progress. Safe to call anywhere: no waitlist, toggle
  off, nothing freed, event started — all no-ops.
- **`cancel_booking` and `release_expired_holds` end by calling
  `promote_from_waitlist`** for the affected ticket type(s). This is the
  whole trigger story: every seat-freeing path already flows through one
  of these two, including `reserve_tickets`' inline expiry settle — which
  means a walk-up buyer's own reservation attempt hands freed seats to
  the line before trying to take one. A lapsed offer expires through the
  same `release_expired_holds`, so promotion chains to the next person
  with no extra machinery.

All per convention: `SECURITY DEFINER`, pinned `search_path`, `EXECUTE`
revoked from `public`/`anon`/`authenticated`, granted to `service_role`.
`npm run db:types` after; `lib/supabase/types.ts` is committed.

## The flows

**Join.** Sold-out waitlist event → the panel takes name, seats (capped at
`max_per_order`), and — where `allows_cash` — the same pay-online /
pay-cash choice a 5a request takes, stored on the entry and deciding what
the offer asks for. The row is `waitlisted`, no seat held, ₹0 stored,
repriced later. The page shows "You're #N in line" — position is the
count of `waitlisted` rows for the ticket type at or before this one's
`created_at`.

**Promote.** A seat frees — attendee cancels, host removes a guest, a
checkout or approval or offer hold lapses — and the freeing function
itself promotes: strict FIFO, repriced at the current price, seat taken,
24-hour window stamped. The booking is now shaped exactly like a 5a
approval that was just granted.

**Take the offer.** The attendee opens `/bookings/[reference]` (nobody
pings them until Phase 4 — deliberate): online-mode offers show "A seat
opened up — pay ₹X by <deadline>" and the Pay control runs
`beginApprovedCheckout` → the Phase 3 rails unchanged; free and cash
offers show **Claim your seat** → `claimOfferedSeat` → `confirm_booking`
directly (cash pays at the door, as everywhere). The QR follows
confirmation, as everywhere.

**Lapse.** Unpaid/unclaimed past the window → `release_expired_holds`
flips it to `expired`, the seat returns, and the same call offers it to
the next person. The lapsed attendee's page reads "Your seat offer
expired — you can rejoin the waitlist"; rejoining is a fresh entry at the
back of the line (the one-active index ignores `expired`).

**Withdraw / remove.** The attendee's withdraw and the host's remove are
the existing cancel — `mayCancel` grows the `waitlisted` arm. No
inventory returns (none was held), no refund fires (no payment exists),
and the freed one-active slot lets the attendee rejoin later.

**Walk-ups don't cut.** While the line is non-empty the public page stays
in join-waitlist mode even if `remaining > 0` (a big head can idle a
seat — accepted), and SQL enforces the same priority underneath: by the
time any reservation runs, freed seats have already been offered.

**Event starts.** Promotion stops; un-promoted entries sit inert —
their page shows the started state, withdraw still works. No sweep
cancels them; they are harmless rows on a finished event.

## Screens

| Route | Change |
|---|---|
| Event form | "Keep a waitlist when it sells out" toggle; hidden when `requires_approval` is ticked (the request queue already is one). |
| `/e/[slug]` | Sold out (or line non-empty) + waitlist on: the inert "Sold out" becomes **Join waitlist** — name, seat count capped at `max_per_order`, cash choice where allowed, price as "₹500 — you pay only if a seat opens for you", the line's length shown. |
| `/bookings/[reference]` | `waitlisted`: "You're #N in line for X seats" + withdraw. Offer, online: the 5a pay panel with waitlist copy — "A seat opened up — pay ₹X by <deadline>". Offer, free/cash: **Claim your seat**. Lapsed offer: "Your seat offer expired — you can rejoin the waitlist." Branch chosen by `has_waitlist` vs `requires_approval`. |
| `/bookings` | Waitlisted rows show "#N in line"; withdraw = the existing cancel. |
| `/host/events/[id]/attendees` | A **Waitlist** section: position, name, seats, mode, joined-at, the tel/WhatsApp link, remove (existing cancel with consequence copy). In-flight offers surface in the existing payment-pending strip with offer copy, so the host can chase before the window lapses. No promote button — promotion is automatic; the strip shows its output. |

## Application modules

| File | Responsibility |
|---|---|
| `lib/bookings/service.ts` | Grows `joinWaitlist` and `claimOfferedSeat` — `Caller`-first, through the existing admin client, inside the existing ESLint fence. Withdraw and remove are the existing `cancelBooking`. |
| `lib/bookings/authorize.ts` | `mayCancel` learns `waitlisted`; `claimOfferedSeat` is owner-only (checked in service: owner, `awaiting_payment` + `approved_at`, mode free-or-cash, expiries settled first). |
| `lib/bookings/rpc-errors.ts` | The `EH06x` block → door-quality sentences. |
| `lib/bookings/queries.ts` | `listEventWaitlist` (waitlisted, `created_at` order) and a position count helper; `listApprovedUnpaid` already catches offers (`awaiting_payment` + `approved_at`) — its consumers branch copy on the event flags. |
| `lib/payments/service.ts` | `beginApprovedCheckout` accepts offers as-is (an offer satisfies every precondition: owner, `awaiting_payment`, `approved_at`, online, unexpired); only its refusal copy may need a queue-neutral sentence. Verified in the plan, not assumed. |
| `app/e/[slug]/…` | The join-waitlist panel and the line-non-empty gate; posts to the new action. |
| `app/bookings/[reference]/…` | The waitlisted state, the offer copy branch, the claim action, the lapsed-offer sentence. |
| `app/host/events/[id]/attendees/…` | The Waitlist section; strip copy branch. |
| Event form | The toggle, hidden under `requires_approval`. |

## Testing

The suite's existing shapes: DB-backed SQL integration, pure units,
action tests with mocked navigation.

- **Queue mechanics, in SQL:** join takes no inventory; promote takes it
  under the row lock; strict FIFO — one seat frees under a 3-seat head →
  no offer fires and a later 1-seat entry does not jump; two seats free
  at once → offers chain down the line in order; a concurrent cancel and
  walk-up booking → the waitlister gets the seat, not the walk-up (the
  inline-settle priority, tested the way the 50-buyer test guards
  `reserve_tickets`); promotion no-ops after `starts_at`.
- **Guards (`EH06x`):** join refused on approval events, waitlist-off,
  started, over `max_per_order`, cash where not allowed, duplicate active
  entry, and seats-open-with-empty-line ("book instead"); unpublished
  passes through as the existing sentence.
- **Offer lifecycle:** lapse → `expired` → seat returns → next in line
  promoted by the same call; claim confirms free and cash offers with
  tickets; an online offer rides `beginApprovedCheckout` → captured
  webhook → confirmed (the 5a payment-join test, re-pointed); double
  claim and claim-on-online refused; repriced-at-offer asserted against a
  mid-queue price edit.
- **Authorisation as attempts that must fail:** a stranger cannot
  withdraw another's entry or claim another's offer; the host removes;
  `mayCancel`'s `waitlisted` arm unit-tested exhaustively, no database.
- **Copy:** the position line, the offer sentences (pay / claim), the
  lapse sentence, the remove consequence — asserted the way
  `cancelConsequence` already is.

## Known limitations, deliberate

- **No notification on offer.** On-page discovery until Phase 4; the host
  chases from the strip. Worst case a freed seat spends 24 hours per
  inattentive person in line. Rejected: wiring the log-provider seam now
  (5a's reasoning holds — send sites without a channel are Phase 4's work
  to shape) and shipping one real template early (drags Meta WABA
  approval into 5b's critical path; start Phase 4's paperwork in parallel
  instead).
- **Strict FIFO can idle a seat** behind a big group. Rejected:
  skip-to-fit (starvation) and a head-timeout hybrid (a third timer for a
  pilot-scale problem).
- **Repricing is offer-time** — the 5a approval rule, one story
  product-wide; the price is always shown before anything is charged.
  Rejected: join-time price lock (honours stale prices against the host's
  current intent, and forks the repricing rule).
- **A lapsed offer dies as `expired`** — rejoin at the back, no
  auto-revive. Rejected: auto-re-queue (abandoned entries recirculate,
  each ghost costing the line 24 hours) and a one-time grace re-offer
  (doubles the edge cases for a problem notifications mostly dissolve).
- **Un-promoted entries on started events sit inert.** Withdrawable,
  harmless, swept by nothing.
- Carried forward: one active booking per attendee per event, one order
  per booking's lifetime, fees and commission at ₹0, `refunded` means
  created-not-settled.
