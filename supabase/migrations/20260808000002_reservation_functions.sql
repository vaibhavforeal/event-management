-- Inventory operations.
--
-- Every mutation of ticket_types.reserved_count lives in this file. Nothing
-- else may touch that column — that is the whole reason overselling is
-- preventable here.
--
-- Authorisation model: these functions are SECURITY DEFINER but EXECUTE is
-- revoked from anon and authenticated, so they cannot be reached over PostgREST
-- RPC. They are callable only by the service role, from a Server Action that
-- has already authenticated the user. RLS still guards ordinary reads.

-- ---------------------------------------------------------------------------
-- Booking references: short, unambiguous when read aloud at a venue door.
-- Crockford-ish base32 with I, L, O and U removed.
-- ---------------------------------------------------------------------------

create or replace function generate_booking_reference()
returns text
language plpgsql
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  result   text := '';
  i        integer;
begin
  for i in 1..8 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- release_expired_holds — returns inventory from lapsed checkouts
-- ---------------------------------------------------------------------------
-- Called both by the cron sweeper (no argument) and inline by reserve_tickets
-- for the ticket type being sold, so that an abandoned checkout never blocks a
-- live buyer for longer than the hold window.

create or replace function release_expired_holds(p_ticket_type_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  released integer := 0;
  rec      record;
begin
  for rec in
    select b.id, b.ticket_type_id, b.quantity
    from bookings b
    where b.status = 'awaiting_payment'
      and b.hold_expires_at < now()
      and (p_ticket_type_id is null or b.ticket_type_id = p_ticket_type_id)
    order by b.ticket_type_id
    for update of b skip locked
  loop
    update bookings
       set status = 'expired',
           cancelled_at = now(),
           cancellation_reason = 'payment hold expired'
     where id = rec.id;

    update ticket_types
       set reserved_count = greatest(0, reserved_count - rec.quantity)
     where id = rec.ticket_type_id;

    released := released + 1;
  end loop;

  return released;
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_tickets — the atomic path from "I want seats" to a held booking
-- ---------------------------------------------------------------------------
-- Takes a row lock on the ticket type, so concurrent callers serialise. The
-- CHECK constraint on ticket_types is the backstop if this logic is ever wrong.
--
-- Fee amounts are computed by lib/pricing (TypeScript) and passed in, but the
-- subtotal is recomputed here from the stored price so the largest number in
-- the transaction cannot be falsified by a buggy caller.

create or replace function reserve_tickets(
  p_ticket_type_id        uuid,
  p_attendee_id           uuid,
  p_quantity              integer,
  p_convenience_fee_paise bigint default 0,
  p_commission_paise      bigint default 0,
  p_payment_mode          payment_mode default 'online',
  p_hold_minutes          integer default 10,
  p_attendee_note         text default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  tt        ticket_types%rowtype;
  ev        events%rowtype;
  available integer;
  subtotal  bigint;
  booking   bookings%rowtype;
  -- v_ prefix is not decoration: an unprefixed `reference` collides with
  -- bookings.reference and Postgres raises 42702 (ambiguous column reference).
  v_reference text;
  attempts    integer := 0;
begin
  if p_quantity < 1 then
    raise exception 'quantity must be at least 1'
      using errcode = 'check_violation';
  end if;

  -- Reclaim anything lapsed before judging availability, otherwise abandoned
  -- checkouts make an event look sold out.
  perform release_expired_holds(p_ticket_type_id);

  -- Serialises concurrent buyers of this ticket type. Everything below is
  -- under this lock.
  select * into tt
    from ticket_types
   where id = p_ticket_type_id
   for update;

  if not found then
    raise exception 'ticket type % not found', p_ticket_type_id
      using errcode = 'no_data_found';
  end if;

  select * into ev from events where id = tt.event_id;

  if ev.status <> 'published' then
    raise exception 'event is not open for booking (status: %)', ev.status
      using errcode = 'check_violation';
  end if;

  if p_payment_mode = 'cash' and not ev.allows_cash then
    raise exception 'this event does not accept cash payment'
      using errcode = 'check_violation';
  end if;

  if tt.sales_start is not null and now() < tt.sales_start then
    raise exception 'sales have not opened yet'
      using errcode = 'check_violation';
  end if;

  if tt.sales_end is not null and now() > tt.sales_end then
    raise exception 'sales have closed'
      using errcode = 'check_violation';
  end if;

  if p_quantity > tt.max_per_order then
    raise exception 'cannot book more than % per order', tt.max_per_order
      using errcode = 'check_violation';
  end if;

  available := tt.quantity - tt.reserved_count;
  if available < p_quantity then
    raise exception 'only % seats remain', available
      using errcode = 'check_violation';
  end if;

  subtotal := tt.price_paise * p_quantity;

  update ticket_types
     set reserved_count = reserved_count + p_quantity
   where id = tt.id;

  -- Reference collisions are vanishingly unlikely but cheap to retry.
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
    hold_expires_at, attendee_note
  )
  values (
    v_reference, ev.id, tt.id, p_attendee_id, p_quantity,
    'awaiting_payment', p_payment_mode,
    subtotal, p_convenience_fee_paise, subtotal + p_convenience_fee_paise,
    case when p_payment_mode = 'cash' then 0 else p_commission_paise end,
    now() + make_interval(mins => p_hold_minutes), p_attendee_note
  )
  returning * into booking;

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_booking — payment captured (or cash reservation accepted)
-- ---------------------------------------------------------------------------
-- Keeps the inventory already held and issues one ticket per seat. Idempotent:
-- confirming an already-confirmed booking is a no-op, which matters because
-- payment webhooks are redelivered.

create or replace function confirm_booking(p_booking_id uuid)
returns bookings
language plpgsql
security definer
-- `extensions` is on the path because Supabase installs pgcrypto there, and
-- ticket codes come from gen_random_bytes().
set search_path = public, extensions
as $$
declare
  booking bookings%rowtype;
  i       integer;
begin
  select * into booking from bookings where id = p_booking_id for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if booking.status = 'confirmed' then
    return booking;  -- already done; webhook replay
  end if;

  if booking.status not in ('awaiting_payment', 'pending_approval') then
    raise exception 'cannot confirm a booking with status %', booking.status
      using errcode = 'check_violation';
  end if;

  update bookings
     set status = 'confirmed',
         confirmed_at = now(),
         hold_expires_at = null
   where id = p_booking_id
  returning * into booking;

  for i in 1..booking.quantity loop
    insert into tickets (booking_id, code)
    values (
      booking.id,
      -- 128 bits, hex. The QR signature is derived from this, never stored.
      encode(gen_random_bytes(16), 'hex')
    );
  end loop;

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_booking — returns inventory
-- ---------------------------------------------------------------------------

create or replace function cancel_booking(
  p_booking_id uuid,
  p_reason     text default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  booking bookings%rowtype;
begin
  select * into booking from bookings where id = p_booking_id for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if booking.status in ('cancelled', 'expired', 'refunded') then
    return booking;  -- idempotent
  end if;

  -- pending_approval never consumed inventory, so there is nothing to give back.
  if booking.status in ('awaiting_payment', 'confirmed') then
    update ticket_types
       set reserved_count = greatest(0, reserved_count - booking.quantity)
     where id = booking.ticket_type_id;
  end if;

  update bookings
     set status = 'cancelled',
         cancelled_at = now(),
         cancellation_reason = p_reason,
         hold_expires_at = null
   where id = p_booking_id
  returning * into booking;

  delete from tickets where booking_id = p_booking_id and checked_in_at is null;

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- request_booking — approval-gated events
-- ---------------------------------------------------------------------------
-- Deliberately does NOT consume inventory. A curated supper club will get more
-- requests than seats; that is the point. Inventory is taken at approval time
-- via approve_booking(), which can legitimately fail if the host over-approves.

create or replace function request_booking(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_note  text default null
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  tt        ticket_types%rowtype;
  ev        events%rowtype;
  booking   bookings%rowtype;
  -- v_ prefix is not decoration: an unprefixed `reference` collides with
  -- bookings.reference and Postgres raises 42702 (ambiguous column reference).
  v_reference text;
  attempts    integer := 0;
begin
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
    raise exception 'this event does not use approvals; call reserve_tickets'
      using errcode = 'check_violation';
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
    attendee_note
  )
  values (
    v_reference, ev.id, tt.id, p_attendee_id, p_quantity,
    'pending_approval', 'online',
    -- Priced at approval time, not request time.
    0, 0, 0, 0,
    p_attendee_note
  )
  returning * into booking;

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- approve_booking — host says yes; now inventory is taken and a price is set
-- ---------------------------------------------------------------------------

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
  tt        ticket_types%rowtype;
  available integer;
  subtotal  bigint;
begin
  select * into booking from bookings where id = p_booking_id for update;

  if not found then
    raise exception 'booking % not found', p_booking_id
      using errcode = 'no_data_found';
  end if;

  if booking.status <> 'pending_approval' then
    raise exception 'booking is not awaiting approval (status: %)', booking.status
      using errcode = 'check_violation';
  end if;

  perform release_expired_holds(booking.ticket_type_id);

  select * into tt from ticket_types where id = booking.ticket_type_id for update;

  available := tt.quantity - tt.reserved_count;
  if available < booking.quantity then
    raise exception 'only % seats remain; cannot approve this request', available
      using errcode = 'check_violation';
  end if;

  subtotal := tt.price_paise * booking.quantity;

  update ticket_types
     set reserved_count = reserved_count + booking.quantity
   where id = tt.id;

  update bookings
     set status = 'awaiting_payment',
         approved_at = now(),
         subtotal_paise = subtotal,
         convenience_fee_paise = p_convenience_fee_paise,
         total_paise = subtotal + p_convenience_fee_paise,
         commission_paise = p_commission_paise,
         hold_expires_at = now() + make_interval(hours => p_hold_hours)
   where id = p_booking_id
  returning * into booking;

  -- A free approved event has nothing to pay, so skip straight to confirmed.
  if booking.total_paise = 0 then
    booking := confirm_booking(p_booking_id);
  end if;

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock these down: service role only, never reachable over public RPC.
-- ---------------------------------------------------------------------------

-- Postgres grants EXECUTE to PUBLIC by default, so revoking from PUBLIC removes
-- it for everyone — service_role included. Each function therefore has to be
-- granted back explicitly.

revoke execute on function release_expired_holds(uuid) from public, anon, authenticated;
revoke execute on function reserve_tickets(uuid, uuid, integer, bigint, bigint, payment_mode, integer, text) from public, anon, authenticated;
revoke execute on function confirm_booking(uuid) from public, anon, authenticated;
revoke execute on function cancel_booking(uuid, text) from public, anon, authenticated;
revoke execute on function request_booking(uuid, uuid, integer, text) from public, anon, authenticated;
revoke execute on function approve_booking(uuid, bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function generate_booking_reference() from public, anon, authenticated;

grant execute on function release_expired_holds(uuid) to service_role;
grant execute on function reserve_tickets(uuid, uuid, integer, bigint, bigint, payment_mode, integer, text) to service_role;
grant execute on function confirm_booking(uuid) to service_role;
grant execute on function cancel_booking(uuid, text) to service_role;
grant execute on function request_booking(uuid, uuid, integer, text) to service_role;
grant execute on function approve_booking(uuid, bigint, bigint, integer) to service_role;
grant execute on function generate_booking_reference() to service_role;
