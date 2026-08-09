-- Booking a free event, as one transaction.
--
-- A free booking is Phase 0's reserve_tickets followed immediately by
-- confirm_booking: there is no payment step to wait between them. Issued as two
-- RPCs those are two transactions, and a failure between them leaves a held
-- booking that only the sweeper cleans up. Nested plpgsql calls run inside the
-- caller's transaction, so joining them here makes the pair atomic without
-- touching either function -- and the 50-concurrent-booking test keeps guarding
-- exactly what it guards.
--
-- Same posture as the rest of 20260808000002: SECURITY DEFINER with EXECUTE
-- revoked from anon and authenticated, so it is unreachable over PostgREST.
-- It mutates reserved_count, and nothing a browser can call may do that. The
-- Server Action calls it as the service role, having authenticated the user
-- itself -- see lib/bookings/service.ts, which is the only place permitted to.
--
--   EH010  the ticket type is not free; payment is Phase 3
--   EH011  the event requires host approval; that flow is Phase 5
--   EH012  this attendee already has an active booking on this event
--   EH013  the event has already started
--
-- `extensions` on the search_path because confirm_booking needs pgcrypto's
-- gen_random_bytes for ticket codes, and it inherits this setting when called
-- from here.

create or replace function book_free_tickets(
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

  -- Both guards run before any inventory moves. The transaction would roll a
  -- reservation back anyway; refusing first means the failure never depended on
  -- that, and it keeps the reason legible in a log.
  --
  -- In SQL rather than only in the Server Action because these are the
  -- conditions under which issuing a *confirmed* ticket is correct at all. A
  -- caller that forgets them is asking for something that should not be
  -- possible, and the answer should not depend on which caller asked.
  if tt.price_paise <> 0 then
    raise exception 'this event is not free (price %)', tt.price_paise
      using errcode = 'EH010';
  end if;

  if ev.requires_approval then
    raise exception 'this event requires host approval before booking'
      using errcode = 'EH011';
  end if;

  -- reserve_tickets checks published status and the sales window, and a
  -- finished event passes both -- sales_start and sales_end are null on every
  -- event this product creates. Without this, last month's supper club is still
  -- bookable by anyone scrolling back through a WhatsApp group.
  if ev.starts_at <= now() then
    raise exception 'this event started at %', ev.starts_at
      using errcode = 'EH013';
  end if;

  -- The friendly half of the one-booking rule. bookings_one_active_per_attendee
  -- is the half that actually holds under concurrency; this exists so the
  -- ordinary case gets a sentence rather than an index name, and it is checked
  -- before inventory moves so the refusal costs nothing.
  if exists (
    select 1 from bookings b
     where b.event_id = ev.id
       and b.attendee_id = p_attendee_id
       and b.status in ('pending_approval', 'awaiting_payment', 'confirmed')
  ) then
    raise exception 'this attendee already has an active booking on event %', ev.id
      using errcode = 'EH012';
  end if;

  -- Everything else -- published status, sales window, max_per_order,
  -- availability under a row lock -- is already reserve_tickets' job, and its
  -- refusals are already sentences a person can read. They pass through.
  --
  -- Defaults left alone: zero fee, zero commission, payment_mode 'online', a
  -- ten-minute hold that confirm_booking clears microseconds later. A free
  -- booking therefore stores payment_mode 'online' with total_paise 0, which
  -- reads oddly and is correct: the column records how the attendee *would*
  -- pay, and 'cash' means something specific that Phase 5 introduces.
  booking := reserve_tickets(
    p_ticket_type_id => p_ticket_type_id,
    p_attendee_id    => p_attendee_id,
    p_quantity       => p_quantity,
    p_attendee_note  => p_attendee_note
  );

  -- reserve_tickets has no name parameter and should not grow one: it is the
  -- shared path for every booking kind, and only this one asks for a name.
  -- Written here instead, inside the same transaction.
  update bookings
     set attendee_name = nullif(btrim(p_attendee_name), '')
   where id = booking.id;

  return confirm_booking(booking.id);

exception
  -- The pre-check above loses the race sometimes; the index never does. Both
  -- must say the same thing to the attendee, or the same situation reads as a
  -- refusal one time and a database fault the next.
  --
  -- Not dead code, and no test reaches it: single-threaded, the pre-check
  -- always wins, so this branch only runs when two requests interleave.
  -- Verified by hand instead, with two concurrent sessions -- the second past
  -- its pre-check before the first committed, blocking on reserve_tickets' row
  -- lock on ticket_types, then tripping the index once the first committed. It
  -- came back EH012 from this handler (confirmed by the RAISE line number in
  -- the error CONTEXT, since both sites share message text). See the Task 1
  -- report for the transcript before deleting this as unreachable.
  when unique_violation then
    if sqlerrm like '%bookings_one_active_per_attendee%' then
      raise exception 'this attendee already has an active booking on event %', ev.id
        using errcode = 'EH012';
    end if;
    raise;
end;
$$;

-- EXECUTE on a new function is granted to PUBLIC by default. Revoking from
-- public also strips service_role, which is neither a superuser nor a member of
-- authenticated -- so the grant back is required, not decorative. anon is named
-- explicitly because a hosted project may carry default privileges that survive
-- a revoke from PUBLIC.
revoke execute on function book_free_tickets(uuid, uuid, integer, text, text)
  from public, anon, authenticated;

grant execute on function book_free_tickets(uuid, uuid, integer, text, text)
  to service_role;
