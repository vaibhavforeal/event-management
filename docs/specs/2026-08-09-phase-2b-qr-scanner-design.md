# Phase 2b — QR tickets and the door scanner

Follows [`2026-08-09-phase-2a-bookings-design.md`](2026-08-09-phase-2a-bookings-design.md),
whose "Notes for 2b" section this spec honours. Phase 2a (free bookings, ticket
issuance) is on `master`.

## Goal

> The guest holds up a QR from a WhatsApp screenshot; the host points a phone at
> it and sees green with a name. Nobody at the door reads codes aloud unless the
> camera fails.

Phase 2 in the v1 build order is "free bookings, ticket issuance, QR, host
scanner". 2a shipped the first two. This spec is **2b**: the QR on the ticket
and the scanner at the door. It closes the full free-event loop the pilot needs.

## Scope

**In:** every ticket renders as a QR on the booking page; a host-only scanner
screen checks tickets in by camera; the guest list checks them in by tap; a
check-in is one atomic write with "already in" reported honestly.

**Out:** offline check-in and the PWA (Phase 7 — the v1 build order is explicit
about this), un-check-in, per-ticket shareable links, notifications, anything
touching payment.

## What already exists

More than the phase name suggests. Phase 0 built the cryptography and the
schema; 2a built the rows.

| Piece | State |
|---|---|
| `tickets` table | One row per admittable person — a 3-seat booking is 3 tickets so a group can arrive separately. `code` (128-bit hex, unique), `checked_in_at`, `checked_in_by`, `checked_in_offline` all exist and are all null/false today |
| `confirm_booking` | Already writes one `tickets` row with a fresh code per seat |
| `cancel_booking` | Already deletes tickets that are not checked in, so an un-scanned ticket on a cancelled booking stops existing |
| `lib/tickets/signing.ts` | Complete and unit-tested: per-event key derivation, `EH1.<code>.<sig>` payload, verification. Web Crypto, so the same module runs on the server and in the scanner's browser |
| RLS | `tickets_select_own` and `tickets_select_for_host`; writes to `tickets` not grantable to `authenticated`, same posture as `bookings` |
| `TICKET_SIGNING_SECRET` | In `.env.example` (not yet in `.env.local`, not yet validated anywhere) |

The threat model, from `signing.ts`'s own header: an attendee must not be able
to manufacture a valid ticket, and a host device compromised at one event must
not be able to forge tickets for another. Hence per-event keys —
`HMAC(root, "event:" + eventId)` — and the scanner is only ever handed the key
for the door it is working.

## Decisions taken in brainstorming

**All QRs on the booking page.** `/bookings/<reference>` renders one QR per
ticket, labelled "Ticket 1 of 3". The booker forwards screenshots on WhatsApp,
which is how everything in this product travels. Per-ticket shareable links
were considered and rejected: they add an unauthenticated bearer-URL surface
and a page for a convenience the pilot has not asked for. RLS already lets the
booker and the event's host read these tickets; nobody else, and no new
surface.

**Native `BarcodeDetector`, no decoder dependency.** It is hardware-fast and in
Chrome on Android, which is what the pilot's hosts hold. A host whose browser
lacks it (iOS Safari, Firefox) is told plainly that point-and-scan needs Chrome
and is pointed at the guest list — which is the same tap-to-check-in flow every
host needs anyway for the guest who arrives without their QR. Bundling jsQR
(~45 KB decoded per camera frame, on a mid-range Android, per frame) was
rejected; so was carrying both pipelines for a host profile the pilot may not
contain.

**Local verify, server write.** The scanner verifies the HMAC in the browser —
a forged or wrong-event QR goes red instantly, with no network — and then a
Server Action performs the check-in and returns the verdict that actually
matters: in, already in at 8:14, or refused. The server never trusts the
client's verdict; its authority is the 128-bit code lookup, which cannot be
guessed. The signature's jobs are the instant local red and, in Phase 7, full
offline verification — this scanner is the muscle that phase reuses.

## The write path

One migration, `20260811000001_ticket_checkin.sql`, two functions. Both
`SECURITY DEFINER`, `set search_path = public, extensions`, `EXECUTE` revoked
from `public`, `anon` and `authenticated` and granted back to `service_role`
explicitly (the `revoke from public` lesson from 2026-08-09). Same posture as
every inventory write in this repo.

