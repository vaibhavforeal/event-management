-- Row-level security.
--
-- Posture: enable RLS on every table, then grant back only what a browser
-- legitimately needs. Anything not listed here is denied to anon and
-- authenticated. The service role bypasses all of this, which is why
-- lib/supabase/admin.ts is restricted to webhooks, cron and Server Actions.
--
-- Writes to bookings, tickets and payments are intentionally NOT grantable to
-- clients: they go through the SECURITY DEFINER functions instead, so inventory
-- and money can never be mutated by a crafted PostgREST call.

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER so that evaluating a policy on `events` does not
-- re-enter the policy on `hosts` and recurse.
-- ---------------------------------------------------------------------------

create or replace function current_host_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from hosts where profile_id = auth.uid();
$$;

create or replace function owns_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from events e
      join hosts h on h.id = e.host_id
     where e.id = p_event_id
       and h.profile_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
alter table profiles                 enable row level security;
alter table hosts                    enable row level security;
alter table events                   enable row level security;
alter table ticket_types             enable row level security;
alter table bookings                 enable row level security;
alter table tickets                  enable row level security;
alter table payments                 enable row level security;
alter table refunds                  enable row level security;
alter table payouts                  enable row level security;
alter table message_log              enable row level security;
alter table fee_rules                enable row level security;
alter table provider_webhook_events  enable row level security;

-- ---------------------------------------------------------------------------
-- profiles — yours and only yours
-- ---------------------------------------------------------------------------

create policy profiles_select_own on profiles
  for select using (id = auth.uid());

create policy profiles_update_own on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- hosts — public profiles; a host edits only their own
-- ---------------------------------------------------------------------------
-- Readable by anyone because the event page shows who is hosting. Payout
-- fields (upi_id, bank_account_ref) are therefore NOT safe to expose here;
-- they are stripped by a column grant below.

create policy hosts_select_public on hosts
  for select using (true);

create policy hosts_insert_self on hosts
  for insert with check (profile_id = auth.uid());

create policy hosts_update_own on hosts
  for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- events — published events are public; hosts see their own drafts
-- ---------------------------------------------------------------------------

create policy events_select_published on events
  for select using (status = 'published');

create policy events_select_own on events
  for select using (host_id = current_host_id());

create policy events_insert_own on events
  for insert with check (host_id = current_host_id());

create policy events_update_own on events
  for update using (host_id = current_host_id())
  with check (host_id = current_host_id());

create policy events_delete_own_drafts on events
  for delete using (host_id = current_host_id() and status = 'draft');

-- ---------------------------------------------------------------------------
-- ticket_types — visible with their event
-- ---------------------------------------------------------------------------

create policy ticket_types_select_public on ticket_types
  for select using (
    exists (select 1 from events e where e.id = event_id and e.status = 'published')
  );

create policy ticket_types_select_own on ticket_types
  for select using (owns_event(event_id));

create policy ticket_types_write_own on ticket_types
  for all using (owns_event(event_id)) with check (owns_event(event_id));

-- ---------------------------------------------------------------------------
-- bookings — read-only to clients; created only via the reservation functions
-- ---------------------------------------------------------------------------

create policy bookings_select_own on bookings
  for select using (attendee_id = auth.uid());

create policy bookings_select_for_host on bookings
  for select using (owns_event(event_id));

-- ---------------------------------------------------------------------------
-- tickets — the attendee's own, and the host's door list
-- ---------------------------------------------------------------------------
-- No client UPDATE: check-in goes through a server function so a guest cannot
-- mark themselves admitted.

create policy tickets_select_own on tickets
  for select using (
    exists (
      select 1 from bookings b
       where b.id = booking_id and b.attendee_id = auth.uid()
    )
  );

create policy tickets_select_for_host on tickets
  for select using (
    exists (
      select 1 from bookings b
       where b.id = booking_id and owns_event(b.event_id)
    )
  );

-- ---------------------------------------------------------------------------
-- payments and refunds — attendee may see their own; hosts may not
-- ---------------------------------------------------------------------------
-- A host has no business seeing payment instrument details. They get aggregate
-- money through payouts instead.

create policy payments_select_own on payments
  for select using (
    exists (
      select 1 from bookings b
       where b.id = booking_id and b.attendee_id = auth.uid()
    )
  );

create policy refunds_select_own on refunds
  for select using (
    exists (
      select 1
        from payments p
        join bookings b on b.id = p.booking_id
       where p.id = payment_id and b.attendee_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- payouts — a host sees their own settlement statements
-- ---------------------------------------------------------------------------

create policy payouts_select_own on payouts
  for select using (host_id = current_host_id());

-- ---------------------------------------------------------------------------
-- message_log, fee_rules, provider_webhook_events
-- ---------------------------------------------------------------------------
-- No policies at all: RLS is on and nothing is granted, so these are invisible
-- to anon and authenticated. Server-side only, by design.

-- ---------------------------------------------------------------------------
-- Table grants
-- ---------------------------------------------------------------------------
-- Policies decide WHICH ROWS a role may touch. Grants decide whether the role
-- may touch the table at all, and both must allow it. Supabase's default
-- privileges do not reach these tables, so every privilege here is explicit —
-- which is what we want for a schema whose entire job is authorisation.
--
-- Read this block as the actual permission model; the policies above only
-- narrow what it allows.

grant usage on schema public to anon, authenticated, service_role;

-- The trusted server path. Bypasses RLS by design; used by webhooks, cron and
-- Server Actions that have already authenticated the user themselves.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Reads. RLS narrows each of these to the caller's own rows (or to published
-- events, for the public listing).
grant select on events, ticket_types to anon, authenticated;
grant select on profiles, bookings, tickets, payments, refunds, payouts to authenticated;

-- hosts is publicly readable because event pages show who is hosting, but
-- upi_id and bank_account_ref are payout secrets sitting on that same row.
-- RLS filters rows, not columns, so the column list is the only thing standing
-- between a curious visitor and every host's bank details.
grant select (
  id, profile_id, display_name, bio, avatar_url, kyc_status, commission_bps, created_at
) on hosts to anon, authenticated;

-- Writes a signed-in user may perform directly. Everything to do with money or
-- inventory is absent on purpose: bookings, tickets, payments and payouts are
-- writable only through the SECURITY DEFINER functions.
grant insert, update on hosts to authenticated;
grant update on profiles to authenticated;
grant insert, update, delete on events to authenticated;
grant insert, update, delete on ticket_types to authenticated;
