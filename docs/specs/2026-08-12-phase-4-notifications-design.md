# Phase 4 — Notifications: the product stops waiting to be refreshed

**Date:** 2026-08-12
**Status:** approved in brainstorming, awaiting implementation plan
**Builds on:** [`2026-08-08-event-platform-v1-design.md`](2026-08-08-event-platform-v1-design.md) (build order row 4),
[`2026-08-11-phase-5b-waitlist-design.md`](2026-08-11-phase-5b-waitlist-design.md),
[`2026-08-11-phase-5a-approvals-cash-design.md`](2026-08-11-phase-5a-approvals-cash-design.md),
[`2026-08-10-phase-3-payments-design.md`](2026-08-10-phase-3-payments-design.md)

## Goal

Every outcome this product produces currently arrives only if the person
concerned happens to open a page. A seat offer expires unseen, a host does
not know a request is waiting, and nobody is reminded of an event they paid
for. This phase gives each of those moments a WhatsApp message, over the
same channel the login OTP already uses.

The waitlist feels the absence most sharply: 5b's own limitations say a
freed seat can spend twenty-four hours per inattentive person in line, with
the host's only recourse a phone call from the payment-pending strip. That
is the sentence this phase deletes.

## Scope

In: the Meta Cloud API adapter behind the existing provider seam; eight
approved templates; `message_log` as a real outbox with retries and a dead
letter; a state sweep that decides what needs sending; a Vercel Cron route
that drives it and finally schedules Phase 3's hand-run reconciliation.

Out, deliberately: marketing templates of any kind (₹0.8631 each and not
what this product is for); email and SMS (WhatsApp is the channel — v1
finding 5); in-app or push notifications (Phase 7 owns the PWA); delivery
receipts and read status from Meta's webhooks (a second webhook surface for
information nothing acts on); quiet hours and per-user notification
preferences (a pilot at this scale sends a handful of messages per person,
all of them transactional); and any host-facing digest or summary.

## What already exists

Phase 0 built most of the seam and then stopped, which is why this phase is
smaller than its build-order row suggests:

- **`lib/notifications/`** — a `NotificationProvider` interface, a working
  `LogNotificationProvider`, a `notificationProvider()` factory with a
  `__setNotificationProvider` test seam, `normalisePhone`, and
  `renderTemplate` / `templateComponents` for positional `{{n}}` arguments.
- **A template registry** carrying six definitions with bodies, categories
  and purposes, written explicitly as "a deliverable for day one".
- **`message_log`** — recipient, template, `booking_id`, provider,
  `provider_message_id`, `status` defaulting to `'queued'`, `error`,
  `cost_paise`, and a **`UNIQUE dedupe_key`**. Nothing has ever written to
  it.
- **One live send site** — `app/api/hooks/send-sms/route.ts`. Supabase Auth
  calls it instead of sending an SMS, so the login OTP already travels over
  WhatsApp. It verifies a Standard Webhooks signature and returns 502 when
  delivery fails, so the user is not left waiting for a code.
- **`WHATSAPP_PROVIDER: 'log' | 'meta' | 'aisensy'`** in `lib/env.ts`, with
  `'meta'` and `'aisensy'` currently throwing "not implemented yet
  (Phase 4)".

What does not exist: any provider that reaches WhatsApp, any write to
`message_log`, any scheduled work at all, and a template for the waitlist.

## The dependency that gates everything

**The WhatsApp Business Account does not exist and no template has been
submitted.** Nothing in this phase can be verified against reality until it
does, and two facts make the order matter:

1. **The WABA must be created with India as Sold-To country and INR
   billing.** A WABA registered elsewhere bills authentication messages at
   ~₹2.30 instead of ~₹0.115 — twenty times more — and **the setting cannot
   be changed afterwards.** This is v1 finding 4 and it is irreversible.
2. **Approval takes hours to days per round.** Therefore all eight
   templates are submitted as one batch, and the registry is finalised
   before submission rather than after.

Everything else in this phase is built and tested against the log provider
and a fake, so the code is complete and green before approval lands. Going
live is then a change of one environment variable.

