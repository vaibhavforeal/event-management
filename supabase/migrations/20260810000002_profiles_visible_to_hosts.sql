-- A host may read the profile of someone booked on their own event.
--
-- profiles_select_own (20260808000003:61) is `id = auth.uid()` and was the
-- entire SELECT surface on this table, which is correct for a stranger and
-- wrong for the person whose supper club you are turning up to. A host has to
-- be able to reach their guests -- WhatsApp is the only channel this product
-- has -- and until this policy the phone number simply was not readable, with
-- an embed returning null rather than erroring.
--
-- Scoped through owns_event(), the same helper bookings_select_for_host uses
-- (20260808000003:125), so "my event" means one thing across the schema. It is
-- SECURITY DEFINER precisely so evaluating a policy here does not re-enter the
-- policies on events and hosts and recurse.
--
-- Deliberately not narrowed to confirmed bookings. A host who needs to tell
-- someone the venue moved needs them whether or not that person has since
-- cancelled, and the guest list narrows to confirmed in the query instead.
--
-- What this exposes: the whole profiles row -- id, phone, full_name,
-- avatar_url, city, created_at -- because RLS filters rows and not columns. If
-- a sensitive column is ever added to profiles, it needs a column-level grant
-- the way hosts.upi_id has one (20260808000003:214), and this policy is the
-- reason that will matter.

create policy profiles_select_for_host on profiles
  for select using (
    exists (
      select 1
        from bookings b
       where b.attendee_id = profiles.id
         and owns_event(b.event_id)
    )
  );