```sql
check_in_ticket(p_event_id uuid, p_code text, p_checked_in_by uuid)
  returns table (outcome text, attendee_name text, checked_in_at timestamptz,
                 reference text, tickets_total integer, tickets_in integer)

check_in_next_ticket(p_event_id uuid, p_booking_id uuid, p_checked_in_by uuid)
  returns table (…same…)
```

The core of both is an atomic test-and-set:

```sql
update tickets set checked_in_at = now(), checked_in_by = p_checked_in_by
 where id = <target> and checked_in_at is null
```

so two simultaneous scans of one ticket resolve to exactly one `checked_in` and
one `already_checked_in`, decided by the database rather than by timing.

`attendee_name` in the return is `bookings.attendee_name` — the name typed at
booking. `tickets.attendee_name` is null on every row 2a created and stays
untouched; it exists for a phase that names ticket-holders individually, and
reading it today would print "Guest" at every door.

**"Already checked in" is an outcome, not an error.** A door sees it hourly —
the same QR shown twice, a screenshot forwarded to a friend who arrives second.
The row comes back with `outcome = 'already_checked_in'` and the original
`checked_in_at`, so the scanner can say *when*, and the host can recognise a
duplicate from a mistap. Refusals that mean something is wrong raise SQLSTATEs:

| Code | Raised when | Host sees |
|---|---|---|
| `EH020` | no ticket with this code — or, in the `next_ticket` variant, no booking with this id — on this event | "No such ticket for this event. It may be for a different event, or its booking was cancelled." |
| `EH021` | the ticket's booking is not `confirmed` | "This booking is not confirmed." |
| `EH022` | (`check_in_next_ticket` only) every ticket on the booking is already in | "All seats on this booking are already checked in." |

`p_event_id` is matched in the `WHERE`, not trusted from context: `code` is
globally unique, so without the match a host could check in a ticket belonging
to somebody else's event by posting its code to their own scanner's action.
With it, the same scan gets `EH020`, which is true from that host's doorway.

`EH021` is believed unreachable today — tickets only exist for confirmed
bookings, and cancellation deletes the un-scanned ones — but the check is one
predicate, and Phase 3's paid flow and Phase 5's approval flow will both create
ticket-bearing states this guard is the safety net for. A comment in the
migration says so, per the convention the `unique_violation` handler in
`book_free_tickets` set.

`check_in_next_ticket` picks its target with
`select … where booking_id = p_booking_id and checked_in_at is null
order by created_at limit 1 for update skip locked`, so two taps racing pick
two different tickets rather than fighting over one.

## Application modules

Mirrors `lib/bookings/` exactly; the shape is the 2a design's main mitigation
and this phase does not improvise on it.

| Module | Contents |
|---|---|
| `lib/checkin/service.ts` | The **only** new file allowed to import `lib/supabase/admin.ts` — the ESLint `no-restricted-imports` rule gains this one path. Exports `checkInTicket(caller, eventId, code)` and `checkInNextTicket(caller, eventId, bookingId)`. Each loads the event's host (service-role read), passes it through `mayCheckIn`, then calls the RPC |
| `lib/checkin/authorize.ts` | `mayCheckIn(caller, event: { host_profile_id })` — pure, exhaustively unit-tested, no database. The whole of the rule: only the event's host checks tickets in |
| `lib/checkin/rpc-errors.ts` | Maps `EH020`–`EH022` to the sentences above, following `lib/bookings/rpc-errors.ts` |
| `lib/tickets/queries.ts` | RLS reads: `listBookingTickets(bookingId)` for the booking page. The existing policies scope it; the module comment carries the same "RLS is the protection, not the scoping" warning as `lib/bookings/queries.ts` |
| `lib/env.ts` | `TICKET_SIGNING_SECRET` is already in the server schema as `z.string().min(32).optional()`. Drop the `.optional()` — this phase is what it was optional *for* — and generate a value into `.env.local` |

Caller identity reuses `lib/bookings/caller.ts` — the branded `Caller` is not
booking-specific and a second brand would weaken the "one way to mint identity"
argument.

