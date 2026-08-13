-- Settlement hardening: the guards Phase 6a's reviews named and 6b ruled on.
--
-- Error codes in this file:
--   EH077  only a published event settles
--
-- Four changes, all on objects from 20260808000001 / 20260812000003:
--
--  1. payouts_forfeit_within_gross — the missing sibling of
--     payouts_net_is_consistent. settle() cannot produce a statement whose
--     forfeit exceeds its gross (forfeits are a subset of counted gross),
--     but record_payout accepts the two numbers independently, so a
--     hand-crafted admin call could record one. Now the table refuses.
--
--  2. payouts_freeze_when_paid grows the pointer columns. The freeze
--     guarded the money and not the pointers: host_id and event_id stayed
--     mutable on a paid row, so a settled payout could be re-pointed at a
--     different host or event while its amounts stayed "frozen". Now the
--     row's identity freezes with its money. notes stays editable — it is
--     the out-of-band correction channel EH070's hint points at.
--
--  3. record_payout refuses events that are not published (EH077, between
--     the EH072 existence check and the EH073 ended check). The 6b ruling:
--     a cancelled or unpublished event settles by refunding its attendees,
--     not by a payout — settle()'s forfeit rule would otherwise pay a host
--     forfeits for an event they cancelled themselves. Revisit when a real
--     event-cancellation flow (with its refund sweep) exists.
--
--  4. The DELETE posture on payouts, stated instead of implied. No browser
--     role has ever held DELETE; the revoke below makes that a fact of the
--     schema rather than an accident of omission. Service-role deletes
--     remain possible BY DESIGN: the four fenced modules never delete a
--     payout, and test cleanup legitimately deletes paid fixtures. A
--     delete-blocking trigger was considered and rejected — the freeze
--     trigger already prevents un-paying a row, so cleanup could never get
--     past it, and the pilot's audit trail is the bank statement.

alter table payouts
  add constraint payouts_forfeit_within_gross
    check (forfeited_paise <= gross_paise);

revoke delete on payouts from public, anon, authenticated;

-- The freeze, now covering identity as well as money. Fires for the service
-- role too — same as before.
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
    or new.host_id          is distinct from old.host_id
    or new.event_id         is distinct from old.event_id
  ) then
    raise exception 'this payout is settled; its amounts are what left the bank'
      using errcode = 'EH070',
            hint = 'Record the correction in notes and settle the difference out of band.';
  end if;
  return new;
end;
$$;

-- record_payout, redefined wholesale (house style) to add the EH077 status
-- gate. Everything else is unchanged from 20260812000003.
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

  if ev.status <> 'published' then
    raise exception 'only a published event settles' using errcode = 'EH077';
  end if;

  if coalesce(ev.ends_at, ev.starts_at) >= now() then
    raise exception 'this event has not ended yet' using errcode = 'EH073';
  end if;

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
    paid_at          = coalesce(payouts.paid_at, excluded.paid_at)
  returning * into result;

  return result;
end;
$$;

-- create or replace preserves existing grants, but state them anyway — every
-- migration that touches this function says who may call it.
revoke execute on function record_payout(uuid, bigint, bigint, bigint, payout_status, text, text)
  from public, anon;
grant execute on function record_payout(uuid, bigint, bigint, bigint, payout_status, text, text)
  to authenticated, service_role;
