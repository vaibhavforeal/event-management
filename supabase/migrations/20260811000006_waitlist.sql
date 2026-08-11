-- Phase 5b: demand past capacity, kept.
--
-- A sold-out instant-book event stops refusing people. An attendee joins a
-- line, a freed seat is offered to the head of it automatically with a 24-hour
-- window, and the offer rides the rails 5a already built: promotion leaves a
-- booking shaped exactly like a just-granted approval -- awaiting_payment,
-- approved_at stamped, hold_expires_at 24 hours out -- so beginApprovedCheckout,
-- the webhook, reconciliation and release_expired_holds all apply unchanged.
--
-- The trigger story is three existing functions, recreated at the bottom of
-- this file to end with a promote_from_waitlist call. Every seat this product
-- frees flows through cancel_booking or release_expired_holds, and every seat
-- it sells flows through reserve_tickets, so those three calls are the whole
-- of it. No cron, no queue worker, no new sweep.

-- ---------------------------------------------------------------------------
-- events.has_waitlist -- the opt-in, and its exclusivity
-- ---------------------------------------------------------------------------
-- Instant-book events only. An approval event's request queue already captures
-- unlimited demand -- requests stay open at capacity, which is 5a's whole
-- curation model -- so a second queue beside it would put two lists on one
-- attendees page answering the same question.
--
-- The CHECK is not belt-and-braces, it is what makes a load-bearing inference
-- true: on a has_waitlist event, an awaiting_payment row carrying approved_at
-- is ALWAYS a seat offer, because no approval could have produced one. Every
-- copy branch in the application reads the event flags and trusts exactly that.
-- The event writers below also coerce rather than raise, so a host ticking
-- approval on an event that had a waitlist gets their intent honoured instead
-- of a constraint name; this is the backstop under a crafted RPC call.

alter table events add column has_waitlist boolean not null default false;

alter table events add constraint events_one_queue
  check (not (requires_approval and has_waitlist));

-- ---------------------------------------------------------------------------
-- One active booking per attendee per event -- now including the line
-- ---------------------------------------------------------------------------
-- Being in the line is being on the event: it is a bookings row with a
-- reference, it shows on /bookings, and it can be withdrawn. So it counts
-- against the same rule, or a person joins the waitlist five times from one
-- phone and takes the whole room the moment seats free.
--
-- Recreated rather than altered -- a partial index's predicate cannot be
-- changed in place. 'cancelled' and 'expired' stay outside it, which is what
-- lets a withdrawn entry, a declined request or a lapsed offer be followed by
-- a fresh one: rejoining at the back of the line is the documented answer to a
-- lapsed offer, and it needs this index to allow it.

drop index bookings_one_active_per_attendee;

create unique index bookings_one_active_per_attendee
  on bookings (event_id, attendee_id)
  where status in ('pending_approval', 'waitlisted', 'awaiting_payment', 'confirmed');

-- ---------------------------------------------------------------------------
-- waitlist_length -- how many are in line, for a stranger
-- ---------------------------------------------------------------------------
-- The one function in this repo granted to anon, and the exception is
-- deliberate rather than convenient. The public event page has to know the
-- line's length for two reasons: it prints it ("3 people waiting"), and it
-- decides on it -- while the line is non-empty the page stays in join-waitlist
-- mode even if a seat is free, so a walk-up cannot cut. That page is served to
-- signed-out visitors, and `bookings` is granted to `authenticated` alone
-- (20260808000003:212), so an embed or a count from the page answers 42501
-- rather than a number.
--
-- What crosses the boundary is one integer with no identity in it, on a page
-- that then prints that integer to the same stranger. Nothing else here is
-- reachable this way: it takes a ticket type id, which is already public on
-- that page, and returns a count.

create function waitlist_length(p_ticket_type_id uuid)
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select count(*)::integer
    from bookings
   where ticket_type_id = p_ticket_type_id
     and status = 'waitlisted';
$$;

-- ---------------------------------------------------------------------------
-- waitlist_position -- "you're #3 in line"
-- ---------------------------------------------------------------------------
-- 1-based, and 0 for a booking that is not waitlisted -- which is how the
-- caller learns "this row has no position" without a second query. The tuple
-- comparison is the same (created_at, id) ordering promote_from_waitlist
-- promotes by, written once in each place and asserted against each other in
-- the promotion suite: a position that disagrees with the promotion order is
-- worse than no position at all.
--
-- Service role only, unlike waitlist_length. This one takes a booking id and
-- says something about one identifiable person's standing, so it goes through
-- lib/bookings/service.ts, which checks the caller owns the booking or hosts
-- the event before asking.

