# Phase 2a — Free bookings and ticket issuance

Follows [`2026-08-08-event-platform-v1-design.md`](2026-08-08-event-platform-v1-design.md).
Phase 1 (event creation, publishing, the public link) is on `master`.

## Goal

> Someone taps a WhatsApp link, taps Book, and has a seat. The host can see who
> is coming.

Phase 2 in the v1 build order is "free bookings, ticket issuance, QR, host
scanner — full loop, zero payment risk, pilot starts here." That is four
subsystems. This spec is **2a**: booking and ticket issuance. QR signing and the
host scanner are **2b**, a separate spec, and depend on this one.

## Scope

**In:** an attendee books a free event; ticket rows are issued; attendee and
host can each see and cancel bookings.

**Out:** payment (Phase 3), QR and scanner (2b), approval flow, cash, waitlist
(Phase 5), WhatsApp notifications (Phase 4).

**Only free, no-approval events are bookable.** A published event with
`price_paise = 0` and `requires_approval = false` gets a working Book control.
Anything else keeps the disabled "Booking opens soon" that Phase 1 shipped. A
host who set a price or ticked approval has built something this phase cannot
honour, and the honest thing is to say so rather than confirm strangers at their
door or let people in free.

## What Phase 0 already built

Nearly all the database. `bookings` and `tickets` exist, as do:

| Function | Does |
|---|---|
| `reserve_tickets` | Validates published status, sales window, `max_per_order`, availability; takes a row lock on the ticket type; increments `reserved_count`; inserts a booking as `awaiting_payment` with a hold |
| `confirm_booking` | `awaiting_payment` → `confirmed`, clears the hold, inserts one `tickets` row per seat with a 128-bit hex code. Idempotent |
| `cancel_booking` | Returns inventory, marks cancelled, deletes tickets that have not been checked in. Idempotent |
| `release_expired_holds` | Sweeps lapsed holds back into inventory |

All four are `SECURITY DEFINER` with `EXECUTE` revoked from `anon` and
`authenticated`. This phase adds one function and four screens; it does not
rewrite inventory logic.

## The trust boundary moves — and this is the phase's main risk

`bookings` and `tickets` have **no insert or update grant to `authenticated`**,
by design: 20260808000003 says writes there "are intentionally NOT grantable to
clients … so inventory and money can never be mutated by a crafted PostgREST
call." The functions that do those writes are unreachable over RPC by a signed-in
user.

So the Server Actions in this phase call them as the **service role**, through
`lib/supabase/admin.ts`. Phase 1's global constraint — never use `admin.ts` in
application code — does not survive this phase, and cannot: it was a Phase 1
rule for a phase whose every write RLS could scope.

**The consequence is the thing to hold on to: RLS does not protect these writes.**
It filters reads only. Every authorisation decision is hand-written TypeScript,
and a missed one is not a defect in the ordinary sense — it is a stranger
cancelling someone else's booking, or booking under their name.

### The considered alternative, and why it was rejected

`auth.uid()` works inside a `SECURITY DEFINER` function — it reads the request's
JWT claim, not the database role, which is why `current_host_id()` in
20260808000003 is itself `security definer` and calls it. So the functions could
instead have been granted `EXECUTE` to `authenticated` and authorised themselves
in SQL, next to the write and under the same row lock, with no service role in
application code at all.

That was rejected deliberately in favour of keeping the PostgREST surface as
narrow as Phase 0 drew it: nothing that touches inventory is reachable from a
browser, full stop. The trade is explicit — a narrower reachable surface bought
with a wider hand-written authorisation surface. This section exists so the
trade is a recorded decision rather than an accident, and so the mitigations
below are understood as load-bearing rather than tidy.

### Mitigation: authorisation is structural, not remembered

One module, `lib/bookings/service.ts`, is the **only** file in `app/` or `lib/`
permitted to import `lib/supabase/admin.ts`. An ESLint `no-restricted-imports`
rule enforces that, so a second call site is a lint failure rather than a code
review miss.