**The gap between deploy and approval is the dangerous part, and the order
is: provider first, cron second.** Do not set `CRON_SECRET` in Vercel
Production until `WHATSAPP_PROVIDER=meta` is live. With the provider still
`log` the sweep decides real messages for real bookings, the drain marks
them `sent`, and `dedupe_key` then guarantees they are never enqueued
again — so a tick that runs in that window does not delay a confirmation,
approval, waitlist offer or cancellation, it consumes it, and no later tick
recovers it. This is the same failure `NOTIFICATIONS_LAUNCH_AT` exists to
prevent, pointed the other way. An unset `CRON_SECRET` 401s every tick, so
leaving it unset until the switch keeps the door shut by default. If a tick
does run against `log`, nothing left the machine and the window is
recoverable in one statement — see the handover in
[the plan](../plans/2026-08-12-phase-4-notifications.md).

## Decisions taken in brainstorming

**Meta Cloud API direct, not a BSP.** The per-message economics the whole
business model rests on (~₹0.115, utility free inside an open 24-hour
service window) are Meta's list price; a BSP adds a monthly platform fee the
v1 costing never budgeted. Rejected: AiSensy and similar, which trade that
fee for easier onboarding and a template UI — worth revisiting only if
Facebook Business verification stalls. The `'aisensy'` enum member stays as
a documented escape hatch and keeps throwing.

**Eight templates, one submission.** The six from Phase 0, plus
`waitlist_seat_offered` and `request_declined`. Rejected: shipping the v1
build-order four and queuing again for the rest, which buys a smaller first
batch at the price of a second multi-day approval round for the message the
waitlist most needs.

**Vercel Cron, not `pg_cron`.** The v1 design said scheduled work would use
`pg_cron`, but sending requires an outbound HTTP call, so that route means
`pg_cron` plus `pg_net` calling back into the app, or a queue the app drains
anyway. A cron-invoked API route authenticated by a shared secret is the
same shape as the two authenticated entry points this app already has, and
it is testable by curling it. Rejected: `pg_cron` (more moving parts, harder
to test) and a hand-run script like `npm run reconcile` (a reminder is only
a reminder if it runs on time).

