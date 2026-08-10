-- At most one refund per payment is Phase 3's invariant (full or none, no
-- partials) -- see docs/specs/2026-08-10-phase-3-payments-design.md. The
-- application's read-then-insert in ensureRefund cannot hold that promise
-- under concurrent webhook redeliveries; this index is what actually holds
-- it. The day partial refunds arrive, relaxing this is a migration on one
-- index -- the bookings_one_active_per_attendee posture.
create unique index refunds_one_per_payment on refunds (payment_id);
