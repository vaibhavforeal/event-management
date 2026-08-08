# Event Hoster

A host-first platform for curated offline experiences in tier-2/3 Indian cities —
supper clubs, board-game nights, workshops, mixers, pop-ups.

A host publishes an event in under three minutes, gets a link they can forward on
WhatsApp, and money, attendee list and door check-in are handled.

Design and rationale: [`docs/specs/2026-08-08-event-platform-v1-design.md`](docs/specs/2026-08-08-event-platform-v1-design.md).

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind 4 · Supabase (Postgres,
Auth, Storage, RLS) · Razorpay · WhatsApp Business Platform.

## Prerequisites

- Node.js 20.9+ (developed on 24)
- Docker Desktop, for the local Supabase stack

## Setup

```bash
npm install
npm run db:start           # first run pulls ~6GB of images and takes a while
cp .env.example .env.local # then fill in from the values db:start prints
npm run dev                # http://localhost:3100
```

Two env files, on purpose:

- **`.env`** — secrets shared by the Supabase CLI and Next.js (`SEND_SMS_HOOK_SECRET`,
  `TICKET_SIGNING_SECRET`). `config.toml` reads these via `env()` substitution.
- **`.env.local`** — Supabase URL and keys from `npm run db:start`, plus app config.

Both are gitignored. `.env.example` is the record of what is needed.

The dev server is pinned to **port 3100**. This is not cosmetic: the Supabase Auth
container calls back to a fixed URL for OTP delivery, and Next silently falls back
to another port if 3100 is busy — which breaks login in a way that looks like a
WhatsApp problem.

Because killing the shell that ran `npm run dev` often leaves `next dev` alive and
still holding the port, a `predev` hook (`scripts/free-port.mjs`) clears any
orphaned listener on 3100 before starting. It touches nothing on any other port.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server on :3100 |
| `npm test` | Full suite (needs `db:start`) |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:start` / `db:stop` | Local Supabase stack |
| `npm run db:reset` | Drop, recreate, re-apply migrations |
| `npm run db:types` | Regenerate `lib/supabase/types.ts` from the schema |

Run `db:types` after every schema change; the generated file is committed.

Supabase Studio: http://localhost:54323

## Layout

```
app/                 routes; api/hooks/send-sms is the Supabase Auth OTP callback
lib/
  auth/              phone-OTP login
  inventory/         reservation tests (logic lives in Postgres functions)
  money.ts           integer-paise helpers
  notifications/     NotificationProvider interface, WhatsApp template registry
  pricing/           fee engine (pure)
  supabase/          browser / server / service-role clients, RLS tests
  tickets/           QR signing and verification
supabase/migrations/ schema, reservation functions, RLS policies
tests/helpers/       integration-test fixtures
```

## Things that will bite you

**Money is always integer paise.** Never floats, never rupees. `lib/money.ts`
enforces it.

**`ticket_types.reserved_count` is mutated only by the Postgres functions.** A
`CHECK (reserved_count <= quantity)` constraint is the real oversell backstop, and
`reserve_tickets()` takes a row lock so concurrent buyers serialise. There is a test
that fires 50 simultaneous bookings at a 10-seat event; keep it passing.

**The payment webhook is the source of truth, not the browser redirect.** The
attendee's connection can die right after they pay.

**Tables are not auto-exposed.** Supabase no longer grants Data API access to new
tables by default, so `20260808000003_rls_policies.sql` issues every grant
explicitly. Add grants there when you add a table, or it will be invisible even to
the service role.

**Register the WhatsApp Business Account with India as Sold-To country and INR
billing.** Authentication templates are ~₹0.115 on an Indian WABA and ~₹2.30 on a
foreign one — 20×. **This cannot be changed after creation.**

**Submit WhatsApp templates early.** Meta approval takes hours to days. The list to
submit is `lib/notifications/templates.ts`.

## Local auth

`WHATSAPP_PROVIDER=log` prints OTPs to the dev-server console instead of sending
them, so the app runs fully before the WhatsApp account exists.

Fixed test numbers (`supabase/config.toml`) always accept `123456` and bypass the
hook entirely:

```
+919999900001   +919999900002   +919999900003
```

Any other number goes through the real hook and prints the code to the console.