Every function it exports takes a caller identity as its first argument, of a
type that cannot be built by hand:

```ts
// lib/bookings/caller.ts
declare const brand: unique symbol
export type Caller = { readonly id: string; readonly [brand]: true }

/** The only way to obtain a Caller. Returns null when signed out. */
export async function currentCaller(): Promise<Caller | null>
```

The branded type is the point. `bookFreeTickets(userIdFromForm, …)` does not
compile, because a bare string is not a `Caller` and nothing exported can turn
one into a `Caller`. Identity therefore always originates from the verified
session, and forgetting to check is a type error rather than a silent hole.

Cancellation still needs a real check, since being signed in is not enough:

```ts
// lib/bookings/authorize.ts — pure, unit-tested, no database
export function mayCancel(
  caller: Caller,
  booking: { attendee_id: string; event_host_profile_id: string },
): boolean
```

Pure and separately tested, so the rule can be exercised exhaustively without a
database, and both call sites get the same answer.

## The write path

One new function:

```sql
book_free_tickets(p_ticket_type_id uuid, p_attendee_id uuid, p_quantity integer,
                  p_attendee_note text default null)
  returns bookings
```

`SECURITY DEFINER`, `set search_path = public, extensions` (matching
`confirm_booking`, which needs `gen_random_bytes`), `EXECUTE` revoked from
`public`, `anon` and `authenticated`.

Body: guard that the ticket type's `price_paise = 0` and its event's
`requires_approval` is false, raising a distinct SQLSTATE for each, then
`reserve_tickets(...)` followed by `confirm_booking(...)`.

Nested plpgsql calls run inside the caller's transaction, so reserve and confirm
are atomic without either Phase 0 function being modified — the 50-concurrent-
booking test keeps guarding exactly what it guards. The alternatives were two
RPCs from the Server Action, which reintroduces the two-transaction shape this
project removed from event writes on 2026-08-09, and a new parameter on
`reserve_tickets`, which edits the most load-bearing tested function in the repo
to save one small wrapper.

`reserve_tickets`' remaining parameters keep their defaults: zero convenience
fee, zero commission, `payment_mode = 'online'`, a 10-minute hold that
`confirm_booking` clears microseconds later. A free booking therefore lands with
`payment_mode = 'online'` and `total_paise = 0`, which reads oddly and is
correct — the column records how the attendee *would* pay, and 'cash' means
something specific that Phase 5 introduces. Do not add a 'free' mode for it.

The free and no-approval guards live in SQL rather than only in the Server
Action because they are the conditions under which issuing a confirmed ticket is
correct at all. A caller that forgets them is asking for something that should
not be possible, and the answer should not depend on which caller asked.

## Errors

Following the pattern `lib/events/rpc-errors.ts` established:

| Code | Raised when | Attendee sees |
|---|---|---|
| `EH010` | ticket type is not free | "This event is not free yet" |
| `EH011` | event requires approval | "This host approves guests before booking" |
| `EH012` | the attendee already holds an active booking on this event | "You have already booked this event. Cancel that booking first to change it." |
| `EH013` | `starts_at` has passed | "This event has already started." |
| existing | `reserve_tickets` raises `check_violation` for sold out, closed sales, over `max_per_order` | the raised message, which is already written for a human |

