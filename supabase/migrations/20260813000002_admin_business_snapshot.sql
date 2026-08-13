-- The operator's numbers: one admin-gated aggregate over the platform.
--
-- Error codes in this file:
--   EH071  not a platform admin (reused from 20260812000003)
--
-- One function, no tables, no stored state — every number is derived on
-- read, like drift. The two settlement numbers (owed to hosts, settled to
-- date) are deliberately NOT here: TypeScript settle() is the only
-- interpreter of owed money, and the console sums those from the
-- statements it already computes.
--
-- Definitions come from docs/specs/2026-08-13-phase-6c-analytics-design.md:
--  * Money facts are platform-wide whatever the event's status — money
--    that moved, moved. GMV counts captured AND refunded payments (a
--    refunded payment was captured first; a capture never un-refunds).
--    Refunds count only status = 'processed' — pending money has not
--    returned yet.
--  * Fill is scoped to published events; check-ins to ENDED published
--    events (an ongoing event's unscanned tickets are not no-shows yet).
--    "Ended" is 6a's coalesce(ends_at, starts_at) < now(), mirroring
--    lib/events/datetime.ts hasEnded.
--  * The waitlist is a booking status, not a table.
--
-- p_event_ids scopes every aggregate to those events, joined through
-- bookings.event_id. It exists for the tests: the suite runs files in
-- parallel against one database, so platform-wide totals are moving
-- targets, but numbers scoped to a test's own events are exact.
-- Production always calls this with no argument.

create or replace function admin_business_snapshot(p_event_ids uuid[] default null)
returns table (
  gmv_paise               bigint,
  refunds_processed_paise bigint,
  commission_paise        bigint,
  cash_confirmed_paise    bigint,
  online_confirmed_paise  bigint,
  cash_confirmed_count    bigint,
  confirmed_count         bigint,
  events_live             bigint,
  events_ended            bigint,
  capacity_seats          bigint,
  confirmed_seats         bigint,
  tickets_issued          bigint,
  tickets_checked_in      bigint,
  waitlisted_count        bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- First statement, before anything is read.
  if not is_platform_admin() then
    raise exception 'not a platform admin' using errcode = 'EH071';
  end if;

  return query
  select
    coalesce((select sum(p.amount_paise)::bigint
       from payments p
       join bookings b on b.id = p.booking_id
      where p.status in ('captured', 'refunded')
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(r.amount_paise)::bigint
       from refunds r
       join payments p on p.id = r.payment_id
       join bookings b on b.id = p.booking_id
      where r.status = 'processed'
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(b.commission_paise)::bigint
       from bookings b
      where exists (select 1 from payments p
                     where p.booking_id = b.id
                       and p.status in ('captured', 'refunded'))
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(b.subtotal_paise)::bigint
       from bookings b
      where b.status = 'confirmed' and b.payment_mode = 'cash'
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    coalesce((select sum(b.subtotal_paise)::bigint
       from bookings b
      where b.status = 'confirmed' and b.payment_mode = 'online'
        and (p_event_ids is null or b.event_id = any (p_event_ids))), 0),
    (select count(*)
       from bookings b
      where b.status = 'confirmed' and b.payment_mode = 'cash'
        and (p_event_ids is null or b.event_id = any (p_event_ids))),
    (select count(*)
       from bookings b
      where b.status = 'confirmed'
        and (p_event_ids is null or b.event_id = any (p_event_ids))),
    (select count(*)
       from events e
      where e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) >= now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    (select count(*)
       from events e
      where e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) < now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    coalesce((select sum(tt.quantity)::bigint
       from ticket_types tt
       join events e on e.id = tt.event_id
      where e.status = 'published'
        and (p_event_ids is null or e.id = any (p_event_ids))), 0),
    coalesce((select sum(b.quantity)::bigint
       from bookings b
       join events e on e.id = b.event_id
      where b.status = 'confirmed' and e.status = 'published'
        and (p_event_ids is null or e.id = any (p_event_ids))), 0),
    (select count(*)
       from tickets t
       join bookings b on b.id = t.booking_id
       join events e on e.id = b.event_id
      where e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) < now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    (select count(*)
       from tickets t
       join bookings b on b.id = t.booking_id
       join events e on e.id = b.event_id
      where t.checked_in_at is not null
        and e.status = 'published'
        and coalesce(e.ends_at, e.starts_at) < now()
        and (p_event_ids is null or e.id = any (p_event_ids))),
    (select count(*)
       from bookings b
      where b.status = 'waitlisted'
        and (p_event_ids is null or b.event_id = any (p_event_ids)));
end;
$$;

revoke execute on function admin_business_snapshot(uuid[]) from public, anon;
grant execute on function admin_business_snapshot(uuid[]) to authenticated, service_role;