**An outbox, with the OTP alone synchronous.** Non-OTP messages are written
as `queued` rows and drained by the sweep. The rule is *the only synchronous
send is the one a human is actively waiting on*. This keeps a third party's
latency out of the Razorpay webhook — a path Phase 3 built to be idempotent
and fast, and which Razorpay retries on timeout — and turns a failed send
into a row that retries rather than an event that is simply lost. Rejected:
inline fire-and-forget at each site (a send that fails at 2am is gone, and
the payment-capture path would call Meta), and a fully synchronous outbox
including OTP (Supabase's auth hook needs a real answer).

**No send sites: the sweep derives what to send from state.** Every non-OTP
message is a function of booking state, so nothing in `lib/bookings/`,
`lib/payments/` or any SQL function changes. This is the decision that makes
the phase small, and it also means messages are owed for bookings that
already exist, not only for ones created after it ships. Rejected: enqueuing
inside the SQL state-change functions (genuinely transactional, but it
recreates four functions Phase 5b just rewrote and puts message concerns
inside inventory functions) and enqueuing in TypeScript at each call site
(five call sites for `booking_confirmed` alone, and a crash between the RPC
and the enqueue still loses the message).

**A cutoff, because the sweep can see history.** Deriving from state means
the first run would otherwise message everyone about every event that has
already happened. The sweep considers only bookings on events that have not
started, and only bookings created at or after `NOTIFICATIONS_LAUNCH_AT` —
an ISO timestamp in the environment, set once when the phase goes live. It
is environment rather than code so that staging and production can differ,
and so a first run can be rehearsed by moving it forward.

## Schema delta

One migration, `20260812000001_message_outbox.sql`:

- `message_log.variables jsonb not null default '{}'::jsonb` — without this
  the outbox cannot function: a row records *which* template to send but not
  what to fill it with, so a message queued on one tick could not be sent on
  the next. Written at enqueue time deliberately — the message was decided
  then and should say what it said then, and it makes "what exactly did we
  tell this person" a query rather than a reconstruction.
- `message_log.attempts integer not null default 0` — `status` and `error`
  exist, but nothing counts tries, so a permanently failing message would
  retry until the end of time. **After 5 attempts** the row goes `dead` and
  the drain ignores it. Five rather than three because the drain's interval
  is hours, not seconds: a transient Meta outage should not exhaust the
  budget before anyone could notice it.
- `message_log.status` gains the values the code actually uses. Today it is
  free text defaulting to `'queued'`; the sweep uses `queued`, `sent`,
  `failed`, `dead`. A CHECK constraint pins the set rather than an enum, so
  adding a state later does not need the two-migration dance
  `booking_status` needed in 5b. The table has never been written to, so the
  constraint cannot fail on existing rows.
- `message_log_pending_idx on message_log (status, updated_at)`, partial on
  `status in ('queued','failed')` — the drain's index, kept tiny the way
  `bookings_expiring_idx` is.

`message_log` keeps its existing RLS posture: no policy, service-role only,
exactly as `fee_rules` and `provider_webhook_events` are, and as
`lib/supabase/rls.test.ts` already asserts.

## The templates

Eight, submitted as one batch. All utility except `auth_otp`, which is
authentication and therefore format-restricted (no links, no emoji).

| Template | Recipient | Says |
|---|---|---|
| `auth_otp` | anyone logging in | the code. **Already live.** |
| `booking_confirmed` | attendee | you're in, with the reference; QR is in the app |
| `event_reminder` | attendee | it's tomorrow |
| `booking_cancelled` | attendee | the host removed your booking, plus the refund position |
| `approval_requested` | **host** | someone asked for a spot |
| `approval_granted` | attendee | you're approved — pay by the deadline |
| `waitlist_seat_offered` | attendee | **new.** a seat opened up, held until the deadline |
| `request_declined` | attendee | **new.** the host couldn't fit you in |

`waitlist_seat_offered` deliberately says nothing about money, so one
template serves both the pay-online and claim-a-cash-or-free-seat paths:

> Hi {{1}}, a seat opened up for {{2}}. It's held for you until {{3}} —
> open your booking to take it.

`request_declined` exists because `booking_cancelled` opens with "your
booking has been cancelled", which is false for someone who asked and was
turned down. It carries the tone the booking page already uses.

Two corrections to the Phase 0 registry, both about accuracy rather than
copy:

- **`approval_granted` must not be sent for cash or free approvals.**
  `approve_booking` confirms those straight from `pending_approval`, so
  there is no payment to complete and no hold to beat; they get
  `booking_confirmed`. The template's wording is right for the case it
  covers — the routing is what has to know.
- **`booking_confirmed`'s purpose line says "sent immediately on payment
  capture".** It now also covers free bookings, cash bookings, an approved
  cash or free request, and a claimed waitlist seat. Copy stands, purpose
  widens.

## What the sweep derives

One pass, in this order, keyed by `dedupe_key` so every decision is
idempotent and re-running is free.

| Message | Condition | `dedupe_key` |
|---|---|---|
| `booking_confirmed` | `status = 'confirmed'` | `booking:<id>:confirmed` |
| `approval_requested` | `status = 'pending_approval'`, to the event's host | `booking:<id>:requested` |
| `approval_granted` | `awaiting_payment` + `approved_at`, event `requires_approval` | `booking:<id>:approved` |
| `waitlist_seat_offered` | `awaiting_payment` + `approved_at`, event `has_waitlist` | `booking:<id>:offered` |
| `booking_cancelled` | `cancelled` **or `refunded`**, reason `cancelled by host` | `booking:<id>:cancelled` |
| `request_declined` | `cancelled`, reason `declined by host` | `booking:<id>:declined` |
| `event_reminder` | `confirmed`, `starts_at` between now and 24 hours out | `booking:<id>:reminder` |

`cancellation_reason` is load-bearing: it separates "the host removed you"
(say so) from "you cancelled it yourself" (say nothing — they did it) from
"payment hold expired" (already the whole story on their page).

**`booking_cancelled` must match `refunded` as well as `cancelled`, and this
is the derivation most likely to be got wrong.** `cancel_booking` sets
`cancelled`, but `refundIfOwed` then flips a booking that had a captured
payment to `refunded` at refund *creation* — keeping `cancellation_reason`
untouched. So a host removing a **paid** guest ends at `refunded`, and a
sweep matching only `cancelled` would silently skip precisely the people
whose money moved. `request_declined` needs no such arm: a request never
held a payment, so it can never reach `refunded`.

That distinction also fills the template's `refundNote` variable — a
`refunded` row says the money is on its way, a `cancelled` one says no
payment was taken. The two
`awaiting_payment` + `approved_at` rows are separated by the event flags,
which `events_one_queue` keeps mutually exclusive — the same inference every
copy branch in 5b makes, and it carries the same caveat, recorded in that
spec's "Carried into Phase 6": a booking row outlives the toggle that
describes it, so a host untoggling mid-flight can produce the wrong sentence.

Nothing is sent for a `waitlisted` row. Being in a line is not news, and a
message per join would be the one thing that makes a queue feel like spam.

## The flows

**Login.** Unchanged, and deliberately so. Supabase Auth calls the send-sms
hook, the hook calls `notificationProvider().send()` synchronously, and a
failure returns 502 so the user is told rather than left waiting. The only
difference after this phase is which provider answers.

**Everything else.** Cron calls `/api/cron`, which authenticates a shared
secret and runs three things in order: the state sweep (enqueue what is
owed), the outbox drain (send what is queued or failed and not yet dead),
and Phase 3's reconciliation sweep, which has been hand-run since it was
written. Each message is a `message_log` row from the moment it is decided,
so "what did we send this person" is a query rather than a guess.

**Failure.** The provider returns a `SendResult`; a failure stamps `failed`
with the error and increments `attempts`, and the next tick tries again
until `MAX_ATTEMPTS`, after which the row is `dead` and ignored. Nothing
about a failed message affects the booking it describes — the same posture
`refundIfOwed` takes, for the same reason.

## Application modules

| File | Responsibility |
|---|---|
| `lib/notifications/providers/meta.ts` | **New.** The Meta Cloud API adapter: `POST /{phone-number-id}/messages` with positional template components. The only module that knows Meta's wire format. |
| `lib/notifications/index.ts` | **Modified.** `'meta'` stops throwing. |
| `lib/notifications/templates.ts` | **Modified.** Two new definitions; two corrected purpose lines. |
| `lib/notifications/sweep.ts` | **New.** Pure decision layer: given booking rows and a clock, which messages are owed and under which `dedupe_key`. No database, no provider, no I/O — the phase's logic lives here so it can be tested exhaustively without either. |
| `lib/notifications/service.ts` | **New.** The only module holding the service role: the reads `sweep.ts` judges, `enqueue()`, and `drainOutbox()`. The only writer of `message_log`. Named `service.ts` because that is what the three files already inside the ESLint admin-import fence are called, and it joins them — taking the fence from three files to four, the only fence change this phase asks for. |
| `app/api/cron/route.ts` | **New.** Shared-secret auth, then reconcile → sweep → drain, so the sweep reads what reconcile just fixed. |
| `vercel.json` | **New.** The cron schedule. |
| `.env.example` | **Modified.** `CRON_SECRET` and `NOTIFICATIONS_LAUNCH_AT`. `WHATSAPP_API_KEY` and `WHATSAPP_PHONE_NUMBER_ID` already exist and are all the Cloud API needs to send. |

## Testing

- **The adapter, against captured fixtures** with `fetch` mocked: the exact
  Meta payload shape, positional components in template order, and that a
  non-2xx response becomes a `failed` `SendResult` rather than a throw.
- **The sweep as pure units** — every row of the derivation table above,
  including the ones that must send *nothing*: an attendee's own
  cancellation, an expired hold, a `waitlisted` row, and a booking on an
  event that has already started.
- **The cutoff, explicitly.** Seed a confirmed booking on a past event and
  assert the sweep enqueues nothing. This is the assertion that stops the
  first production run messaging everyone about last month.
- **Idempotency under concurrency** — two simultaneous drains produce one
  send, which is what the `UNIQUE dedupe_key` exists for; the 50-buyer
  reservation test is the shape to copy.
- **Retry and death** — a failing provider increments `attempts`, and the
  row stops being picked up at `MAX_ATTEMPTS`.
- **The cron route** — a wrong or absent secret is refused, and refused
  before any work is done.
- **The OTP path is unchanged** — its existing tests must stay green
  untouched, which is the evidence that this phase did not disturb login.

Every test runs against the log provider or a fake. No test requires a WABA.

## Known limitations, deliberate

- **Nothing is sent until the next tick**, so a seat offer can be up to one
  cron interval old. Accepted: it replaces "until they happen to open the
  page", and the 24-hour hold makes an hour immaterial. Rejected: a
  non-blocking nudge at the moment of the state change, which buys seconds
  at the cost of a second delivery path that can disagree with the queue.
- **A booking whose event starts before the next tick is never messaged at
  all.** This is the sharpest limit in the phase and it is not lateness. The
  sweep excludes any booking whose event `hasStarted`, and the reader only
  selects rows with `events.starts_at > now`, so a booking has to be seen by
  a tick falling between the booking and the event start. If its whole life
  fits between two ticks, both gates exclude it from then on and no later
  tick recovers it: no confirmation, no reminder, no cancellation notice.
  On the daily schedule this phase was first written against, a 10:00
  booking for a 19:00 event the same evening got nothing — which bites at
  volume 1, and is why the project moved to Vercel Pro and an hourly cron.
  **Hourly shrinks the hole to an hour; it does not close it.** What this
  system guarantees is "every booking with at least an hour of daylight
  before its event". Closing it properly means a shorter interval, or a
  sweep that stops excluding started events and decides per template — the
  cancellation of an event already under way is still worth sending.

- **The reminder's precision is the cron interval.** The window is "starts
  within the next 24 hours", so an hourly cron gives everyone 23–24 hours of
  notice. `dedupe_key` guarantees exactly-once, so within that window the
  failure mode is lateness rather than spam — but note that exactly-once is
  a statement about duplication only, and the gates above mean the interval
  still decides *whether* for the bookings that fall through it. No template
  change is needed either way: `event_reminder` reads "reminder: {{2}} is on
  {{3}}", carrying the event's own date rather than claiming "tomorrow", so
  it stays true whether it arrives a day or an hour ahead. Widening the
  window is a one-constant change, not another approval round.

- **Throughput is `DRAIN_LIMIT` × ticks, and the counts are the instrument.**
  The drain moves at most 100 messages per tick, so hourly is ~2,400 a day
  (against ~100 on a daily schedule). The cron response already returns the
  counts, so the saturation signals need no new plumbing:
  `drain.attempted === 100` means the drain saturated and a backlog is
  building, and `sweep.scanned === 500` means `SWEEP_LIMIT` truncated the
  read. The second is worse than it looks: the read is oldest-first, so the
  dropped tail is the *newest* bookings, which then age past the start-time
  gates above and are lost rather than deferred. Task 5 notes the fix is a
  watermark rather than a bigger constant.

- **The drain has no staleness gate.** A row enqueued while its event was
  still upcoming is sent whenever the drain reaches it, even if the event
  has since started — at most an hour late on the hourly schedule. Left
  alone because the alternative is re-deciding at send time, which is
  exactly what Task 5 froze the variables to prevent.
- **No delivery receipts.** `message_log.status` records what we asked Meta
  to do, not what the recipient saw. Reading Meta's status webhooks means a
  second authenticated webhook surface for information nothing currently
  acts on.
- **No per-user preferences and no quiet hours.** Every message here is
  transactional and consequential, and there are a handful per person.
- **`cost_paise` stays null.** The column exists and Meta's response can
  populate it, but nothing in the pilot reads it; Phase 6's ledger is where
  a cost per message would earn its place.
- **A host untoggling `has_waitlist` mid-flight can produce the wrong
  sentence** for a live offer, exactly as it can on the booking page. Same
  root cause, same fix, both recorded in 5b's "Carried into Phase 6".
