# Atomic event writes

Closes the gap the Phase 1 code documents against itself. Follows
[`2026-08-08-phase-1-events-design.md`](2026-08-08-phase-1-events-design.md).

## Goal

> Saving an event either happens or does not. A host is never told "failed" and
> left with half of what they typed already in the database.

## The gap

`app/host/events/actions.ts` makes two writes per save and has no transaction
around them. Both call sites say so in their own comments.

**`createEvent`** inserts the event, then inserts its ticket type. If the second
fails it compensates by deleting the event. That compensation is itself a
separate statement: a crash or a dropped connection between them strands an
event with no ticket type. Such an event can never be published — `publishEvent`
blocks on the missing inventory — and no screen in the product can add one. The
code already handles the rollback *erroring*, by returning a message asking the
host to quote the event id to support. It cannot handle the rollback never
being reached.

**`updateEvent`** writes seats and price to the ticket type, then writes the
event row. The ticket write goes first deliberately, because it carries the
`ticket_types_no_oversell` constraint, so a rejection there leaves the event
untouched. The mirror image is unhandled: if the ticket write succeeds and the
event write fails, the seats have moved and the title, venue and times have not.

Both are tolerable only while `reserved_count` is always 0. Phase 2 ends that.

## Scope

**In:** the two writes inside `createEvent` and the two inside `updateEvent`.

**Out:**

- The `hosts.display_name` rename in `updateEvent`. It stays a separate write,
  outside the transaction and last, for the reason its comment already gives —
  renaming yourself changes every event page you have, so it must not ride along
  with an edit that was refused.
- `resolveOrCreateHost` in `createEvent`. It runs before the transaction. A
  `hosts` row created by an attempt that then fails is harmless and idempotent:
  the next attempt finds it.
- The column-level grant on `ticket_types`. See "Noted, not fixed".

## Architecture

Two `SECURITY INVOKER` plpgsql functions, called over PostgREST RPC by the
existing RLS-scoped user client. PostgREST runs one RPC in one transaction, so
both writes commit or neither does.

```sql
create_event_with_ticket_type(p_host_id, p_slug, …, p_price_paise, p_quantity)
  returns events

update_event_with_ticket_type(p_event_id, …, p_price_paise, p_quantity)
  returns events
```

`returns events` because the caller needs `id` (to redirect after create) and
`slug` (to revalidate after update), and the row carries both.

### Why invoker, when Phase 0 uses definer

`supabase/migrations/20260808000002_reservation_functions.sql` is `SECURITY
DEFINER` with `EXECUTE` revoked from `anon` and `authenticated`. That posture is
correct there and wrong here, and the difference is what each file protects.

Those functions guard inventory and money. `reserved_count` must not be
mutable by a crafted PostgREST call, so the functions bypass RLS to do their own
locking and are made unreachable from a browser.

These two guard a write the caller is *already* entitled to make. Phase 0 has
already granted `authenticated` scoped `insert`/`update`/`delete` on `events`
and `ticket_types`, narrowed by `current_host_id()`, and the RLS tests prove that
model. Under `SECURITY INVOKER` the body runs as the calling role with the
caller's `auth.uid()`, so `events_insert_own`, `events_update_own` and
`ticket_types_write_own` evaluate on every statement inside exactly as they do
today. Nothing new is authorised; the statements are only moved into one
transaction.

The rejected alternative was `SECURITY DEFINER` plus the service role, matching
Phase 0's file. It bypasses RLS, so the function would have to re-implement
ownership checking by hand — a second copy of what the policies already say,
which can drift from them — and it requires `lib/supabase/admin.ts` in a Server
Action, which the Phase 1 plan forbids outright. Same guarantee, more code, more
surface.

Both functions take `set search_path = public`, as every function in this repo
does. `EXECUTE` is granted to `authenticated`.

### Parameters

Explicit named parameters, not a single `jsonb` payload. `npm run db:types`
generates a typed `Args` for each function, so a field forgotten when the form
grows is a compile error rather than a silent `null` overwriting a column.

### What stays in TypeScript

`buildSlug`, `istLocalToUtc`, `rupeesToPaise` and `parseEventForm` keep their
unit tests and their current call sites. The functions receive finished values —
a UUID, a slug, `timestamptz`, integer paise. No logic that has a test today
moves into SQL.

### Inside `update_event_with_ticket_type`

Order, unchanged from the TypeScript it replaces:

1. `select … for update` on the event's first ticket type, ordered by
   `sort_order` then `created_at` — the same `TICKET_TYPE_ORDER` every read
   uses, so "the" ticket type is the row the edit form printed from.
