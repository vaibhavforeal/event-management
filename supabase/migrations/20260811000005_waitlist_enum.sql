-- Phase 5b: the waitlist status, alone in its own migration.
--
-- Postgres will not let a transaction add an enum value and then use it, and
-- `supabase migration up` runs each file in exactly one transaction. So the
-- value lands here and everything that reads or writes it lands in
-- 20260811000006. Merging the two files fails at apply time with
-- "unsafe use of new value 'waitlisted' of enum type booking_status", which is
-- a confusing error to meet for the first time on someone else's machine.
--
-- Positioned after 'pending_approval' because the two are siblings: both are a
-- booking that exists, holds no seat, and is waiting on somebody else's move.
-- Enum order is cosmetic here -- nothing in this repo sorts by booking_status
-- -- but psql \dT and every future reader see the lifecycle in order.

alter type booking_status add value if not exists 'waitlisted' after 'pending_approval';
