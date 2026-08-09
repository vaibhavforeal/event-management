-- Transactional event writes.
--
-- Saving an event means two writes: the events row and its ticket type. Two
-- PostgREST calls are two transactions, so before this file the second could be
-- refused with the first already committed — seats moved and nothing else, or an
-- event with no inventory that can never be published and no screen can repair.
-- These functions exist so that one save is one transaction.
--
-- Why this file inverts the posture of 20260808000002_reservation_functions.sql:
-- that file is SECURITY DEFINER with EXECUTE revoked from anon and
-- authenticated, because it guards inventory and money, which must be
-- unreachable from a crafted PostgREST call. These two guard a write the caller
-- is already entitled to make. Phase 0 granted `authenticated` scoped
-- insert/update on events and ticket_types, narrowed by current_host_id(), and
-- the RLS tests prove that model. SECURITY INVOKER -- the default, and stated
-- here by its absence -- runs the body as the calling role with the caller's
-- auth.uid(), so events_insert_own, events_update_own and ticket_types_write_own
-- evaluate on every statement inside exactly as they do today. Nothing new is
-- authorised. The statements only move into one transaction.
--
-- Custom SQLSTATEs, so the Server Action can turn a refusal into a sentence a
-- host can read rather than a constraint name:
--   EH001  capacity below reserved_count; DETAIL carries the reserved count
--   EH002  the event is not the caller's

-- ---------------------------------------------------------------------------
-- create_event_with_ticket_type
-- ---------------------------------------------------------------------------
-- The slug is generated in TypeScript (lib/events/slug.ts, unit-tested) and
-- passed in. Status is always 'draft': publishing is a separate, validated step.

create or replace function create_event_with_ticket_type(
  p_host_id                   uuid,
  p_slug                      text,
  p_title                     text,
  p_description               text,
  p_city                      text,
  p_venue_name                text,
  p_venue_address             text,
  p_cover_image_url           text,
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz,
  p_requires_approval         boolean,
  p_allows_cash               boolean,
  p_hide_venue_until_approved boolean,
  p_price_paise               bigint,
  p_quantity                  integer
)
returns events
language plpgsql
set search_path = public
as $$
declare
  ev events%rowtype;
begin
  insert into events (
    host_id, slug, title, description, city, venue_name, venue_address,
    cover_image_url, starts_at, ends_at, requires_approval, allows_cash,
    hide_venue_until_approved, status
  )
  values (
    p_host_id, p_slug, p_title, p_description, p_city, p_venue_name,
    p_venue_address, p_cover_image_url, p_starts_at, p_ends_at,
    p_requires_approval, p_allows_cash, p_hide_venue_until_approved, 'draft'
  )
  returning * into ev;

  -- No compensating delete. If this raises, the insert above is rolled back by
  -- the transaction PostgREST opened for this call.
  insert into ticket_types (event_id, name, price_paise, quantity)
  values (ev.id, 'General', p_price_paise, p_quantity);

  return ev;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_event_with_ticket_type
-- ---------------------------------------------------------------------------
-- Deliberately takes no slug. The link may already be in a WhatsApp group.

create or replace function update_event_with_ticket_type(
  p_event_id                  uuid,
  p_title                     text,
  p_description               text,
  p_city                      text,
  p_venue_name                text,
  p_venue_address             text,
  p_cover_image_url           text,
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz,
  p_requires_approval         boolean,
  p_allows_cash               boolean,
  p_hide_venue_until_approved boolean,
  p_price_paise               bigint,
  p_quantity                  integer
)
returns events
language plpgsql
set search_path = public
as $$
declare
  ev     events%rowtype;
  ticket ticket_types%rowtype;
