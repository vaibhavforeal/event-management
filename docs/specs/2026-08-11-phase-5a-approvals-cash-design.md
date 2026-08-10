# Phase 5a — Approvals and cash: the curation angle

**Date:** 2026-08-11
**Status:** approved in brainstorming, awaiting implementation plan
**Builds on:** [`2026-08-08-event-platform-v1-design.md`](2026-08-08-event-platform-v1-design.md) (build order row 5),
[`2026-08-09-phase-2a-bookings-design.md`](2026-08-09-phase-2a-bookings-design.md),
[`2026-08-10-phase-3-payments-design.md`](2026-08-10-phase-3-payments-design.md)

## Goal

A host who ticked "I approve each guest" gets a working request queue:
stranger requests → host approves → attendee pays inside 24 hours → the same
QR every other booking gets. A host who ticked "allow cash at the door" gets
bookable cash seats. The two toggles have sat on the event form since
Phase 1, promising flows that refused everyone; this phase makes them honest.

## Scope

In: the request → approve/decline → pay/confirm loop for
`requires_approval` events (free, paid-online, and cash); instant-confirm
cash bookings for `allows_cash` events; the host approval queue on the
attendees page; the `hide_venue_until_approved` reveal; the `EH05x` refusal
block.

Out, deliberately: the **waitlist** — Phase 5b, its own spec, once the
seat-freeing events this phase creates (declines, expired approval holds)
exist for it to feed on; notifications of any kind (Phase 4 — the attendee
learns their fate on-page, the host pings manually); fees and commission
(both still wired at ₹0, Phase 3's decision carries); payout treatment of
cash; any change to the webhook, refund, or reconciliation machinery.

## What already exists

The database has been a phase ahead of the app since Phase 0:

- `booking_status` already contains `pending_approval`; `payment_mode`
  already contains `cash`; `events` already has `requires_approval`,
  `allows_cash`, `hide_venue_until_approved`; `bookings` already has
  `approved_at` and `attendee_note`. The event form already exposes all
  three toggles.
- `request_booking()` — inserts `pending_approval`, **deliberately consumes
  no inventory** ("a curated supper club will get more requests than seats;
  that is the point"), prices at 0 to be repriced at approval.
- `approve_booking()` — takes inventory under the ticket-type row lock (can
  legitimately refuse if the host over-approves), reprices from the current
  `price_paise`, sets a 24-hour `awaiting_payment` hold, auto-confirms when
  the total is ₹0.
- `confirm_booking()` accepts `pending_approval`; `cancel_booking()` knows a
  `pending_approval` row returned no inventory; `release_expired_holds`
  and `bookings_expiring_idx` are hold-duration-agnostic.
- `reserve_tickets()` accepts `p_payment_mode = 'cash'` behind an
  `allows_cash` guard and zeroes commission for cash.
- The one-active-booking partial index already covers `pending_approval` —
  one live request per attendee per event is enforced today.
- The checkout home on `/bookings/[reference]` (sheet, countdown, polling,
  first-poll checkout proof) and the webhook/reconcile machinery — approval
  bookings join those rails unchanged once an order exists.

**Nothing in production TypeScript calls `request_booking` or
`approve_booking`.** The public page shows approval events an inert
"Booking opens soon"; `allows_cash` is fetched and unrendered;
`hide_venue_until_approved` renders a promise ("the host shares the exact
address once they approve you") that nothing can fulfil.

## Decisions taken in brainstorming

**Scope is 5a: approvals + cash; the waitlist is 5b.** Approvals and cash
wire up machinery Phase 0 already built; the waitlist is a new subsystem
(table, offer mechanics, interactions with both features) and follows the
2a/2b precedent of splitting a phase. Rejected: all three in one spec (the
waitlist design would gate two features that are otherwise ready) and
approval-only (cash shares the same booking-panel and guest-list surfaces —
building them twice is waste).

**Cash confirms instantly.** Reserve + confirm in one transaction, ticket
issued, pay at the door. The host opted into no-show risk by ticking the
box, and can free a seat by removing the guest. Rejected: host-acknowledges
-each-cash-booking (approval-lite for cash adds a host chore per booking and
a second pending queue — a host who wants vetting has the approval toggle)
and cash-only-via-approval-events (conflates two independent toggles).

**Approval outcomes are on-page only; the host pings manually.** The
booking page shows requested → approved-pay-now → confirmed; the approval
queue carries the guest's WhatsApp link. Zero notification code, matching
Phase 3's deliberate "notifications out" scope. Phase 4 swaps in the
already-written `approval_granted` template. Rejected: wiring the
notification seam with the log provider now — send sites without a channel
are Phase 4's work to shape, and `message_log` has zero writers today.

**Declines allow re-request.** Decline ends the request (`cancelled`, reason
`'declined by host'`); the freed one-active-booking slot means the attendee
may ask again, perhaps with a better note. Pilot-scale hosts can decline
twice. Rejected: one-request-ever (new schema and a `request_booking` guard
for a pest problem the pilot may never have).

**Recreate the Phase 0 functions to convention rather than wrap them.**
Measured against the standards later phases established, the originals have
real gaps: `request_booking` has no started-event guard (the exact hole
Phase 2a's audit closed for booking — the WhatsApp link outlives the feed),
no `max_per_order` check, no attendee name, and hardcodes
`payment_mode = 'online'`; `approve_booking` has no started guard and
auto-confirms only at total ₹0, so a cash request would strand in
`awaiting_payment` asking for online money. Guards belong in SQL ("the
answer should not depend on which caller asked" — 2a). Drop-first recreate,
the Phase 3 precedent for changed signatures. Rejected: wrapping as-is with
TypeScript guards (splits the guard story across layers and still needs SQL
for the cash-approve fix) and a state-machine redesign with a `declined`
status (re-request-allowed needs no new status).

## Schema delta

One migration, three functions, no new tables or columns.

**`request_booking(p_ticket_type_id, p_attendee_id, p_quantity,
p_attendee_name, p_attendee_note default null, p_payment_mode payment_mode
default 'online')`** — recreated. Modern guard block, `EH05x`-coded:
published, not started, event actually requires approval, quantity within
`max_per_order`, cash requested only where `allows_cash`. Still consumes no
inventory and stores 0/0/0 money. `p_attendee_name` is written onto the row
in the same transaction (the `book_free_tickets` pattern — `reserve_tickets`
is not involved here, but the queue needs a door-quality name).
`p_payment_mode` is chosen **at request time** on approval+cash events and
decides what approval does.

**`approve_booking(p_booking_id, p_convenience_fee_paise default 0,
p_commission_paise default 0, p_hold_hours integer default 24)`** —
recreated. Keeps its Phase 0 semantics — inventory taken under the row lock
at approval, over-approval refused with the seats-remaining sentence,
repriced from the current price — and gains: a started-event guard, and the
cash branch: **`payment_mode = 'cash'` confirms directly** (pay at the
door) with commission zeroed, mirroring `reserve_tickets`. Free (total ₹0)
keeps its direct confirm. Online-paid keeps the 24-hour hold into
`awaiting_payment` with `approved_at` stamped.

**`book_cash_tickets(p_ticket_type_id, p_attendee_id, p_quantity,
p_attendee_name, p_attendee_note default null)`** — new, the cash mirror of
`book_free_tickets`: guards (`EH05x`: published, not started, no approval
required, `allows_cash`, price > 0 — a free cash booking is the free path's
job), then `reserve_tickets(mode: 'cash')` + name write + `confirm_booking`
in one transaction. Commission is zeroed by `reserve_tickets`; the
convenience fee stays 0 like everywhere else this pilot.

All three: `SECURITY DEFINER`, `set search_path = public` (`extensions`
only where `confirm_booking` is reached, for `gen_random_bytes`), `EXECUTE`
revoked from `public`/`anon`/`authenticated`, granted to `service_role`.
`npm run db:types` after; `lib/supabase/types.ts` is committed.

## The flows

**Approval, online-paid.** Request (name, seats, note) → `pending_approval`,
no seat taken. Approve → repriced, seat taken, `awaiting_payment`, 24-hour
hold. The attendee reopens `/bookings/[reference]`: "You're approved — pay
₹X by <deadline>", a Pay control that calls **`beginApprovedCheckout`** —
the missing piece between approval and the Phase 3 rails: it creates the
Razorpay order for exactly `total_paise` and inserts the `payments` row
(`created`), after which the existing `CheckoutPanel`, first-poll proof,
webhook, and reconcile paths run unchanged. Idempotent: a second call finds
the existing `payments` row and returns the same order (one order per
booking's lifetime — Phase 3's rule). Orders are never created on page
load, only on the explicit Pay action. Unpaid past the hold →
`release_expired_holds` flips it to `expired`, the seat returns, and the
attendee may re-request.

**Approval, free or cash.** Approve → confirmed, tickets issued, done. Free
has nothing to pay; cash pays at the door.

**Cash, no approval.** The book panel offers "pay cash at the door" beside
"pay online" when `allows_cash` and price > 0. Cash → `book_cash_tickets`
→ confirmed with QR immediately, `payment_mode = 'cash'`, no `payments`
row ever. Cancel of a cash booking moves no money: `refundIfOwed` finds no
captured payment and no-ops — the machinery already behaves; only the
consequence copy needs a cash branch (never promise a refund where no money
moved).

**Decline.** `cancelBooking(caller, id, 'host')` with reason
`'declined by host'` — not a new function. No inventory returns (none was
taken), no refund fires (no payment exists). The attendee's page reads "the
host couldn't fit you in this time", distinguished by the stored reason —
the same prose-as-fact pattern the cancel initiator already uses.
Withdrawing one's own request is the attendee's existing cancel on
`/bookings`, which `mayCancel` already permits.

**Repricing is an approval-time fact.** The attendee pays the price at
approval, not at request — a host who edits the price mid-queue changes
what requesters pay. The pay screen shows the amount before the sheet
opens, so nothing is charged unseen. Deliberate, recorded.

## Screens

| Route | Change |
|---|---|
| `/e/[slug]` | Approval events: the inert button becomes **Request to join** — name, seats, note ("tell the host who's coming"), price shown as "₹500 — you pay after the host approves you". Requests stay open at capacity: over-requesting **is** the curation model; no sold-out gate on requests. Cash events (paid, no approval): a payment choice in the book panel — pay ₹X now / pay cash at the door. Approval+cash events: the same choice on the request form, stored on the request. |
| `/bookings/[reference]` | `pending_approval`: "Request sent — the host will review it", note echoed. Approved online: "You're approved — pay ₹X by <deadline>" + Pay → `beginApprovedCheckout` → the existing checkout panel; countdown copy adapts (mm:ss under an hour, "Pay by Tue 7:30 pm" above). Confirmed cash: the QR view plus "Pay ₹X in cash at the door". Declined: its own sentence. `hide_venue_until_approved`: address appears here only once approved or confirmed. |
| `/bookings` | Request rows show their state; withdraw = the existing cancel. |
| `/host/events/[id]/attendees` | A **Requests** section above the guest list: name, seats, note, requested-at, the tel/WhatsApp link (the manual ping), Approve / Decline with consequence copy ("Approving takes 2 seats; they pay ₹1,000 within 24 hours" / "…they pay at the door" / "they can request again"). An **Approved — payment pending** strip so the host can chase before the window lapses. The confirmed-only guest list is untouched — its status filter is load-bearing; requests and unpaid approvals are sibling queries, not a loosened filter. |

`hide_venue_until_approved` on the public page keeps its existing hidden
state and sentence; this phase makes the promise true rather than changing
the page.

## Application modules

| File | Responsibility |
|---|---|
| `lib/bookings/service.ts` | Grows `requestBooking`, `approveBooking`, `declineBooking`, `bookCashTickets` — all `Caller`-first, all through the existing admin client. Already inside the ESLint admin-import fence; no new fence entries. |
| `lib/bookings/authorize.ts` | `mayApprove(caller, booking)` — pure, exhaustively unit-tested, host-of-this-event only. Decline reuses `mayCancel`'s host arm. |
| `lib/bookings/rpc-errors.ts` | The `EH05x` block → door-quality sentences. |
| `lib/bookings/queries.ts` | `listEventRequests` (`pending_approval`), `listApprovedUnpaid` (`awaiting_payment` with `approved_at`) — siblings of `listEventAttendees`, which keeps its confirmed-only filter. |
| `lib/payments/service.ts` | `beginApprovedCheckout(caller, bookingId)` — owner-only, refuses non-approved / cash / expired / foreign bookings, creates order + `payments` row once, idempotent on retry, one-sentence failure when keys are missing. Already a fenced admin importer. |
| `app/e/[slug]/…` | The request panel and the cash choice; posts to the new actions. |
| `app/bookings/[reference]/…` | The three new render states (requested / approved-pay / cash-confirmed) and the venue reveal. |
| `app/host/events/[id]/attendees/…` | The Requests section, the Approved-unpaid strip, `approveRequest` / `declineRequest` actions. |

## Testing

The suite's existing shapes: DB-backed integration against the local stack,
the mocked provider seam, action tests with mocked navigation.

- **The approval matrix, in SQL:** request takes no inventory; approve
  takes it; over-approval refused; **two concurrent approvals of the last
  seat → exactly one succeeds** (the row-lock serialisation, tested the way
  the 50-buyer test guards `reserve_tickets`); a direct booking racing an
  approval to the last seat; approve on a started event refused (new
  guard); request on a past event refused (new guard); approve-free
  confirms; **approve-cash confirms directly with commission 0**; the
  24-hour lapse flows through `release_expired_holds` to `expired` and
  frees the seat; re-request after decline succeeds; duplicate active
  request refused.
- **Cash:** `book_cash_tickets` yields confirmed + `payment_mode='cash'` +
  commission 0 + tickets, one transaction; refused without `allows_cash`,
  on approval events, on free tickets; host-removes-cash-guest frees the
  seat and creates **no** refund row.
- **The payment join:** approved booking → `beginApprovedCheckout` →
  captured webhook → confirmed with tickets — approval bookings ride the
  Phase 3 rails unchanged. Double-call returns the same order; refusals for
  foreign, unapproved, cash, and expired bookings; keys-missing sentence.
- **Authorisation as attempts that must fail:** a stranger and a different
  host cannot approve or decline; an attendee withdraws only their own
  request. `mayApprove` unit-tested exhaustively, no database.
- **Copy:** the consequence sentences (approve, decline, cash-cancel)
  asserted the way `cancelConsequence` already is.

## Known limitations, deliberate

- **No notification on approve/decline.** On-page state plus the host's
  manual WhatsApp ping. Phase 4's `approval_granted` template is already
  written and waiting.
- **Cash collection is not tracked.** Check-in is the proxy for "paid at
  the door"; the pilot counts cash share via `payment_mode`, per the v1
  doc's leak-watching plan. No "collected" ledger.
- **Approval reprices at approval time.** Visible before the sheet opens;
  never charged unseen.
- **An expired approval dies as `expired`.** No auto-revive; the attendee
  re-requests and the host re-approves.
- **Requests stay open at capacity.** Over-requesting is curation, not a
  defect. The host sees seats and requests side by side.
- **No waitlist.** Phase 5b, its own spec.
- Carried from Phase 3: one active booking per attendee per event, no
  partial refunds, `refunded` means created-not-settled, one order per
  booking's lifetime.
