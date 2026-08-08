-- Core schema for the event hosting platform.
--
-- Conventions used throughout:
--   * All money is BIGINT paise. Never floats, never rupees.
--   * All rates are basis points (bps): 1000 bps = 10%.
--   * Timestamps are timestamptz. The app is IST-only today but storing a zone
--     costs nothing and saves a migration later.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type host_kyc_status as enum ('pending', 'submitted', 'verified', 'rejected');
create type event_status    as enum ('draft', 'published', 'cancelled', 'completed');
create type booking_status  as enum (
  'pending_approval',  -- host must approve before the attendee may pay
  'awaiting_payment',  -- inventory is held; hold_expires_at is set
  'confirmed',         -- paid, or a cash reservation the host accepted
  'cancelled',
  'expired',           -- hold lapsed before payment
  'refunded'
);
create type payment_mode    as enum ('online', 'cash');
create type payment_status  as enum ('created', 'authorized', 'captured', 'failed', 'refunded');
create type refund_status   as enum ('pending', 'processed', 'failed');
create type payout_status   as enum ('pending', 'paid', 'on_hold');

-- ---------------------------------------------------------------------------
-- profiles — one row per authenticated user
-- ---------------------------------------------------------------------------

create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  phone       text not null unique,          -- E.164, e.g. +919876543210
  full_name   text,
  avatar_url  text,
  city        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- Auto-create a profile whenever Supabase Auth creates a user, so the app
-- never has to deal with a signed-in user that has no profile row.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone)
  values (new.id, coalesce(new.phone, new.email, new.id::text))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- hosts — a profile that publishes events
-- ---------------------------------------------------------------------------

