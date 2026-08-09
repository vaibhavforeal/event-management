-- Who is coming, and how many times they may say so.
--
-- attendee_name: a host needs to know who is at the door, and cannot find out
-- any other way. profiles_select_own (20260808000003:61) is the entire SELECT
-- surface on profiles -- `id = auth.uid()`, own row only -- so an embed of
-- bookings.profiles(...) returns null for every attendee without erroring, and
-- a guest list built on one silently lists nobody. profiles.full_name is null
-- for every user in any case: handle_new_user() writes id and phone and nothing
-- else, and nothing in this repo has ever written full_name.
--
-- So the attendee types a name when booking and it lands here. The host sees
-- what the guest chose to be called; nobody's phone number moves. Nullable
-- because request_booking (Phase 5) and the payment path (Phase 3) do not
-- collect it.

alter table bookings add column attendee_name text;

-- One active booking per attendee per event.
--
-- max_per_order bounds a single order, not a person, so ten single-seat
-- bookings take a ten-seat supper club and every one of them is individually
-- within the rules. This is the rule that says otherwise.
--
-- A unique index rather than a check inside book_free_tickets, because the
-- check would race with itself: two concurrent requests both read "no existing
-- booking" and both insert. The index is decided by Postgres at write time and
-- cannot be lost that way. The function still pre-checks, so the common case
-- gets a sentence instead of a constraint name; this is the backstop.
--
-- Partial on the active statuses only. cancel_booking sets 'cancelled' and
-- release_expired_holds sets 'expired', both outside the predicate, so
-- cancelling frees the attendee to book again -- which is the difference
-- between this rule and "one booking ever".
create unique index bookings_one_active_per_attendee
  on bookings (event_id, attendee_id)
  where status in ('pending_approval', 'awaiting_payment', 'confirmed');
