-- Narrow the ticket_types write grant from the whole table to a column list.
--
-- README and 20260808000002 both state that reserved_count is mutated only by
-- the inventory functions. Until this file that was not true. 20260808000003
-- granted `insert, update` on the entire table to `authenticated`, and RLS
-- filters rows, not columns -- so ticket_types_write_own let a host write
-- reserved_count to anything at all on a ticket type they own.
--
-- Zeroing it is a self-service oversell. Every seats-remaining number the
-- product shows is derived from that column, and the ticket_types_no_oversell
-- CHECK compares reserved_count to quantity, so it has nothing to say once the
-- counter itself is a lie. The row lock in reserve_tickets() serialises honest
-- buyers against each other and does nothing about a host rewriting the total
-- between them.
--
-- The columns granted below are exactly the ones the app writes. Since
-- 20260809000001 every write reaches this table through
-- create_event_with_ticket_type or update_event_with_ticket_type, and those are
-- SECURITY INVOKER: they run as the caller and are bound by this grant like any
-- other statement. That is what makes the list checkable against the code
-- rather than aspirational. The inventory functions in 20260808000002 are
-- SECURITY DEFINER and run as the function owner, so they keep their reach into
-- reserved_count -- which is the whole point of the split.
--
-- Adding a field to the host's ticket-type form means adding its column here.
-- That failure is loud -- the write is refused with 42501 -- rather than silent.

revoke insert, update on ticket_types from authenticated;

-- event_id on insert only: a ticket type is never re-parented to another event.
grant insert (event_id, name, price_paise, quantity) on ticket_types to authenticated;
grant update (name, price_paise, quantity) on ticket_types to authenticated;