`reserve_tickets` already produces sentences a person can read ("only 3 seats
remain", "sales have closed"), so those pass through rather than being remapped.

## Screens

| Route | Contents |
|---|---|
| `/e/[slug]` | Quantity picker (1..`max_per_order`) and Book. Signed out → `/login?next=/e/[slug]`, which Phase 1 already built. Sold out → disabled with the count |
| `/bookings/[reference]` | Confirmation: reference, event, date, venue, seat count, cancel. Readable by the attendee only. **This is the pilot's ticket** until 2b adds a QR |
| `/bookings` | The signed-in attendee's bookings, newest first, each cancellable |
| `/host/events/[id]/attendees` | Guest list for one event: name, seats, booked-at, total seats taken, cancel any |

The confirmation page is keyed on `reference`, not `id`, because it is the
string a host reads aloud at the door and the one an attendee screenshots.

## Testing

- **Concurrency, mandatory.** 50 simultaneous bookings at a 10-seat event;
  exactly 10 succeed and `reserved_count` lands on 10. The v1 spec requires this
  before Phase 3, and this is the first phase where it can run against the real
  booking entry point rather than `reserve_tickets` alone.
- **Authorisation, written as attempts that must fail.** A third party cannot
  cancel someone's booking. A host can cancel on their own event and not on
  another host's. A signed-out caller gets nothing.
- **Cancellation returns inventory.** `reserved_count` drops and the seat is
  bookable again.
- **The guards.** A paid event and an approval event each refuse, by SQLSTATE.
- **`mayCancel`** unit-tested exhaustively with no database.
- **`EH001` becomes reachable for the first time.** With `reserved_count`
  non-zero, a host cutting capacity below it now fires the path Phase 1 built
  and could not exercise end to end. Worth one test through the real UI path.

## Migration

`supabase/migrations/20260810000001_book_free_tickets.sql`. `npm run db:types`
after; `lib/supabase/types.ts` is committed.

## Amended after the pre-implementation audit

Four things in this spec were checked against the codebase before the plan was
executed, and each was wrong. Recorded here rather than silently rewritten
above, because the reasoning that produced them is the reasoning most likely to
produce them again.

**The host guest list could not have worked.** It was to read
`bookings.profiles(full_name, phone)`. `profiles_select_own` is `id =
auth.uid()` and is the entire SELECT surface on that table
(`20260808000003_rls_policies.sql:61`), so the embed returns `null` for every
attendee — with no error, because RLS filters rather than refuses. The page
would have rendered "Guest" and a blank phone for every row while every
row-counting test passed. `profiles.full_name` is also null for every user who
has ever existed: `handle_new_user()` writes `id` and `phone` and nothing else
(`20260808000001_core_schema.sql:64`).

Resolved by adding `bookings.attendee_name`, filled from a required field in the
Book panel. The host reads the name the guest chose to give; no phone number
moves, and `profiles` stays owner-only. This also gives Phase 2b's unwritten
`tickets.attendee_name` its first source.

**Nothing bounded how often one person could book.** `max_per_order` bounds a
single order, so ten single-seat bookings take a ten-seat supper club, each one
individually within the rules. Resolved by one active booking per attendee per
event, enforced by a partial unique index on the active statuses — not by a
check in the function, which would race with itself. Cancelling frees the slot,
so it is "one at a time", not "one ever".

**A finished event stayed bookable.** `reserve_tickets` validates published
status and the sales window; a past event passes both, and `sales_start` /
`sales_end` are null on every event this product creates. The feed hides past
events but the WhatsApp link does not, and the link is the whole distribution
model. Resolved by a `starts_at` guard.

**There was no way to reach `/bookings`.** This app has no navigation at all —
`app/layout.tsx` is `<body>{children}</body>`, and every link in the product is
hard-coded into the page that needs it. The route would have been reachable only
by typing the URL. Resolved by a link in the feed header beside "Host an event".

One assumption the audit confirmed rather than corrected: every page here is
dynamically rendered, because `lib/supabase/server.ts` awaits `cookies()` on
every query path. The seats-left count is never stale on a fresh request.
`revalidatePath` is still called after a booking, for Next's client Router Cache
on back navigation.

## Notes for 2b

`confirm_booking` already writes `tickets.code` as 128 bits of hex. 2b derives
the QR signature from that code plus a per-event key and never stores it, so the
two cannot drift. `TICKET_SIGNING_SECRET` is already in `.env.example`. Nothing
in 2a should write or read a signature.