## Screens

| Route | Contents |
|---|---|
| `/bookings/[reference]` | Gains a Tickets section: one QR per ticket as server-rendered SVG, labelled "Ticket n of N", with the short code tail printed under each so a host can eyeball-match a screenshot to a row. Payload built server-side with `buildQrPayload`; the event key is derived per render and never leaves the server |
| `/host/events/[id]/scan` | New, host-only: `requireUser()` + `getOwnedEvent(id)` → 404, same as the guest list. The server component derives the event key hex and hands it to a client scanner component along with the event id |
| `/host/events/[id]/attendees` | Each row gains "n of q in" and a **Check in +1** button posting to a Server Action → `checkInNextTicket`. This is the fallback for no camera, no Chrome, and no QR alike. A link to `/scan` sits at the top |

The scanner client component:

- `getUserMedia` rear camera into a `<video>`, `BarcodeDetector` polled on an
  interval — the loop stays thin and dumb.
- Every decoded string goes through a **pure session reducer**
  (`scan-state.ts`, unit-tested): dedupes repeat reads of the payload currently
  on screen, holds the verdict card until dismissed or a *different* payload
  arrives, so one QR held up does not machine-gun the Server Action.
- Locally-invalid payloads (`verifyQrPayload` with the event key) go red with
  the reason and never touch the network.
- Locally-valid ones post to the check-in action; the card shows green with
  the attendee's name and "2 of 3 in", amber with the original time for
  `already_checked_in`, red with the mapped sentence for `EH02x`.
- No `BarcodeDetector` → no camera starts; the screen says scanning needs
  Chrome and links to the guest list.

QR rendering uses the `qrcode` npm package (plus `@types/qrcode` dev) —
server-side `toString(payload, { type: 'svg' })`, zero client JavaScript on the
attendee page. This is the phase's one new runtime dependency.

## Testing

Same layers as 2a, plus the crypto seam:

- **Concurrency, the door's version.** Two simultaneous `check_in_ticket` calls
  on one ticket: exactly one `checked_in`, one `already_checked_in`, against
  the real database. Two simultaneous `check_in_next_ticket` on a 3-ticket
  booking: two *different* tickets in.
- **Authorisation as attempts that must fail.** A host cannot check in a ticket
  for an event they do not host — both through `mayCheckIn` (unit) and through
  the event-id mismatch arriving as `EH020` (integration). A signed-out caller
  is redirected before the form is read, in the action tests, mocked at the
  same seams as the cancel-action suites.
- **The guards, by SQLSTATE.** Unknown code → `EH020`. Fully-checked-in booking
  → `EH022`. (`EH021` gets a test if a state can be manufactured; otherwise its
  unreachability comment stands in.)
- **Round trip.** `buildQrPayload` on the server for a real ticket →
  `verifyQrPayload` with the derived key → the returned code checks in. The
  same payload against a *different* event's key → `bad_signature`.
- **`scan-state.ts`** exhaustively, no browser: dedupe, dismissal, the
  amber/green/red transitions.
- **Browser verify (manual + Playwright).** Book → QRs render on the booking
  page → guest list shows "0 of n in" → Check in +1 moves it → scanner page
  loads and degrades correctly where `BarcodeDetector` is absent. The camera
  path itself is verified on a physical phone, not in CI — Playwright cannot
  hold a QR up to a webcam it does not have.

## Migration and types

- `supabase/migrations/20260811000001_ticket_checkin.sql`
- `npm run db:types` after; `lib/supabase/types.ts` is committed.

## Known limitations, deliberate

- **No un-check-in.** A mistap leaves a ticket checked in; the guest it happens
  to arrives to an amber card carrying the mistap's own timestamp, which the
  host at a 12-seat supper club will recognise. Undo is a real feature with an
  audit-trail question attached; it is not smuggled in here.
- **The scanner requires signal.** Offline verification is designed for — the
  key is already local, the verify already runs in-browser — but the queue, the
  cached ticket list and the sync are Phase 7, where the v1 build order puts
  them.
- **`checked_in_offline` stays false** everywhere this phase touches. It
  belongs to Phase 7's sync path.
