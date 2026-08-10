-- Phase 3: the paid checkout path. One new column, one new function, and the
-- event writers learn the refund cutoff.
--
-- refund_cutoff_hours: full refund on attendee self-cancel until this many
-- hours before starts_at; after that the attendee may still cancel -- the host
-- wants the seat freed and the no-show signalled -- but no money moves. 0
-- means "refundable until start". Host-initiated cancels always refund in
-- full; that rule lives in lib/payments/refund-policy.ts, not here -- the
-- column is the event's number, the policy is TypeScript's.

alter table events add column refund_cutoff_hours integer not null default 24
  check (refund_cutoff_hours >= 0);

-- ---------------------------------------------------------------------------
-- The event writers, re-created with the cutoff
-- ---------------------------------------------------------------------------
-- Both gain a trailing `p_refund_cutoff_hours integer default 24`. The default
-- keeps the generated `Args` type optional, so app/host/events/actions.ts
-- still compiles until Task 2 passes it.
--
-- `create or replace` cannot change a signature: it would create an overload
-- beside the old function and PostgREST would refuse the ambiguous name. Drop
-- first. The bodies below are otherwise verbatim from
-- 20260809000001_event_write_transactions.sql -- posture, ownership scoping
-- and the reasoning in the comments all still hold; only the cutoff is new.

drop function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
);
drop function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer
);

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
  p_quantity                  integer,
  p_refund_cutoff_hours       integer default 24
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
    hide_venue_until_approved, refund_cutoff_hours, status
  )
  values (
    p_host_id, p_slug, p_title, p_description, p_city, p_venue_name,
    p_venue_address, p_cover_image_url, p_starts_at, p_ends_at,
    p_requires_approval, p_allows_cash, p_hide_venue_until_approved,
    p_refund_cutoff_hours, 'draft'
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
  p_quantity                  integer,
  p_refund_cutoff_hours       integer default 24
)
returns events
language plpgsql
set search_path = public
as $$
declare
  ev     events%rowtype;
  ticket ticket_types%rowtype;
begin
  -- Ownership is settled once, here, before anything is written. Scoped on
  -- host_id as well as RLS: events_update_own would refuse a stranger anyway,
  -- so this is the same defence in depth the `.eq('host_id', hostId)` in the
  -- TypeScript carried. It is also what refuses a service-role caller, for whom
  -- RLS does not apply and current_host_id() is null.
  --
  -- One check covers both writes because the lock is taken in the same
  -- statement that checks. From the moment this row is read it is held `for
  -- update`, so it cannot change owner between here and the `update events`
  -- at the end of the function -- which is why that statement is scoped on id
  -- alone and does not repeat the host_id.
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
         hide_venue_until_approved = p_hide_venue_until_approved,
         refund_cutoff_hours       = p_refund_cutoff_hours
   where id = p_event_id
  returning * into ev;

  return ev;
end;
$$;

-- The same reachability reasoning as 20260809000001, repeated for the new
-- signatures: EXECUTE lands on PUBLIC at creation, `authenticated` is the role
-- the Server Action calls with, service_role needs the grant back because a
-- revoke from PUBLIC strips it too, and anon is named so the outcome survives
-- hosted default privileges.

revoke execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
) from public, anon;

revoke execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
) from public, anon;

grant execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
) to authenticated, service_role;

grant execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- begin_paid_booking
-- ---------------------------------------------------------------------------
-- Beginning a paid booking, as one transaction that STOPS at the hold.
--
-- The mirror of book_free_tickets' guard block with the price guard inverted:
-- this path exists only for tickets that cost money. It reserves inventory
-- (10-minute hold, awaiting_payment) and returns; confirm_booking runs later,
-- from the webhook processor, when Razorpay says the money moved. That is why
-- search_path is public alone -- this function never confirms, so it never
-- needs pgcrypto's gen_random_bytes from extensions.
--
--   EH030  the ticket type is free; the paid path does not apply
--   EH031  the event requires host approval; that flow is Phase 5
--   EH032  the event has already started
--   EH033  this attendee already has an active booking on this event
--
-- payment_mode 'cash' stays refused by construction: there is no parameter to
-- ask for it, and reserve_tickets' default is 'online'. Fees and commission
-- stay at their 0 defaults -- Phase 3 charges the ticket price exactly.
--
-- Published status, the sales window, max_per_order and availability under
-- the row lock are reserve_tickets' job, and its refusals are already
-- sentences a person can read. They pass through.

create or replace function begin_paid_booking(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  tt      ticket_types%rowtype;
  ev      events%rowtype;
  booking bookings%rowtype;
begin
  select * into tt from ticket_types where id = p_ticket_type_id;

  if not found then
    raise exception 'ticket type % not found', p_ticket_type_id
      using errcode = 'no_data_found';
  end if;

  select * into ev from events where id = tt.event_id;

  if tt.price_paise = 0 then
    raise exception 'this ticket type is free; use the free booking path'
      using errcode = 'EH030';
  end if;

  if ev.requires_approval then
    raise exception 'this event requires host approval before booking'
      using errcode = 'EH031';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH032';
  end if;

  -- The friendly half of the one-booking rule; the partial unique index is
  -- the half that holds under concurrency. Same shape as book_free_tickets.
  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH033';
  end if;

  booking := reserve_tickets(
    p_ticket_type_id => p_ticket_type_id,
    p_attendee_id    => p_attendee_id,
    p_quantity       => p_quantity
  );

  -- reserve_tickets has no name parameter and should not grow one (see
  -- 20260810000003). Written here, inside the same transaction.
  update bookings
     set attendee_name = nullif(btrim(p_attendee_name), '')
   where id = booking.id
  returning * into booking;

  return booking;

exception
  -- The pre-check loses the race sometimes; the index never does. Same
  -- remap, and the same reasoning, as book_free_tickets' handler.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH033';
    end if;
    raise;
end;
$$;

-- EXECUTE is granted to PUBLIC by default; revoking from public also strips
-- service_role, so the grant back is required, not decorative. anon named
-- explicitly for the same hosted-project reason as 20260810000003.
revoke execute on function begin_paid_booking(uuid, uuid, integer, text)
  from public, anon, authenticated;

grant execute on function begin_paid_booking(uuid, uuid, integer, text)
  to service_role;