create function waitlist_position(p_booking_id uuid)
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select count(*)::integer
    from bookings peer
    join bookings self on self.id = p_booking_id
   where self.status = 'waitlisted'
     and peer.ticket_type_id = self.ticket_type_id
     and peer.status = 'waitlisted'
     and (peer.created_at, peer.id) <= (self.created_at, self.id);
$$;

-- ---------------------------------------------------------------------------
-- join_waitlist -- request_booking's shape, for events that vet nobody
-- ---------------------------------------------------------------------------
-- Consumes no inventory and stores 0/0/0: the entry is a claim on a seat that
-- does not exist yet, and it is priced at offer time from the price the host
-- charges then. No note field -- the host is not vetting anyone, so there is
-- nothing to pitch.
--
--   EH060  this event keeps no waitlist (toggle off, or it uses approvals)
--   EH061  the event has already started
--   EH062  cash was chosen but the event does not allow it
--   EH063  more seats than max_per_order allows
--   EH064  seats are open and the line is empty -- book instead
--   EH065  this attendee already has an active booking or entry on this event
--
-- Unpublished passes through as the existing check_violation sentence, as in
-- 5a. Deliberately takes no row lock on the ticket type: nothing here moves
-- inventory, and the worst a lost race under EH064 can produce is one
-- redundant entry that the very next promote call serves.

create function join_waitlist(
  p_ticket_type_id uuid,
  p_attendee_id    uuid,
  p_quantity       integer,
  p_attendee_name  text,
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
  available   integer;
  -- v_ prefix is not decoration: an unprefixed `reference` collides with
  -- bookings.reference and Postgres raises 42702 (ambiguous column reference).
  v_reference text;
  attempts    integer := 0;
begin
  if p_quantity < 1 then
    raise exception 'quantity must be at least 1'
      using errcode = 'check_violation';
  end if;

  -- Settle first, exactly as reserve_tickets does, so "available" below is
  -- truthful rather than inflated by abandoned checkouts. This call also
  -- promotes whatever it frees -- see release_expired_holds at the bottom of
  -- this file -- which is why the read of tt comes after it and not before.
  perform release_expired_holds(p_ticket_type_id);

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

  -- One code for both, because they are one fact to the attendee: there is no
  -- line to join here. events_one_queue makes the second half unreachable
  -- while has_waitlist is true, and it is checked anyway so that the day the
  -- constraint is relaxed this function refuses rather than misbehaves.
  if not ev.has_waitlist or ev.requires_approval then
    raise exception 'this event does not keep a waitlist'
      using errcode = 'EH060';
  end if;

  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH061';
  end if;

  if p_payment_mode = 'cash' and not ev.allows_cash then
    raise exception 'this event does not accept cash payment'
      using errcode = 'EH062';
  end if;

  -- reserve_tickets enforces this for every other booking kind; a waitlist
  -- entry never reaches it, so the cap holds here or nowhere. Same reasoning
  -- as request_booking's EH053.
  if p_quantity > tt.max_per_order then
    raise exception 'cannot join for more than % per order', tt.max_per_order
      using errcode = 'EH063';
  end if;

  -- Refuse only when the seats they asked for are actually there AND nobody is
  -- ahead of them -- i.e. when "book instead" is advice they can follow. A
  -- three-seat joiner looking at one free seat is told nothing of the kind;
  -- they belong in the line.
  available := tt.quantity - tt.reserved_count;
  if available >= p_quantity and not exists (
    select 1 from bookings b
     where b.ticket_type_id = p_ticket_type_id
       and b.status = 'waitlisted'
  ) then
    raise exception 'seats are open on this event; book instead of joining the waitlist'
      using errcode = 'EH064';
  end if;

  -- The friendly half of the one-booking rule; the partial unique index is the
  -- half that holds under concurrency. Same shape as request_booking's EH054.
  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'waitlisted', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH065';
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
    attendee_name
  )
  values (
    v_reference, ev.id, tt.id, p_attendee_id, p_quantity,
    'waitlisted', p_payment_mode,
    -- Priced at offer time, not join time. The host's price today is the one
    -- the offer will quote, which is 5a's repricing rule, one story product-wide.
    0, 0, 0, 0,
    nullif(btrim(p_attendee_name), '')
  )
  returning * into booking;

  return booking;