create table hosts (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null unique references profiles (id) on delete cascade,
  display_name      text not null,
  bio               text,
  avatar_url        text,
  -- Payout destination. During the pilot we settle manually, so this is
  -- reference data for a human, not something we transact against.
  upi_id            text,
  bank_account_ref  text,
  kyc_status        host_kyc_status not null default 'pending',
  -- Platform's cut of the ticket face value, deducted from the host payout.
  commission_bps    integer not null default 1000
                      check (commission_bps between 0 and 10000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger hosts_set_updated_at
  before update on hosts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

create table events (
  id                         uuid primary key default gen_random_uuid(),
  host_id                    uuid not null references hosts (id) on delete cascade,
  slug                       text not null unique,
  title                      text not null check (length(title) between 3 and 140),
  description                text,
  cover_image_url            text,
  category                   text,
  city                       text not null,
  venue_name                 text,
  venue_address              text,
  venue_lat                  numeric(9, 6),
  venue_lng                  numeric(9, 6),
  -- Luma-style: withhold the exact address until the host approves the guest.
  hide_venue_until_approved  boolean not null default false,
  starts_at                  timestamptz not null,
  ends_at                    timestamptz,
  status                     event_status not null default 'draft',
  -- The two per-event toggles the product is built around.
  requires_approval          boolean not null default false,
  allows_cash                boolean not null default false,
  published_at               timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint events_end_after_start check (ends_at is null or ends_at > starts_at)
);

create index events_discovery_idx
  on events (city, starts_at)
  where status = 'published';

create index events_host_idx on events (host_id, starts_at desc);

create trigger events_set_updated_at
  before update on events
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- ticket_types — the ONLY source of inventory truth
-- ---------------------------------------------------------------------------
-- There is deliberately no events.capacity column. Two counters that can
-- disagree is a bug generator; a host who wants "20 seats" creates one ticket
-- type with quantity 20.

create table ticket_types (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events (id) on delete cascade,
  name            text not null,
  description     text,
  price_paise     bigint not null check (price_paise >= 0),
  quantity        integer not null check (quantity > 0),
  -- Includes unexpired holds, not just paid seats. Mutated only by
  -- reserve_tickets() / release_tickets() so it cannot drift.
  reserved_count  integer not null default 0 check (reserved_count >= 0),
  sales_start     timestamptz,
  sales_end       timestamptz,
  max_per_order   integer not null default 10 check (max_per_order > 0),
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- The real oversell backstop. Even if application logic is wrong, or someone
  -- writes a manual UPDATE, Postgres refuses to sell seat n+1.
  constraint ticket_types_no_oversell check (reserved_count <= quantity)
);

create index ticket_types_event_idx on ticket_types (event_id, sort_order);

create trigger ticket_types_set_updated_at
  before update on ticket_types
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------

create table bookings (
  id                     uuid primary key default gen_random_uuid(),
  -- Short human-quotable code shown to the attendee and used at the door.
  reference              text not null unique,
  event_id               uuid not null references events (id) on delete restrict,
  ticket_type_id         uuid not null references ticket_types (id) on delete restrict,
  attendee_id            uuid not null references profiles (id) on delete restrict,
  quantity               integer not null check (quantity > 0),
  status                 booking_status not null,
  payment_mode           payment_mode not null default 'online',

  -- Money, all snapshotted at booking time. Never recompute from current
  -- fee_rules — the attendee agreed to these numbers, not today's.
  subtotal_paise         bigint not null check (subtotal_paise >= 0),
  convenience_fee_paise  bigint not null default 0 check (convenience_fee_paise >= 0),
  total_paise            bigint not null check (total_paise >= 0),
  -- Platform's cut of subtotal, owed by the host. Zero on cash bookings.
  commission_paise       bigint not null default 0 check (commission_paise >= 0),

  hold_expires_at        timestamptz,
  attendee_note          text,
  approved_at            timestamptz,
  confirmed_at           timestamptz,
  cancelled_at           timestamptz,
  cancellation_reason    text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint bookings_total_is_consistent
    check (total_paise = subtotal_paise + convenience_fee_paise),
  -- A held booking must say when the hold lapses, or the sweeper cannot find it.
  constraint bookings_hold_has_expiry
    check (status <> 'awaiting_payment' or hold_expires_at is not null)
);

create index bookings_event_idx     on bookings (event_id, status);
create index bookings_attendee_idx  on bookings (attendee_id, created_at desc);
-- Drives the hold-expiry sweeper; partial so it stays tiny.
create index bookings_expiring_idx
  on bookings (hold_expires_at)
  where status = 'awaiting_payment';

create trigger bookings_set_updated_at
  before update on bookings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- tickets — one row per admittable person
-- ---------------------------------------------------------------------------
-- A booking for 3 seats produces 3 tickets, so a group can arrive separately.
-- The QR signature is NOT stored: it is derived from `code` plus the per-event
-- key on demand, so the two can never drift apart.

create table tickets (
  id                  uuid primary key default gen_random_uuid(),
  booking_id          uuid not null references bookings (id) on delete cascade,
  code                text not null unique,   -- 128 bits of randomness, base32
  attendee_name       text,
  checked_in_at       timestamptz,
  checked_in_by       uuid references profiles (id),
  -- True when the scan happened offline and synced later, so a host can tell
  -- a queued check-in from a live one when reconciling the door.
  checked_in_offline  boolean not null default false,
  created_at          timestamptz not null default now()
);

create index tickets_booking_idx on tickets (booking_id);

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------

create table payments (
  id                   uuid primary key default gen_random_uuid(),
  booking_id           uuid not null references bookings (id) on delete restrict,
  provider             text not null default 'razorpay',
  provider_order_id    text not null,
  -- Unique, and this is load-bearing: it is what makes webhook replay a no-op.
  provider_payment_id  text unique,
  amount_paise         bigint not null check (amount_paise >= 0),
  status               payment_status not null default 'created',
  method               text,                  -- upi / card / netbanking / wallet
  error_code           text,
  error_description    text,
  raw_payload          jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint payments_provider_order_unique unique (provider, provider_order_id)
);

create index payments_booking_idx on payments (booking_id);

create trigger payments_set_updated_at
  before update on payments
  for each row execute function set_updated_at();

-- Raw webhook receipts, deduped by the provider's own event id. Written before
-- any business logic runs, so a redelivery is detected even if processing
-- crashed halfway through last time.
create table provider_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'razorpay',
  provider_event_id text not null,
  event_type        text,
  payload           jsonb not null,
  processed_at      timestamptz,
  error             text,
  received_at       timestamptz not null default now(),

  constraint provider_webhook_events_unique unique (provider, provider_event_id)
);

-- ---------------------------------------------------------------------------
-- refunds
-- ---------------------------------------------------------------------------

create table refunds (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid not null references payments (id) on delete restrict,
  provider_refund_id  text unique,
  amount_paise        bigint not null check (amount_paise > 0),
  status              refund_status not null default 'pending',
  reason              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger refunds_set_updated_at
  before update on refunds
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- payouts — the host settlement ledger
-- ---------------------------------------------------------------------------
-- Manual settlement during the pilot, but shaped as a ledger so that moving to
-- an automated split later is a new writer, not a schema rewrite.

create table payouts (
  id                uuid primary key default gen_random_uuid(),
  host_id           uuid not null references hosts (id) on delete restrict,
  event_id          uuid not null references events (id) on delete restrict,
  gross_paise       bigint not null check (gross_paise >= 0),
  commission_paise  bigint not null check (commission_paise >= 0),
  net_paise         bigint not null check (net_paise >= 0),
  status            payout_status not null default 'pending',
  -- Bank/UPI reference for the transfer, pasted in by a human during the pilot.
  utr_reference     text,
  notes             text,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint payouts_net_is_consistent
    check (net_paise = gross_paise - commission_paise),
  -- One settlement per event. Re-running the calculation updates, not duplicates.
  constraint payouts_one_per_event unique (event_id)
);

create trigger payouts_set_updated_at
  before update on payouts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- message_log — every WhatsApp send
-- ---------------------------------------------------------------------------

create table message_log (
  id                   uuid primary key default gen_random_uuid(),
  recipient_phone      text not null,
  template             text not null,
  -- Caller-supplied natural key, e.g. 'booking:<id>:ticket'. Unique, so a
  -- retried job cannot message the same person twice.
  dedupe_key           text not null unique,
  booking_id           uuid references bookings (id) on delete set null,
  provider             text,
  provider_message_id  text,
  status               text not null default 'queued',
  error                text,
  cost_paise           bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index message_log_booking_idx on message_log (booking_id);

create trigger message_log_set_updated_at
  before update on message_log
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- fee_rules — pricing as data, not constants
-- ---------------------------------------------------------------------------
-- The fee model will be tuned repeatedly during the pilot. Rows, not code.
-- Resolution order: host-specific rule, then the global rule, most recent
-- effective_from first.

create table fee_rules (
  id                          uuid primary key default gen_random_uuid(),
  -- Null host_id = the global default.
  host_id                     uuid references hosts (id) on delete cascade,
  convenience_fee_bps         integer not null default 500
                                check (convenience_fee_bps between 0 and 10000),
  convenience_fee_min_paise   bigint not null default 0
                                check (convenience_fee_min_paise >= 0),
  convenience_fee_max_paise   bigint check (convenience_fee_max_paise >= 0),
  commission_bps              integer not null default 1000
                                check (commission_bps between 0 and 10000),
  effective_from              timestamptz not null default now(),
  created_at                  timestamptz not null default now()
);

create index fee_rules_lookup_idx on fee_rules (host_id, effective_from desc);

-- Pilot defaults: 5% convenience fee with a Rs 10 floor (which is what actually
-- covers Razorpay's 2% + GST on a cheap ticket), 10% host commission.
insert into fee_rules (host_id, convenience_fee_bps, convenience_fee_min_paise, commission_bps)
values (null, 500, 1000, 1000);
