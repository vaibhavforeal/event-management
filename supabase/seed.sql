-- Local development seed: the two login users and the walk fixtures, so a
-- `db reset` stops being destructive. Applied automatically after migrations
-- (config.toml [db.seed]); never runs anywhere but the local stack.
--
-- What is deliberately NOT here:
--   * fee_rules — the core_schema migration seeds the one platform row; a
--     second insert here would double it.
--   * profiles — handle_new_user() creates them (id + phone) when the
--     auth.users rows below land.
--   * a third user (…9003) — GoTrue creates phone users on first OTP login;
--     only these two carry state (admin registration, hosted events) that a
--     login cannot recreate.
--
-- Logins (config.toml [auth.sms.test_otp], OTP 123456):
--   919999900001 → platform admin        919999900002 → the walk host
--
-- Event dates are relative to now() so the fixtures stay what their slugs
-- say: walk-ended-supper always just ended (settlement walks), and
-- walk-future-supper is always days away (door/scanner walks).

-- ── auth ────────────────────────────────────────────────────────────────────
-- Token columns are '' rather than null: GoTrue string-scans them and chokes
-- on nulls. phone_confirmed_at set, so the phone is a sign-in from day one.
-- The bcrypt values are throwaway local hashes carried from the dev stack.

insert into auth.users
  (instance_id, id, aud, role, encrypted_password, confirmation_token,
   recovery_token, email_change_token_new, email_change,
   email_change_token_current, email_change_confirm_status,
   reauthentication_token, phone_change, phone_change_token,
   raw_app_meta_data, raw_user_meta_data,
   phone, phone_confirmed_at, is_sso_user, is_anonymous,
   created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f0280100-b3f9-4b08-9d3e-e8502d3330bb',
   'authenticated', 'authenticated',
   '$2a$10$6Ciqc8oAw6HNwhbRFbEyTuDH.wNht3F8rv20Zdsdndi.UvDNYEQGK',
   '', '', '', '', '', 0, '', '', '',
   '{"provider": "phone", "providers": ["phone"]}',
   '{"sub": "f0280100-b3f9-4b08-9d3e-e8502d3330bb", "email_verified": false, "phone_verified": false}',
   '919999900001', now(), false, false, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '22d78d5f-c614-4882-923b-86cd9886aca8',
   'authenticated', 'authenticated',
   '$2a$10$/tsOudzPI4PUPeWF3Rju7uVZPxO7D8SPGNy2svQ/V/1NCGwTdPXGa',
   '', '', '', '', '', 0, '', '', '',
   '{"provider": "phone", "providers": ["phone"]}',
   '{"sub": "22d78d5f-c614-4882-923b-86cd9886aca8", "email_verified": false, "phone_verified": false}',
   '919999900002', now(), false, false, now(), now());

insert into auth.identities
  (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values
  ('5ce46642-8e92-41d1-8e2b-37fb39269b3e', 'f0280100-b3f9-4b08-9d3e-e8502d3330bb',
   'f0280100-b3f9-4b08-9d3e-e8502d3330bb',
   '{"sub": "f0280100-b3f9-4b08-9d3e-e8502d3330bb", "email_verified": false, "phone_verified": false}',
   'phone', now(), now(), now()),
  ('cbda8f74-f0ef-48f3-8e34-eb40baf1175a', '22d78d5f-c614-4882-923b-86cd9886aca8',
   '22d78d5f-c614-4882-923b-86cd9886aca8',
   '{"sub": "22d78d5f-c614-4882-923b-86cd9886aca8", "email_verified": false, "phone_verified": false}',
   'phone', now(), now(), now());

-- ── the admin and the host ─────────────────────────────────────────────────

insert into public.platform_admins (profile_id, note, created_at)
values ('f0280100-b3f9-4b08-9d3e-e8502d3330bb', 'local dev admin (…9001)', now());

insert into public.hosts
  (id, profile_id, display_name, kyc_status, commission_bps, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111101', '22d78d5f-c614-4882-923b-86cd9886aca8',
   'Walk Host', 'pending', 1000, now(), now());

-- ── the walk events ─────────────────────────────────────────────────────────

insert into public.events
  (id, host_id, slug, title, city, hide_venue_until_approved, starts_at, ends_at,
   status, requires_approval, allows_cash, published_at, refund_cutoff_hours,
   has_waitlist, created_at, updated_at)
values
  ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111101',
   'walk-ended-supper', 'Walk Ended Supper Club', 'Indore', false,
   now() - interval '2 days', now() - interval '1 day',
   'published', false, false, now() - interval '3 days', 24, false, now(), now()),
  ('22222222-2222-4222-8222-222222222202', '11111111-1111-4111-8111-111111111101',
   'walk-future-supper', 'Walk Future Supper Club', 'Indore', false,
   now() + interval '4 days', now() + interval '5 days',
   'published', false, false, now(), 24, false, now(), now());