exception
  -- The pre-check loses the race sometimes; the index never does.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH065';
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- promote_from_waitlist -- the offer engine
-- ---------------------------------------------------------------------------
-- Under the ticket-type row lock, walk the line from the front and offer seats
-- to whoever fits, until the head does not fit or the line runs out. Returns
-- how many were promoted, which is what the tests assert against.
--
-- What a promoted row becomes is the point of the whole design: awaiting_payment,
-- approved_at stamped, hold_expires_at 24 hours out, repriced from the CURRENT
-- price_paise. That is character for character the shape approve_booking leaves
-- an online approval in, so beginApprovedCheckout accepts it unchanged, the
-- webhook and reconcile paths confirm it unchanged, release_expired_holds
-- expires it unchanged, and bookings_expiring_idx already indexes it. This
-- function adds an engine, not a lifecycle.
--
-- It does NOT confirm free or cash offers. A ghost in the line would otherwise
-- be handed a seat forever without ever acting; the offer has to be claimed,
-- and an unclaimed one lapses back to the next person like any other hold.
--
-- Safe to call anywhere, which is what lets the three seams below call it
-- unconditionally: no such ticket type, no waitlist, toggle off, event started,
-- nothing free, empty line -- every one of them returns 0 having written
-- nothing.
--
-- Strict FIFO. A three-seat head waits while one seat sits free, and nobody
-- passes them. The seat idles; that is the accepted cost of a queue nobody can
-- cut, and it is what makes the queue worth joining. The one pathology is an
-- entry larger than the ticket type's whole capacity -- after a capacity cut,
-- say -- which blocks the line until the host removes it. Documented in the
-- spec's limitations; deliberately not special-cased, because "skip the ones
-- that don't fit" is exactly the starvation rule FIFO was chosen over.
--
-- search_path is plain `public`: nothing here calls confirm_booking, so
-- pgcrypto is not needed.