2. Oversell check: raise if `p_quantity < reserved_count`.
3. Write seats and price to that row, inserting one named `General` if the event
   has none.
4. Write the event row.

The `for update` is new. It serialises against a concurrent booking, which is
what makes the check in step 2 still true at commit — the property Phase 2 needs
and Phase 1 gets for free because `reserved_count` is still 0.

### Inside `create_event_with_ticket_type`

Insert the event, insert the ticket type, return the event. The hand-rolled
compensating `delete` disappears, and with it the "the half-created event could
not be removed either — quote event id" branch, which exists only to report the
failure of a mechanism this design removes.

## Errors

Failures arrive as raised exceptions carrying a SQLSTATE. A new pure module
`lib/events/rpc-errors.ts` maps them back to the `EventFormState` the actions
return today.

| Code | Raised when | Maps to |
|---|---|---|
| `EH001` | `p_quantity < reserved_count` | `{ blockers: ['12 of those seats are already taken, so capacity cannot go down to 8'] }` |
| `EH002` | the update matched no row — wrong id, or RLS refused it | `{ error: 'That event is not yours to edit' }` |
| anything else | — | `{ error: err.message }` |

Wording is identical to the current strings, down to the sentence structure, so
existing assertions keep passing and no host sees a change. Oversell stays in
`blockers`, not `error`: it is a fixable condition, not a fault, and the form
renders the two differently.

`values: submittedValues(formData)` is still attached on every rejection path.
The reason is unchanged and still load-bearing: a host may have just typed the
venue that clears a publish blocker, and a refusal must not take it away.

## Testing

Test-driven. Every test is watched failing before the code that satisfies it
exists.

| Test | Kind | Asserts |
|---|---|---|
| `lib/events/rpc-errors.test.ts` | unit, no database | each code maps to the exact state; unknown codes fall through to `err.message` |
| `lib/events/atomicity.test.ts` | integration | the properties below |

A **new file**, not an addition to `lib/events/actions.test.ts`. That file is
order-dependent: `eventId` and `slug` are set by earlier tests and later tests
mutate the same event. The new file seeds its own event and cleans up after
itself.

**The atomicity proof.** Call `update_event_with_ticket_type` with a valid
`p_quantity` change *and* an `ends_at` at or before `starts_at`, which trips the
existing `events_end_after_start` constraint on the second write. Assert the call
errors, then assert `quantity` is unchanged. Run against today's two-statement
implementation that test fails, because the seats have already moved — which is
the gap, stated as an executable claim.

**`createEvent` is different, and the difference is worth being honest about.**
The equivalent test — pass `p_quantity = 0`, tripping `ticket_types`'
`check (quantity > 0)` on the second insert, then assert no event row survives —
**passes against the current implementation too**, because the compensating
`delete` runs and succeeds. Today's code and a transaction are observably
identical whenever compensation is reached. Nothing a black-box test can do
distinguishes them; what separates them is the case where compensation is *not*
reached, which means killing the process mid-call.

So this one gets no mutation evidence, and the plan must not claim any. The test
is a regression guard on the invariant — no event without inventory, ever — and
the argument for the change is structural: the compensating `delete` and its
failure branch stop existing, so the window they leave open stops existing with
them. `updateEvent`'s test is the one that genuinely fails first.

Existing 205 tests stay green. The actions' external contract does not change.

### Confirmed before it is depended on

The exact shape supabase-js gives a plpgsql `raise … using errcode, detail` —
whether `detail` survives as `error.details`, and what `error.code` holds for a
non-standard SQLSTATE class — is behaviour the mapper would be built on. The
first test written confirms it empirically against real local Postgres. If
`detail` does not survive, the fallback is encoding the reserved count in the
message and parsing it there.

## Migration

`supabase/migrations/20260809000001_event_write_transactions.sql`. Applied with
`npm run db:reset`; `npm run db:types` after, and `lib/supabase/types.ts` is
committed, per the Phase 1 global constraints.

Integration tests need `npm run db:start`, which needs Docker Desktop, which on
this machine starts only via PowerShell. See the handoff.

## Noted, not fixed

`grant insert, update, delete on ticket_types to authenticated` is table-level.
`reserved_count` is therefore directly writable by a host on their own ticket
types, so a host could zero it and oversell their own event. Unrelated to
atomicity, pre-existing since Phase 0, and fixing it means a column-level grant
plus the RLS tests that pin it. Recorded here so it is not rediscovered as new.