begin
  -- Ownership settled before anything is written. Scoped on host_id as well as
  -- RLS: events_update_own would refuse a stranger anyway, and this is the
  -- statement that rewrites the row, so it carries its own scope -- the same
  -- defence in depth the `.eq('host_id', hostId)` in the TypeScript carried.
  -- It is also what refuses a service-role caller, for whom RLS does not apply
  -- and current_host_id() is null.
  select * into ev
    from events
   where id = p_event_id
     and host_id = current_host_id()
   for update;

  if ev.id is null then
    raise exception 'event % is not yours to edit', p_event_id
      using errcode = 'EH002';
  end if;

  -- The one the form is editing, not every one the event has. Ordered the way
  -- every read orders embedded ticket types -- see TICKET_TYPE_ORDER in
  -- lib/events/queries.ts -- so this is the row the edit form printed from.
  --
  -- `for update` serialises against a concurrent booking, which is what makes
  -- the check below still true at commit rather than merely true when read.
  select * into ticket
    from ticket_types
   where event_id = p_event_id
   order by sort_order, created_at
   limit 1
   for update;

  -- `ticket.id is not null` rather than `found`. FOUND would in fact be correct
  -- at both use sites here -- IF and RAISE do not touch it, so it still belongs
  -- to the select above. It is avoided because it reads correctly only for
  -- someone who has tracked which statement last set it, and there are two
  -- separate branches below asking the same question. The row variable says
  -- what it means at the point of use.
  if ticket.id is not null and p_quantity < ticket.reserved_count then
    raise exception 'capacity % is below the % seats already reserved',
      p_quantity, ticket.reserved_count
      using errcode = 'EH001', detail = ticket.reserved_count::text;
  end if;

  if ticket.id is not null then
    update ticket_types
       set price_paise = p_price_paise,
           quantity    = p_quantity
     where id = ticket.id;
  else
    -- An event with no ticket type is no longer reachable through this app, but
    -- rows predating this migration can be in that state. Inserting rather than
    -- writing nothing, because the alternative is accepting the host's seats and
    -- price, reporting "Saved." and discarding both.
    insert into ticket_types (event_id, name, price_paise, quantity)
    values (p_event_id, 'General', p_price_paise, p_quantity);
  end if;

  update events
     set title                     = p_title,
         description               = p_description,
         city                      = p_city,
         venue_name                = p_venue_name,
         venue_address             = p_venue_address,
         cover_image_url           = p_cover_image_url,
         starts_at                 = p_starts_at,
         ends_at                   = p_ends_at,
         requires_approval         = p_requires_approval,
         allows_cash               = p_allows_cash,
         hide_venue_until_approved = p_hide_venue_until_approved
   where id = p_event_id
  returning * into ev;

  return ev;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reachability
-- ---------------------------------------------------------------------------
-- EXECUTE on a new function is granted to PUBLIC by default, which would put
-- both of these within reach of anon. Revoke first, then grant to the roles
-- that have any business calling them.
--
-- `authenticated` is the role the app actually calls with: the Server Action
-- uses the RLS-scoped user client, on purpose (see app/host/events/actions.ts).
--
-- service_role is granted back for the same reason 20260808000002 grants
-- everything back explicitly: revoking from PUBLIC removes it for everyone,
-- service_role included -- it is not a member of `authenticated`, so it would
-- otherwise get 42501 instead of reaching the function body. Granting it
-- confers no authority it does not already have: it holds `grant all on all
-- tables in schema public` and bypasses RLS, so it can already write both
-- tables directly. What it gets here is the function's OWN host_id scoping,
-- which refuses it — current_host_id() is null without an auth.uid() — and
-- that refusal is the defence in depth the tests pin.

-- `anon` is named alongside PUBLIC rather than left to be covered by it. A
-- revoke from PUBLIC only removes the PUBLIC grant; a direct grant to anon
-- survives it. Hosted Supabase projects commonly carry
-- `alter default privileges in schema public grant all on functions to anon,
-- authenticated`, which issues exactly such a direct grant at creation time --
-- so revoking from PUBLIC alone is enough here and would not be there. Naming
-- anon makes the outcome independent of which default privileges are in force,
-- and matches 20260808000002_reservation_functions.sql.

revoke execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) from public, anon;

revoke execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) from public, anon;

grant execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) to authenticated, service_role;

grant execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
) to authenticated, service_role;