create function promote_from_waitlist(
  p_ticket_type_id uuid,
  p_hold_hours     integer default 24
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  tt        ticket_types%rowtype;
  ev        events%rowtype;
  head      bookings%rowtype;
  head_id   uuid;
  available integer;
  subtotal  bigint;
  promoted  integer := 0;
begin
  -- Serialises every promoter for this ticket type against each other and
  -- against reserve_tickets, which is what makes "the waitlister gets the seat,
  -- not the walk-up" a fact rather than a hope.
  select * into tt from ticket_types where id = p_ticket_type_id for update;
  if not found then
    return 0;
  end if;

  select * into ev from events where id = tt.event_id;

  -- Nobody is offered a seat to an event that is already happening. The
  -- entries left in the line stay where they are: withdrawable, harmless, and
  -- swept by nothing.
  if not ev.has_waitlist or ev.starts_at <= now() then
    return 0;
  end if;

  loop
    available := tt.quantity - tt.reserved_count;
    exit when available <= 0;

    -- Read the head first without a lock, then lock that exact row. The two
    -- steps exist to avoid a deadlock that a single locking select would walk
    -- into: withdrawing an entry locks the booking row and then wants this
    -- ticket type (cancel_booking ends by calling this function), while we
    -- hold the ticket type and want the booking row. `skip locked` on a
    -- named id turns that cycle into an exit -- and exiting is correct, not a
    -- concession: the transaction holding that row is a withdrawal, and it
    -- calls this function itself on its way out, so the seat is offered a
    -- moment later by them instead of now by us. Selecting the NEXT unlocked
    -- row instead would jump the queue, which is the one thing this engine
    -- must never do.
    select b.id into head_id
      from bookings b
     where b.ticket_type_id = p_ticket_type_id
       and b.status = 'waitlisted'
     order by b.created_at, b.id
     limit 1;
    exit when head_id is null;

    select * into head from bookings where id = head_id for update skip locked;
    exit when not found;

    -- The head does not fit: the line stops here. Nobody behind them is
    -- considered, however small their entry.
    exit when head.quantity > available;

    subtotal := tt.price_paise * head.quantity;

    update ticket_types
       set reserved_count = reserved_count + head.quantity
     where id = tt.id
    returning * into tt;

    update bookings
       set status = 'awaiting_payment',
           approved_at = now(),
           subtotal_paise = subtotal,
           -- Both zero outright rather than parameterised. Fees and commission
           -- are 0 pilot-wide, and cash zeroes commission by construction, so
           -- there is no number a caller could pass that this phase would
           -- honour. approve_booking's fee parameters are the wiring point for
           -- lib/pricing when that day comes; this function is not.
           convenience_fee_paise = 0,
           total_paise = subtotal,
           commission_paise = 0,
           hold_expires_at = now() + make_interval(hours => p_hold_hours)
     where id = head.id;

    promoted := promoted + 1;
  end loop;

  return promoted;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_booking -- recreated, now offering the seat on its way out
-- ---------------------------------------------------------------------------
-- Same signature, so `create or replace` keeps the existing grants. The body is
-- verbatim from 20260808000002 apart from the promote call and the widened
-- comment; every reason written there still holds.
--
-- The call is unconditional, including for a cancelled row that held no
-- inventory, and that is not laziness: withdrawing a big waitlist entry frees
-- no seat but UNBLOCKS THE LINE behind it, so a smaller entry that has been
-- waiting behind a three-seat head can finally be served. A promote call gated
-- on "did this return inventory" would miss exactly that case.

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

  -- pending_approval and waitlisted never consumed inventory, so there is
  -- nothing to give back for either.
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

  -- Half the trigger story (release_expired_holds is the other half). A seat
  -- freed by an attendee cancelling, a host removing a guest, or a host
  -- declining goes to the head of the line before anyone else can see it.
  perform promote_from_waitlist(booking.ticket_type_id);

  return booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- release_expired_holds -- recreated, offering what it reclaims
-- ---------------------------------------------------------------------------
-- Same signature. What is new is the array of touched ticket types and the
-- promote pass after the loop.
--
-- Promoting inside the FOR loop would be promoting while iterating a cursor
-- over the very rows being changed, so it happens after, once per distinct
-- ticket type. Distinct matters: the argument-less sweep can release twenty
-- lapsed holds across three ticket types, and each promote call already walks
-- its whole line.
--
-- This is also what makes a lapsed OFFER chain to the next person with no extra
-- machinery: an unclaimed offer is an awaiting_payment row with an expiry, so
-- this function expires it, returns its seat, and offers that seat onward in
-- the same call.

create or replace function release_expired_holds(p_ticket_type_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  released integer := 0;
  rec      record;
  touched  uuid[] := '{}';
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

    touched := array_append(touched, rec.ticket_type_id);
    released := released + 1;
  end loop;

  for rec in select distinct t as ticket_type_id from unnest(touched) t loop
    perform promote_from_waitlist(rec.ticket_type_id);
  end loop;

  return released;
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_tickets -- recreated, so a walk-up can never cut the line
-- ---------------------------------------------------------------------------
-- Same signature, and the body is verbatim from 20260808000002 apart from ONE
-- added line: a promote call beside the existing release_expired_holds call,
-- before the row lock is taken and long before any seat is handed out.
--
-- release_expired_holds alone would not be enough. It promotes only what it
-- actually reclaimed, so seats that appear by some other route -- a host
-- raising capacity on an event that already has a line -- would sit there for
-- the next walk-up to take, past everyone waiting. The unconditional call
-- closes that, and costs a non-waitlist event one extra select on a row it is
-- about to lock anyway plus an early return.
--
-- The consequence is intended and is what the concurrency test asserts: on a
-- waitlist event with a line, a walk-up's own reservation attempt hands the
-- free seats to the line first and is then refused with "only 0 seats remain".

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
  -- And offer what is free to the line before selling any of it. A no-op on
  -- every event that keeps no waitlist.
  perform promote_from_waitlist(p_ticket_type_id);

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
-- The event writers, re-created with the waitlist toggle
-- ---------------------------------------------------------------------------
-- Both gain a trailing `p_has_waitlist boolean default false`. The default
-- keeps the generated Args type optional, so app/host/events/actions.ts still
-- compiles until Task 5 passes it -- the 20260811000002 precedent, which added
-- p_refund_cutoff_hours the same way.
--
-- `create or replace` cannot change a signature: it would create an overload
-- beside the old function and PostgREST would refuse the ambiguous name. Drop
-- first, naming the CURRENT signatures -- the ones from 20260811000002 that
-- carry p_refund_cutoff_hours, not the 20260809000001 originals.
--
-- The bodies are otherwise verbatim from 20260811000002. Posture (SECURITY
-- INVOKER, so events_insert_own / events_update_own still evaluate), ownership
-- scoping, the oversell check and the reasoning in those comments all still
-- hold and are not restated here.
--
-- `p_has_waitlist and not p_requires_approval` rather than the raw parameter:
-- the two queues are exclusive, and a host who ticks approval on an event that
-- had a waitlist should get their intent honoured rather than events_one_queue's
-- constraint name. The CHECK stays as the backstop for a crafted RPC call.

drop function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
);
drop function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer
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
  p_refund_cutoff_hours       integer default 24,
  p_has_waitlist              boolean default false
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
    hide_venue_until_approved, refund_cutoff_hours, has_waitlist, status
  )
  values (
    p_host_id, p_slug, p_title, p_description, p_city, p_venue_name,
    p_venue_address, p_cover_image_url, p_starts_at, p_ends_at,
    p_requires_approval, p_allows_cash, p_hide_venue_until_approved,
    p_refund_cutoff_hours, p_has_waitlist and not p_requires_approval, 'draft'
  )
  returning * into ev;

  -- No compensating delete. If this raises, the insert above is rolled back by
  -- the transaction PostgREST opened for this call.
  insert into ticket_types (event_id, name, price_paise, quantity)
  values (ev.id, 'General', p_price_paise, p_quantity);

  return ev;
