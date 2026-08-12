-- The payout writer.
--
-- payouts has existed since Phase 0 and nothing has ever written to it. This
-- migration gives it its one writer, its memo column, and the rule that a
-- settled row is history.
--
--   EH070  a settled payout is immutable
--   EH071  not a platform admin
--   EH072  no such event
--   EH073  the event has not ended
--   EH074  a payout is recorded as paid or on_hold
--   EH075  a paid payout needs its UTR

-- A SUBSET of gross_paise, not an addend — seats cancelled past the refund
-- cutoff, whose money stayed with us and belongs to the host. Held separately
-- so a statement can explain its own number. payouts_net_is_consistent
-- therefore keeps meaning exactly what it always meant.
alter table payouts
  add column forfeited_paise bigint not null default 0
    check (forfeited_paise >= 0);

-- ---------------------------------------------------------------------------
-- The freeze
-- ---------------------------------------------------------------------------
-- Once a payout says 'paid', its amounts record what actually left a bank
-- account. Recomputation may disagree — a refund can land afterwards — and the
-- console shows that drift, but nothing silently rewrites a number somebody
-- already acted on. notes stays editable precisely so an out-of-band
-- correction has somewhere to go.
--
-- A trigger rather than a check in the service, because the service is not the
-- only writer: this fires against the service role and against psql too.

create or replace function payouts_freeze_when_paid()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'paid' and (
       new.gross_paise      is distinct from old.gross_paise
    or new.commission_paise is distinct from old.commission_paise
    or new.net_paise        is distinct from old.net_paise
    or new.forfeited_paise  is distinct from old.forfeited_paise
    or new.utr_reference    is distinct from old.utr_reference
    or new.paid_at          is distinct from old.paid_at
    or new.status           is distinct from old.status
  ) then
    raise exception 'this payout is settled; its amounts are what left the bank'
      using errcode = 'EH070',
            hint = 'Record the correction in notes and settle the difference out of band.';
  end if;
  return new;
end;
$$;

create trigger payouts_frozen_when_paid
  before update on payouts
  for each row execute function payouts_freeze_when_paid();

-- ---------------------------------------------------------------------------
-- record_payout — the only writer
-- ---------------------------------------------------------------------------

create or replace function record_payout(
  p_event_id         uuid,
  p_gross_paise      bigint,
  p_commission_paise bigint,
  p_forfeited_paise  bigint,
  p_status           payout_status,
  p_utr_reference    text default null,
  p_notes            text default null
)
returns payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  ev     events;
  result payouts;
begin
  -- First statement, before anything is read.
  if not is_platform_admin() then
    raise exception 'not a platform admin' using errcode = 'EH071';
  end if;

  select * into ev from events where id = p_event_id;
  if not found then
    raise exception 'no such event' using errcode = 'EH072';
  end if;

  -- ends_at is nullable, so fall back to starts_at: without this an event that
  -- never stated an end time could never be settled, and nothing would say so.
  if coalesce(ev.ends_at, ev.starts_at) >= now() then
    raise exception 'this event has not ended yet' using errcode = 'EH073';
  end if;

  -- 'pending' is a schema default the console never writes: manual settlement
  -- reads a number, sends UPI, then records it, so no row exists before money
  -- has moved.
  if p_status not in ('paid', 'on_hold') then
    raise exception 'a payout is recorded as paid or on_hold' using errcode = 'EH074';
  end if;

  if p_status = 'paid' and coalesce(btrim(p_utr_reference), '') = '' then
    raise exception 'a settled payout needs its bank reference' using errcode = 'EH075';
  end if;

  insert into payouts (
    host_id, event_id, gross_paise, commission_paise, net_paise,
    forfeited_paise, status, utr_reference, notes, paid_at
  ) values (
    ev.host_id, p_event_id, p_gross_paise, p_commission_paise,
    p_gross_paise - p_commission_paise, p_forfeited_paise, p_status,
    p_utr_reference, p_notes,
    case when p_status = 'paid' then now() else null end
  )
  on conflict (event_id) do update set
    gross_paise      = excluded.gross_paise,
    commission_paise = excluded.commission_paise,
    net_paise        = excluded.net_paise,
    forfeited_paise  = excluded.forfeited_paise,
    status           = excluded.status,
    utr_reference    = excluded.utr_reference,
    notes            = excluded.notes,
    -- Keep the ORIGINAL settlement instant. A fresh now() here would differ
    -- from the frozen row on every re-record, so the trigger would refuse even
    -- a note-only edit — and the stored time would stop being when the money
    -- actually moved.
    paid_at          = coalesce(payouts.paid_at, excluded.paid_at)
  returning * into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_host_payout_target — the way past a column grant
-- ---------------------------------------------------------------------------
-- upi_id and bank_account_ref are withheld from authenticated by the column
-- grant in 20260808000003_rls_policies.sql, not by a policy — and RLS filters
-- rows, not columns, so no policy can widen it. Widening the grant instead
-- would expose every host's bank details to every signed-in visitor, because
-- hosts is world-readable so event pages can name their host. SECURITY DEFINER
-- is the only remaining route that does not put a fifth file inside the
-- service-role fence.

create or replace function admin_host_payout_target(p_host_id uuid)
returns table (upi_id text, bank_account_ref text, kyc_status host_kyc_status)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'not a platform admin' using errcode = 'EH071';
  end if;

  return query
    select h.upi_id, h.bank_account_ref, h.kyc_status
      from hosts h
     where h.id = p_host_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- host_settlement_rows — the same math, without the instrument details
-- ---------------------------------------------------------------------------
-- A host may read their own bookings but NOT payments: rls_policies.sql says
-- "A host has no business seeing payment instrument details. They get
-- aggregate money through payouts instead." The statement page still has to
-- run the same settle() the console does, so this returns exactly the two
-- booleans it needs — no payment row, no provider id, no method, no amount.
-- One implementation of the money math, reached two ways; two implementations
-- would eventually disagree about somebody's payment.
--
-- Scoped by owns_event(), the helper that already exists.

create or replace function host_settlement_rows(p_event_id uuid)
returns table (
  id                   uuid,
  status               booking_status,
  payment_mode         payment_mode,
  subtotal_paise       bigint,
  commission_paise     bigint,
  has_captured_payment boolean,
  has_refund           boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not owns_event(p_event_id) and not is_platform_admin() then
    raise exception 'not your event' using errcode = 'EH076';
  end if;

  return query
    select
      b.id,
      b.status,
      b.payment_mode,
      b.subtotal_paise,
      b.commission_paise,
      exists (
        select 1 from payments p
         where p.booking_id = b.id and p.status = 'captured'
      ),
      exists (
        select 1
          from payments p
          join refunds r on r.payment_id = p.id
         where p.booking_id = b.id and p.status = 'captured'
      )
      from bookings b
     where b.event_id = p_event_id;
end;
$$;

-- Explicit, because a hosted project may carry default privileges that survive
-- a revoke from PUBLIC. All three are callable by a signed-in user; each
-- refuses an unauthorised caller as its first act.
revoke execute on function record_payout(uuid, bigint, bigint, bigint, payout_status, text, text)
  from public, anon;
revoke execute on function admin_host_payout_target(uuid) from public, anon;
revoke execute on function host_settlement_rows(uuid) from public, anon;

grant execute on function record_payout(uuid, bigint, bigint, bigint, payout_status, text, text)
  to authenticated, service_role;
grant execute on function admin_host_payout_target(uuid) to authenticated, service_role;
grant execute on function host_settlement_rows(uuid) to authenticated, service_role;
