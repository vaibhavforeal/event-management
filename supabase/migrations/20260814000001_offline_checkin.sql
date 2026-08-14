-- Phase 7: offline check-in lands through the same door as online check-in.
--
-- check_in_ticket gains two DEFAULTED parameters, so every existing caller
-- (lib/checkin/service.ts checkInTicket, and the 2b test suites) is
-- byte-identical: p_scanned_at null means checked_in_at = now(), exactly the
-- old write, and p_offline false is the column's existing default.
--
-- The sync path (lib/checkin/service.ts syncOfflineCheckIns) passes both:
--   - p_scanned_at is the DEVICE clock at the door, clamped to
--     (now() - 24h, now()] — a wrong clock can neither post-date reality nor
--     drag a check-in more than a day into the past.
--   - p_offline = true finally writes checked_in_offline, reserved since
--     20260808000001.
--
-- The conflict branch is deliberately untouched: FIRST write wins (the spec
-- amends the v1 doc's "last-write-wins" phrasing), the original checked_in_at
-- comes back, and checked_in_offline is not rewritten by a losing replay.
--
-- Adding parameters changes the signature, so drop + recreate, restating the
-- 2b posture verbatim: SECURITY DEFINER, search_path pinned, EXECUTE revoked
-- from public/anon/authenticated and granted back to service_role.

drop function if exists check_in_ticket(uuid, text, uuid);

create function check_in_ticket(
  p_event_id      uuid,
  p_code          text,
  p_checked_in_by uuid,
  p_scanned_at    timestamptz default null,
  p_offline       boolean default false
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
       set checked_in_at = least(now(), greatest(coalesce(p_scanned_at, now()),
                                                 now() - interval '24 hours')),
           checked_in_by = p_checked_in_by,
           checked_in_offline = p_offline
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

-- Revoking from public also strips service_role -- neither a superuser nor a
-- member of authenticated -- so the grant back is required, not decorative.
revoke execute on function check_in_ticket(uuid, text, uuid, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function check_in_ticket(uuid, text, uuid, timestamptz, boolean)
  to service_role;
