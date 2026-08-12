# Event Hosting Platform — Tier-2/3 India — v1 Design & Build Plan

## Context

Greenfield. The working directory holds only `SItes for reference.txt` pointing at two models:

- **[Offlyn](https://offlyn.life/about)** — Indian, host-first ecosystem for *curated offline experiences* (supper clubs, board games, workshops, mixers, pop-ups). Its founding insight: hosting today is fragmented across DMs, spreadsheets and manual payments, and hosts burn out. Make hosting effortless and the city gets more alive.
- **[Luma](https://help.luma.com/)** — the mature feature set: calendars, ticket types, unlock codes, waitlists, approval flows, QR check-in, blasts, Stripe payouts, memberships, referrals.

We are building Offlyn's thesis with Luma's mechanics, adapted for a **tier-2/3 Indian city pilot**.

**The problem:** a host running a ₹500 supper club today collects RSVPs over WhatsApp, tracks them in a notebook, chases UPI payments one by one, and has no idea who actually shows up. There is no product between "free Google Form" and "BookMyShow", and neither fits a 20-person board-game night.

**Intended outcome:** a host publishes an event in under three minutes, gets a link they can forward on WhatsApp, and money + attendee list + door check-in are handled. The pilot succeeds if ~10–20 hosts run repeat events without going back to spreadsheets.

### Decisions already locked

| Decision | Choice |
|---|---|
| Stage | Real venture, closed pilot in one tier-2/3 Indian city |
| Team | Solo dev + Claude Code |
| Surface | **PWA first**, Capacitor/TWA wrapper for Play Store in month 2–3 |
| Stack | Next.js + Supabase + Razorpay |
| Notifications | WhatsApp via a BSP |
| Curation | **Hybrid** — per-event `requires_approval` toggle |
| Cash | **Per-event** `allows_cash` toggle |
| Payouts | Manual host settlement during pilot |
| Legal structure | **Merchant of record** |
| Fees | Attendee pays convenience fee; host pays commission |

### Research findings that shaped this design

Verified 2026-08-07 against Meta, Razorpay, RBI and GST Council sources.

1. **Razorpay charges 2% + 18% GST on *all* domestic instruments, including UPI.** UPI is zero-MDR by government mandate, but Razorpay levies a platform fee regardless. On a ₹500 ticket that is ₹11.80. A percentage-only take rate does not survive tier-2/3 price points — hence the attendee convenience fee.
2. **Being an "e-commerce operator" is expensive.** CGST Sec 24(x)/52 and IT Sec 194-O would force mandatory GST from rupee one, 1% TCS, monthly GSTR-8, per-state TCS registration, and **GST registration for every host**. Merchant-of-record avoids all of it and keeps host onboarding to a phone number.
3. **WhatsApp is effectively free**: India authentication and utility templates are **₹0.115** each (utility free inside a 24h service window), service messages free. A full booking (OTP + ticket + reminder) costs **~₹0.35**.
4. **⚠️ Register the WhatsApp Business Account with India as Sold-To country and INR billing at creation.** The authentication-*international* rate is **₹2.30** — 20× — and applies to a WABA registered outside India. **This cannot be converted later.**
5. WhatsApp OTP (₹0.115) undercuts DLT-registered SMS (₹0.12–0.25) *and* avoids TRAI DLT registration entirely. WhatsApp is therefore the login channel too — one integration, no SMS vendor.
6. Razorpay onboards a **proprietorship**: PAN + Aadhaar + Udyam/Shop & Establishment + cancelled cheque (name must match PAN exactly) + GST certificate or non-enrolment declaration. No Pvt Ltd needed to start.

> **Not legal advice.** The merchant-of-record structure and fee model need a CA's sign-off before taking real money. It is a business-structure decision, not a code decision — but it determines what we build, so it is fixed here.

---

## Scope

**In scope for v1** — the core loop and nothing else:

> host creates event → shareable link → attendee books + pays → QR ticket on WhatsApp → host scans at door → you settle the host

**Explicitly cut** (add once hosts ask): calendars as an organising primitive, memberships, newsletters/blasts, referrals, coupons/unlock codes, recurring & multi-session events, Zoom/Meet, insights dashboards, sponsorships, recommendation algorithms. Discovery in v1 is **one city feed page**, not a ranking system.

---

## Architecture

Next.js 15 App Router + TypeScript, Tailwind + shadcn/ui, deployed to Vercel. Supabase for Postgres + Auth + Storage, with **row-level security on every table**. ~~Scheduled work via Supabase `pg_cron`.~~ **Superseded in Phase 4: scheduled work is Vercel Cron**, one hourly `GET /api/cron` that runs the notification sweep, the outbox drain and the reconciliation sweep. Sending needs an outbound HTTP call, which `pg_cron` can only make by adding `pg_net` and calling back into the app; one scheduler, readable in TypeScript, was worth more than keeping the work in the database.

Ten modules, each independently testable, with the risky ones behind interfaces:

| Module | Responsibility | Notes |
|---|---|---|
| `lib/auth/` | WhatsApp OTP login, session | Supabase Auth **Send SMS Hook** routed to the WhatsApp provider — *verify this hook exists and fires as expected early in Phase 0; it is the one unproven integration point* |
| `lib/events/` | Event CRUD, publish, slugs | |
| `lib/inventory/` | Capacity, holds, atomic reservation | **Pure logic + one Postgres function.** Highest-risk module |
| `lib/pricing/` | Fee computation | **Pure function**, fees are config rows not constants |
| `lib/payments/` | `PaymentProvider` interface + Razorpay adapter | Webhook is source of truth |
| `lib/tickets/` | Issuance, QR signing, verification | HMAC-signed, per-event key |
| `lib/checkin/` | Scanner, offline queue, sync | |
| `lib/notifications/` | `NotificationProvider` interface + BSP adapter | Swap BSP → Meta Cloud API later without touching callers |
| `lib/payouts/` | Settlement ledger | Ledger-shaped so a future Razorpay Route migration is not a rewrite |
| `app/(discovery)/` | City feed, public event page | |

Both `PaymentProvider` and `NotificationProvider` exist because those vendors are the most likely to change. Everything else talks to the interface.

### Data model

Core tables (`supabase/migrations/`):

```
profiles          id, phone, name, avatar, city
hosts             profile_id, display_name, bio, upi_id, bank_ref, kyc_status,
                  commission_rate_bps
events            host_id, slug, title, description, cover_image, category,
                  venue_name, venue_address, venue_geo, hide_venue_until_approved,
                  starts_at, ends_at, capacity, city, status,
                  requires_approval, allows_cash
ticket_types      event_id, name, price_paise, quantity, sold_count,
                  sales_start, sales_end, max_per_order
bookings          event_id, ticket_type_id, attendee_id, quantity, status,
                  subtotal_paise, convenience_fee_paise, total_paise,
                  payment_mode, hold_expires_at
tickets           booking_id, code, qr_signature, attendee_name,
                  checked_in_at, checked_in_by
payments          booking_id, razorpay_order_id, razorpay_payment_id,
                  amount_paise, status, method, raw_payload jsonb
refunds           payment_id, amount_paise, status, reason
payouts           host_id, event_id, gross_paise, commission_paise,
                  net_paise, status, utr_reference, paid_at
message_log       recipient, template, provider_message_id, status, dedupe_key
fee_rules         scope, convenience_fee_bps, convenience_fee_min_paise,
                  commission_bps, effective_from
```

Non-negotiables:
- **All money in integer paise.** Never floats, never rupees.
- `bookings.status`: `pending_approval → awaiting_payment → confirmed → cancelled | refunded`. Check-in lives on `tickets`, not `bookings` — one booking can be several tickets checked in separately.
- RLS: attendees read their own bookings; hosts read their own events and those events' bookings; webhooks use the service role only.

---

## The four things that will actually break

These get disproportionate design attention because they are where ticketing systems fail.

**1. Overselling.** Two people buy the last seat at the same instant. Solved with a Postgres function holding a row lock on `ticket_types` that checks and increments `sold_count` in one transaction, creating the booking in `awaiting_payment` with a **10-minute hold** (`hold_expires_at`). Expired holds are released inline at every reserve and read seam by `release_expired_holds`, plus the scheduled sweep at `/api/cron` — not `pg_cron`; see Phase 4's design for why one scheduler is enough. Available count is *always* derived from the DB, never from application state.

**2. Payment webhooks.** The attendee's browser can die right after they pay. The client redirect is a UX nicety; **the Razorpay webhook is the only source of truth.** The handler verifies the signature, is idempotent via a unique constraint on `razorpay_payment_id`, and stores the raw payload. A reconciliation cron polls Razorpay for orders stuck in `awaiting_payment` past their hold — because webhooks do get dropped.

**3. Offline check-in.** Venue wifi in a tier-2 city basement is not a thing. Before doors open, the host's PWA caches the event's signed ticket list. Scans verify the HMAC **locally**, queue check-ins in IndexedDB, and sync on reconnect. Double check-ins resolve last-write-wins with both timestamps retained so the host can see it happened.

**4. QR forgery.** Ticket codes are 128-bit random plus an HMAC signature under a **per-event key**. The scanner holds only the current event's key, so a compromised host device cannot forge tickets for anyone else's event.

### Two business risks worth naming

- **Cash bookings leak your take rate.** If a host can accept cash, a host can tell attendees "just pay me directly" and route around you entirely. For the pilot: take **no commission on cash bookings**, count them, and watch the ratio. If cash climbs above ~30% of bookings, the fee model needs rethinking, not the code.
- **Approval + payment ordering.** For `requires_approval` events, the attendee must not be charged until approved. The flow is request → host approves → payment link sent (24h expiry) → confirmed. This is why `pending_approval` precedes `awaiting_payment` rather than using a card authorisation hold, which Indian UPI does not support cleanly.

---

## Build order

Sequenced so the loop is provable before money is involved. **You can run real pilot events from Phase 2.**

| Phase | Deliverable | Proves |
|---|---|---|
| **0** | Next.js + Supabase scaffold, schema, RLS, WhatsApp OTP login | Auth works; the Send-SMS-Hook assumption holds |
| **1** | Host creates + publishes event; public event page at `/e/[slug]` | The shareable link — the thing the whole business rests on |
| **2** | Free bookings, ticket issuance, QR, host scanner | **Full loop, zero payment risk. Pilot starts here.** |
| **3** | Razorpay checkout, holds, webhooks, reconciliation | Money |
| **4** | WhatsApp templates: OTP, ticket, reminder, cancellation | Retention + no-show reduction |
| **5** | Approval flow, cash option, waitlist | Offlyn's curation angle |
| **6** | Payout ledger, host dashboard, admin console | You can pay hosts and see the business |
| **7** | PWA manifest, service worker, offline check-in, TWA wrapper | Play Store presence |

Phase 4 has a dependency you should start on **day one**: Meta template approval takes hours to days, and business verification longer. Create the WABA (India / INR — see finding 4) and submit templates during Phase 0, not Phase 4.

---

## Testing

- **TDD for pure logic** — `lib/pricing/` and `lib/inventory/` are pure functions with exhaustive unit tests. Fee math and capacity math are where silent money bugs live.
- **Concurrency test, mandatory:** fire 50 simultaneous bookings at a 10-seat event and assert exactly 10 succeed. This test must exist before Phase 3 ships.
- **Webhook fixtures** — replay captured Razorpay payloads including duplicates and out-of-order delivery; assert idempotency.
- **RLS tests** — attempt cross-tenant reads as a non-owner host; assert denial. Easy to get wrong, catastrophic to miss.
- **E2E (Playwright)** — browse feed → book → pay (Razorpay test mode) → receive ticket → scan → checked in.
- **Manual** — one real ₹1 transaction end-to-end in Razorpay live mode before onboarding any host.

## Verification

End-to-end, on a local Supabase + `next dev`:

1. `supabase start && supabase db reset` — migrations and RLS policies apply cleanly.
2. `npm test` — unit + integration green, including the 50-concurrent-bookings oversell test.
3. `npx playwright test` — full booking journey passes in Razorpay test mode.
4. Create an event as a host, open the public link in a private window on a phone, book with Razorpay test card `4111 1111 1111 1111`, confirm the ticket renders and a WhatsApp message arrives on a real number.
5. Put the phone in airplane mode, scan the QR from the host scanner, confirm the check-in queues; restore network and confirm it syncs.
6. Trigger the hold-expiry cron manually and confirm an abandoned checkout returns inventory.

---

## Open items (not blocking the build)

- CA sign-off on merchant-of-record structure, GST rate on ticket value, and the convenience-fee treatment.
- BSP selection (AiSensy / Interakt / Gupshup). Start on whichever onboards fastest — `NotificationProvider` makes it reversible. Moving to Meta Cloud API direct later saves the ~₹1,500/mo platform fee.
- Launch city, which affects seed content and language, not architecture.
- Fee defaults to tune in `fee_rules`: start ~5% convenience fee with a minimum around ₹10, and ~8–10% host commission.
