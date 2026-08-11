-- Phase 5a: the approval flow and the cash option become reachable.
--
-- Phase 0 wrote request_booking and approve_booking ahead of any caller. This
-- migration recreates them to the conventions later phases established --
-- started-event guards (the WhatsApp link outlives the feed), max_per_order at
-- request time (request_booking never calls reserve_tickets, so nothing else
-- checks it), EH-coded refusals, an attendee name for the door list, and a
-- payment mode chosen at request time -- and adds the cash mirror of
-- book_free_tickets. Decline needs no function: cancel_booking on a
-- pending_approval row already returns no inventory (none was taken).

-- ---------------------------------------------------------------------------
-- request_booking -- recreated
-- ---------------------------------------------------------------------------
-- The signature grows, and `create or replace` cannot change a signature: it
-- would create an overload beside the old function and PostgREST would refuse
-- the ambiguous name. Drop first (the 20260811000002 precedent).
--
-- Still deliberately does NOT consume inventory: a curated supper club will
-- get more requests than seats, and that is the point. Inventory is taken at
-- approval time, which can legitimately fail if the host over-approves.
--
--   EH050  the event does not use approvals; book it directly
--   EH051  the event has already started
--   EH052  cash was requested but the event does not allow it
--   EH053  more seats than max_per_order allows
--   EH054  this attendee already has an active booking on this event
--
-- Unlike book_free_tickets, the name needs no post-insert UPDATE: this
-- function owns its INSERT, so name, note and mode go in directly.

drop function request_booking(uuid, uuid, integer, text);