end;
$$;

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
  p_refund_cutoff_hours       integer default 24,
  p_has_waitlist              boolean default false
)
returns events
language plpgsql
set search_path = public
as $$
declare
  ev     events%rowtype;
  ticket ticket_types%rowtype;
begin
  -- Ownership is settled once, here, before anything is written, and the row
  -- is held `for update` from the moment it is read -- which is why the update
  -- at the end is scoped on id alone. See 20260809000001 for the full essay.
  select * into ev
    from events
   where id = p_event_id
     and host_id = current_host_id()
   for update;

  if ev.id is null then
    raise exception 'event % is not yours to edit', p_event_id
      using errcode = 'EH002';
  end if;

  select * into ticket
    from ticket_types
   where event_id = p_event_id
   order by sort_order, created_at
   limit 1
   for update;

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
         refund_cutoff_hours       = p_refund_cutoff_hours,
         has_waitlist              = p_has_waitlist and not p_requires_approval
   where id = p_event_id
  returning * into ev;

  return ev;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reachability
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default, so revoking from PUBLIC removes
-- it for everyone -- service_role included -- and each function has to be
-- granted back explicitly. `anon` is named alongside PUBLIC rather than left to
-- be covered by it, because a direct grant to anon survives a revoke from
-- PUBLIC and hosted Supabase projects commonly carry one (20260809000001's
-- reasoning, in full there).
--
-- cancel_booking, release_expired_holds and reserve_tickets kept their
-- signatures, so their existing revoke/grant pairs survive the replace and are
-- not restated.
--
-- waitlist_length is the one exception in this file, granted to anon on
-- purpose: the public event page is served to strangers and cannot function
-- without the line's length. See its own comment above.

revoke execute on function join_waitlist(uuid, uuid, integer, text, payment_mode)
  from public, anon, authenticated;
revoke execute on function promote_from_waitlist(uuid, integer)
  from public, anon, authenticated;
revoke execute on function waitlist_position(uuid)
  from public, anon, authenticated;
revoke execute on function waitlist_length(uuid) from public;
revoke execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) from public, anon;
revoke execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) from public, anon;

grant execute on function join_waitlist(uuid, uuid, integer, text, payment_mode)
  to service_role;
grant execute on function promote_from_waitlist(uuid, integer) to service_role;
grant execute on function waitlist_position(uuid) to service_role;
grant execute on function waitlist_length(uuid) to anon, authenticated, service_role;
grant execute on function create_event_with_ticket_type(
  uuid, text, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) to authenticated, service_role;
grant execute on function update_event_with_ticket_type(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz,
  boolean, boolean, boolean, bigint, integer, integer, boolean
) to authenticated, service_role;