-- The future event's ticket is FREE so a door walk can book one on a phone
-- and get straight to the QR — no payment leg on the way to the scanner.
insert into public.ticket_types
  (id, event_id, name, price_paise, quantity, reserved_count, max_per_order,
   sort_order, created_at, updated_at)
values
  ('33333333-3333-4333-8333-333333333301', '22222222-2222-4222-8222-222222222201',
   'General', 50000, 10, 0, 10, 0, now(), now()),
  ('33333333-3333-4333-8333-333333333302', '22222222-2222-4222-8222-222222222202',
   'General', 0, 10, 0, 10, 0, now(), now());

-- ── the ended event's money story: one kept booking, one refunded, one payout ─
-- Settled: gross 1200.00 = 500.00 kept + 700.00 refunded-but-captured;
-- UTRWALK0001 is the reference the settlement walks look for.

insert into public.bookings
  (id, reference, event_id, ticket_type_id, attendee_id, quantity, status,
   payment_mode, subtotal_paise, convenience_fee_paise, total_paise,
   commission_paise, created_at, updated_at)
values
  ('44444444-4444-4444-8444-444444444401', 'WALKAA01',
   '22222222-2222-4222-8222-222222222201', '33333333-3333-4333-8333-333333333301',
   'f0280100-b3f9-4b08-9d3e-e8502d3330bb', 1, 'confirmed', 'online',
   50000, 0, 50000, 0, now() - interval '3 days', now() - interval '3 days'),
  ('44444444-4444-4444-8444-444444444402', 'WALKAA02',
   '22222222-2222-4222-8222-222222222201', '33333333-3333-4333-8333-333333333301',
   '22d78d5f-c614-4882-923b-86cd9886aca8', 1, 'refunded', 'online',
   70000, 0, 70000, 0, now() - interval '3 days', now() - interval '2 days');

insert into public.payments
  (id, booking_id, provider, provider_order_id, provider_payment_id,
   amount_paise, status, created_at, updated_at)
values
  ('55555555-5555-4555-8555-555555555501', '44444444-4444-4444-8444-444444444401',
   'razorpay', 'order_WALKAA01', 'pay_WALKAA01', 50000, 'captured',
   now() - interval '3 days', now() - interval '3 days'),
  ('55555555-5555-4555-8555-555555555502', '44444444-4444-4444-8444-444444444402',
   'razorpay', 'order_WALKAA02', 'pay_WALKAA02', 70000, 'captured',
   now() - interval '3 days', now() - interval '3 days');

insert into public.payouts
  (id, host_id, event_id, gross_paise, commission_paise, net_paise, status,
   utr_reference, paid_at, forfeited_paise, created_at, updated_at)
values
  ('99ec9d86-4a97-4913-9456-e8fce552610c', '11111111-1111-4111-8111-111111111101',
   '22222222-2222-4222-8222-222222222201', 120000, 0, 120000, 'paid',
   'UTRWALK0001', now() - interval '12 hours', 0, now(), now());
