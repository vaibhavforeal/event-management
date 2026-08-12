-- Platform admins — the operator identity, and the reads it needs.
--
-- There was no admin concept anywhere in this codebase before Phase 6a. This
-- is it, and it is deliberately the same shape as current_host_id(): a table,
-- a SECURITY DEFINER predicate, and policies that call it. The console then
-- runs on the ordinary session client, so the service-role fence in
-- eslint.config.mjs stays at four files and the database remains the place
-- authorisation is decided.

create table platform_admins (
  profile_id  uuid primary key references profiles (id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now()
);

alter table platform_admins enable row level security;

grant select, insert, delete on platform_admins to service_role;

-- No policies and no grant, exactly as fee_rules and provider_webhook_events
-- have none: RLS is on and nothing is granted, so the table is invisible to
-- anon and authenticated alike — including to admins themselves. Who can
-- settle is not a fact any browser needs. Seeded by hand against the service
-- role:  insert into platform_admins (profile_id) values ('<uuid>');

-- SECURITY DEFINER for the same reason current_host_id() is: a policy on
-- payouts that queried platform_admins directly would re-enter that table's
-- own (absent) policies and read nothing.
create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where profile_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Admin reads
-- ---------------------------------------------------------------------------
-- Added as separate policies rather than folded into the existing ones with an
-- OR. Postgres OR-s permissive policies for the same command, so the effect is
-- identical — but nothing already reviewed is edited, and this file already
-- reads this way (events_select_published beside events_select_own).
--
-- Reads only. Every write still goes through a SECURITY DEFINER function.
--
-- `to authenticated` is load-bearing, not tidiness. A policy with no TO clause
-- applies to PUBLIC, so an anonymous visitor reading the city feed would have
-- to evaluate is_platform_admin() on every row — needing EXECUTE on it, and
-- erroring without. An admin is by definition signed in, so scoping the policy
-- keeps anon on exactly the path it had before this migration.

create policy events_select_admin on events
  for select to authenticated using (is_platform_admin());

create policy bookings_select_admin on bookings
  for select to authenticated using (is_platform_admin());

create policy payments_select_admin on payments
  for select to authenticated using (is_platform_admin());

create policy refunds_select_admin on refunds
  for select to authenticated using (is_platform_admin());

create policy payouts_select_admin on payouts
  for select to authenticated using (is_platform_admin());

-- authenticated needs EXECUTE because policy expressions run with the caller's
-- privileges; the app also calls it directly to decide whether /admin exists.
revoke execute on function is_platform_admin() from public, anon;
grant execute on function is_platform_admin() to authenticated, service_role;

-- No grant is added for hosts.upi_id or hosts.bank_account_ref. RLS filters
-- rows, not columns, so no policy here could reach them anyway, and widening
-- the column grant would hand every host's bank details to every signed-in
-- visitor — hosts is world-readable so event pages can name their host.
-- admin_host_payout_target() in the next migration is the way through.
