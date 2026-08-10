-- Ticket check-in, as one atomic decision per scan.
--
-- Same posture as every inventory write in this repo: SECURITY DEFINER with
-- EXECUTE revoked, callable only as the service role from
-- lib/checkin/service.ts, which authenticates the host itself. RLS grants no
-- ticket UPDATE to clients at all -- 20260808000003's comment on the tickets
-- policies says check-in "goes through a server function so a guest cannot
-- mark themselves admitted", and these are that function.
--
--   EH020  no ticket with this code -- or booking with this id -- on this event
--   EH021  the ticket's booking is not confirmed
--   EH022  (next_ticket only) every ticket on the booking is already in
--
-- "Already checked in" is deliberately NOT an error. A door sees it hourly --
-- the same QR shown twice, a screenshot forwarded to the friend who arrives
-- second -- so it comes back as a row with outcome = 'already_checked_in' and
-- the ORIGINAL checked_in_at, which is what lets the scanner say "at 8:14 pm".
--
-- p_event_id is matched in the lookup, not trusted from context: codes are
-- globally unique, so without the match a host could check in another event's
-- ticket by posting its code to their own door's action. With it, that scan is
-- EH020, which is true from that host's doorway.
--
-- attendee_name in the return is bookings.attendee_name -- the name typed at
-- booking. tickets.attendee_name is null on every row 2a created; reading it
-- would print "Guest" at every door.

create or replace function check_in_ticket(
  p_event_id      uuid,
  p_code          text,
  p_checked_in_by uuid
)
returns table (
  outcome        text,
  attendee_name  text,
  checked_in_at  timestamptz,
  reference      text,
  tickets_total  integer,
  tickets_in     integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  t tickets%rowtype;
  b bookings%rowtype;
begin
  -- FOR UPDATE OF t: the second of two simultaneous scans blocks here until
  -- the first commits, then reads the committed checked_in_at and reports
  -- 'already_checked_in'. The database decides the race, not timing.
  select tk.* into t
    from tickets tk
    join bookings bk on bk.id = tk.booking_id
   where tk.code = p_code
     and bk.event_id = p_event_id
     for update of tk;

  if not found then
    raise exception 'no ticket with this code on event %', p_event_id
      using errcode = 'EH020';
  end if;

  select * into b from bookings where id = t.booking_id;

  -- Believed unreachable today: tickets only exist for confirmed bookings and
  -- cancel_booking deletes the un-scanned ones. It is one predicate, and it is
  -- the safety net under Phase 3's paid states and Phase 5's approval states,
  -- both of which will create ticket-bearing bookings that are not confirmed.
  if b.status <> 'confirmed' then
    raise exception 'booking % is %, not confirmed', b.id, b.status
      using errcode = 'EH021';
  end if;

  if t.checked_in_at is null then
    update tickets
       set checked_in_at = now(), checked_in_by = p_checked_in_by
     where id = t.id;
    outcome := 'checked_in';
  else
    outcome := 'already_checked_in';
  end if;

  return query
    select outcome,
           b.attendee_name,
           tk.checked_in_at,
           b.reference,
           (select count(*)::integer from tickets x where x.booking_id = b.id),
           (select count(*)::integer from tickets x
             where x.booking_id = b.id and x.checked_in_at is not null)
      from tickets tk
     where tk.id = t.id;
end;
$$;

-- The guest-list tap: admit the next person on a booking without asking which.
-- Tickets on a free booking are interchangeable (no per-ticket names yet), so
-- "next unchecked, oldest first" is the whole selection rule. FOR UPDATE SKIP
-- LOCKED means two racing taps pick two DIFFERENT tickets rather than fighting
-- over one; the corner where the race empties the pool -- one unchecked ticket,
-- two taps, the loser sees nothing unlocked -- lands on EH022, which is morally
-- right from the loser's side of the desk.

create or replace function check_in_next_ticket(
  p_event_id      uuid,
  p_booking_id    uuid,
  p_checked_in_by uuid
)
returns table (
  outcome        text,
  attendee_name  text,
  checked_in_at  timestamptz,
  reference      text,
  tickets_total  integer,
  tickets_in     integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  t tickets%rowtype;
  b bookings%rowtype;
begin
  select bk.* into b
    from bookings bk
   where bk.id = p_booking_id
     and bk.event_id = p_event_id;

  if not found then
    raise exception 'no booking % on event %', p_booking_id, p_event_id
      using errcode = 'EH020';
  end if;

  if b.status <> 'confirmed' then
    raise exception 'booking % is %, not confirmed', b.id, b.status
      using errcode = 'EH021';
  end if;

  select tk.* into t
    from tickets tk
   where tk.booking_id = b.id
     and tk.checked_in_at is null
   order by tk.created_at, tk.id
   limit 1
   for update skip locked;

  if not found then
    raise exception 'every ticket on booking % is already checked in', b.id
      using errcode = 'EH022';
  end if;

  update tickets
     set checked_in_at = now(), checked_in_by = p_checked_in_by
   where id = t.id;

  outcome := 'checked_in';

  return query
    select outcome,
           b.attendee_name,
           tk.checked_in_at,
           b.reference,
           (select count(*)::integer from tickets x where x.booking_id = b.id),
           (select count(*)::integer from tickets x
             where x.booking_id = b.id and x.checked_in_at is not null)
      from tickets tk
     where tk.id = t.id;
end;
$$;

-- Revoking from public also strips service_role -- neither a superuser nor a
-- member of authenticated -- so the grant back is required, not decorative.
revoke execute on function check_in_ticket(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function check_in_ticket(uuid, text, uuid)
  to service_role;

revoke execute on function check_in_next_ticket(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function check_in_next_ticket(uuid, uuid, uuid)
  to service_role;