create function request_booking(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text,
  p_attendee_note  text default null,
  p_payment_mode   payment_mode default 'online'
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  tt          ticket_types%rowtype;
  ev          events%rowtype;
  booking     bookings%rowtype;
  -- v_ prefix is not decoration: an unprefixed `reference` collides with
  -- bookings.reference and Postgres raises 42702 (ambiguous column reference).
  v_reference text;
  attempts    integer := 0;
begin
  if p_quantity < 1 then
    raise exception 'quantity must be at least 1'
      using errcode = 'check_violation';
  end if;

  select * into tt from ticket_types where id = p_ticket_type_id;
  if not found then
    raise exception 'ticket type % not found', p_ticket_type_id
      using errcode = 'no_data_found';
  end if;

  select * into ev from events where id = tt.event_id;

  if ev.status <> 'published' then
    raise exception 'event is not open for booking (status: %)', ev.status
      using errcode = 'check_violation';
  end if;

  if not ev.requires_approval then
    raise exception 'this event does not use approvals; book it directly'
      using errcode = 'EH050';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH051';
  end if;

  if p_payment_mode = 'cash' and not ev.allows_cash then
    raise exception 'this event does not accept cash payment'
      using errcode = 'EH052';
  end if;

  -- reserve_tickets checks this for every other booking kind; requests never
  -- reach it, so the cap must be enforced here or nowhere.
  if p_quantity > tt.max_per_order then
    raise exception 'cannot request more than % per order', tt.max_per_order
      using errcode = 'EH053';
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
      using errcode = 'EH054';
  end if;

  loop
    attempts := attempts + 1;
    v_reference := generate_booking_reference();
    exit when not exists (select 1 from bookings b where b.reference = v_reference);
    if attempts > 10 then
      raise exception 'could not allocate a unique booking reference';
    end if;
  end loop;

  insert into bookings (
    reference, event_id, ticket_type_id, attendee_id, quantity,
    status, payment_mode,
    subtotal_paise, convenience_fee_paise, total_paise, commission_paise,
    attendee_name, attendee_note
  )
  values (
    v_reference, ev.id, tt.id, p_attendee_id, p_quantity,
    'pending_approval', p_payment_mode,
    -- Priced at approval time, not request time.
    0, 0, 0, 0,
    nullif(btrim(p_attendee_name), ''), p_attendee_note
  )
  returning * into booking;

  return booking;

exception
  -- The pre-check loses the race sometimes; the index never does. Same
  -- remap, and the same reasoning, as book_free_tickets' handler.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH054';
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- approve_booking -- new body, same signature
-- ---------------------------------------------------------------------------
-- `create or replace` suffices: the signature is unchanged, so the existing
-- grants survive. What changes:
--   * a started-event guard (EH055) -- approving admits someone to a supper
--     club that is already eating;
--   * the not-pending refusal gets a code (EH056) so the host UI can say
--     "already handled" instead of raw Postgres;
--   * cash confirms DIRECTLY (Phase 0 auto-confirmed only at total 0, which
--     would strand a cash request in awaiting_payment asking for online
--     money), with fee and commission zeroed to mirror reserve_tickets;
--   * free keeps its direct confirm; both go straight from pending_approval,
--     which confirm_booking has tolerated since Phase 0.
-- Over-approval keeps its human sentence and passes through unmapped.

create or replace function approve_booking(
  p_booking_id            uuid,
  p_convenience_fee_paise bigint default 0,
  p_commission_paise      bigint default 0,
  p_hold_hours            integer default 24
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  booking   bookings%rowtype;
  ev        events%rowtype;
  tt        ticket_types%rowtype;
  available integer;
  subtotal  bigint;
  fee       bigint;
begin
  select * into booking from bookings where id = p_booking_id for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if booking.status <> 'pending_approval' then
    raise exception 'booking is not awaiting approval (status: %)', booking.status
      using errcode = 'EH056';
  end if;

  select * into ev from events where id = booking.event_id;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH055';
  end if;

  -- Reclaim lapsed holds before judging availability, otherwise abandoned
  -- checkouts make the room look full to the host saying yes.
  perform release_expired_holds(booking.ticket_type_id);

  select * into tt from ticket_types where id = booking.ticket_type_id for update;

  available := tt.quantity - tt.reserved_count;
  if available < booking.quantity then
    raise exception 'only % seats remain; cannot approve this request', available
      using errcode = 'check_violation';
  end if;

  subtotal := tt.price_paise * booking.quantity;
  -- Cash pays the ticket price at the door: no online fee to collect, no
  -- commission during the pilot -- the same zeroing reserve_tickets applies.
  fee := case when booking.payment_mode = 'cash' then 0 else p_convenience_fee_paise end;

  update ticket_types
     set reserved_count = reserved_count + booking.quantity
   where id = tt.id;

  if booking.payment_mode = 'cash' or subtotal + fee = 0 then
    -- Nothing to pay online: stamp the money and confirm straight from
    -- pending_approval. No awaiting_payment, no hold -- the seat is theirs.
    update bookings
       set approved_at = now(),
           subtotal_paise = subtotal,
           convenience_fee_paise = fee,
           total_paise = subtotal + fee,
           commission_paise = case when booking.payment_mode = 'cash' then 0
                                   else p_commission_paise end
     where id = p_booking_id;

    return confirm_booking(p_booking_id);
  end if;

  update bookings
     set status = 'awaiting_payment',
         approved_at = now(),
         subtotal_paise = subtotal,
         convenience_fee_paise = fee,
         total_paise = subtotal + fee,
         commission_paise = p_commission_paise,
         hold_expires_at = now() + make_interval(hours => p_hold_hours)
   where id = p_booking_id
  returning * into booking;

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- book_cash_tickets -- the cash mirror of book_free_tickets
-- ---------------------------------------------------------------------------
-- Reserve + confirm in one transaction: a cash booking is confirmed the
-- moment it is made -- the host opted into no-show risk by ticking the box,
-- and can free the seat by removing the guest. Commission is zeroed by
-- reserve_tickets for cash; the convenience fee stays at its 0 default.
--
--   EH054  this attendee already has an active booking on this event
--   EH057  the ticket type is free; the free path is the right door
--   EH058  the event requires approval; cash goes through a request instead
--   EH059  the event has already started
--
-- reserve_tickets itself refuses cash where allows_cash is false, with a
-- sentence already written for a human -- it passes through unmapped.
--
-- `extensions` on the search_path because confirm_booking needs pgcrypto's
-- gen_random_bytes for ticket codes, and it inherits this setting when
-- called from here (the book_free_tickets precedent).

create function book_cash_tickets(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text,
  p_attendee_note  text default null
)
returns bookings
language plpgsql
security definer
set search_path = public, extensions
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
      using errcode = 'EH057';
  end if;

  if ev.requires_approval then
    raise exception 'this event requires host approval; request instead'
      using errcode = 'EH058';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH059';
  end if;

  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH054';
  end if;

  -- Published status, the sales window, max_per_order, availability under the
  -- row lock, and the allows_cash refusal are reserve_tickets' job; its
  -- sentences pass through.
  booking := reserve_tickets(
    p_ticket_type_id => p_ticket_type_id,
    p_attendee_id    => p_attendee_id,
    p_quantity       => p_quantity,
    p_payment_mode   => 'cash',
    p_attendee_note  => p_attendee_note
  );

  -- reserve_tickets has no name parameter and should not grow one (see
  -- 20260810000003). Written here, inside the same transaction.
  update bookings
     set attendee_name = nullif(btrim(p_attendee_name), '')
   where id = booking.id;

  return confirm_booking(booking.id);

exception
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH054';
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- One order per booking's lifetime, now as a constraint
-- ---------------------------------------------------------------------------
-- Phase 3 stated the rule; Phase 5a leans on it (beginApprovedCheckout's
-- idempotency is a read-then-insert that this index makes race-safe, the
-- refunds_one_per_payment precedent). Every existing booking has at most one
-- payments row, so this backfills clean.

create unique index payments_one_per_booking on payments (booking_id);

-- ---------------------------------------------------------------------------
-- Lock down: service role only, never reachable over public RPC.
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default, so revoking from PUBLIC
-- removes it for everyone -- service_role included -- and each function has
-- to be granted back explicitly. approve_booking kept its signature, so its
-- existing revoke/grant survives the replace and is not restated.

revoke execute on function request_booking(uuid, uuid, integer, text, text, payment_mode)
  from public, anon, authenticated;
revoke execute on function book_cash_tickets(uuid, uuid, integer, text, text)
  from public, anon, authenticated;

grant execute on function request_booking(uuid, uuid, integer, text, text, payment_mode)
  to service_role;
grant execute on function book_cash_tickets(uuid, uuid, integer, text, text)
  to service_role;
