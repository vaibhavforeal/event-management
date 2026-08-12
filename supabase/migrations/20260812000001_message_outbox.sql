-- Phase 4: message_log stops being a table nobody writes and becomes the
-- outbox.
--
-- Phase 0 created it with the right shape and then never wrote a row: a
-- unique dedupe_key, a status defaulting to 'queued', an error column and a
-- booking_id. What it lacks is the two things a queue needs to be drained
-- safely -- a count of how many times we have tried, and an index that finds
-- the rows still owing work without scanning the rest.

-- ---------------------------------------------------------------------------
-- attempts
-- ---------------------------------------------------------------------------
-- Without this a permanently-failing message retries until the end of time,
-- once per cron tick, forever. Five rather than three because the drain's
-- interval is hours and not seconds: a transient Meta outage should not
-- exhaust the budget before anybody could notice it. The cap lives in
-- TypeScript (lib/notifications/service.ts) rather than here, because it is a
-- policy about how hard to try, not a fact about the data.

alter table message_log add column attempts integer not null default 0;

-- ---------------------------------------------------------------------------
-- variables
-- ---------------------------------------------------------------------------
-- Without this the outbox cannot work at all. A row records WHICH template to
-- send but not what to fill it with, so a message queued on one tick could not
-- be sent on the next -- the drain would have to re-derive the values from
-- state, which makes the queue a record rather than a queue.
--
-- Stored at enqueue time, deliberately: the message was decided then, and it
-- should say what it said then. A booking that changes shape between the
-- decision and the send does not retroactively rewrite the sentence somebody
-- was owed. It also makes message_log an audit record worth reading -- "what
-- exactly did we tell this person" becomes a query.
--
-- jsonb rather than text: it is read back as an object and handed straight to
-- the provider, and jsonb refuses malformed input at write time.

alter table message_log add column variables jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- The status vocabulary
-- ---------------------------------------------------------------------------
-- status has been free text defaulting to 'queued' since Phase 0. The drain
-- uses exactly four values and branches on them, so a typo in an UPDATE would
-- silently take a row out of circulation without ever reporting a failure.
--
-- A CHECK rather than an enum, deliberately: adding a fifth state later is one
-- migration that rewrites the constraint, where an enum needs the two-file
-- dance Phase 5b had to do for booking_status (Postgres cannot add an enum
-- value and use it in the same transaction).
--
-- The table has never been written to, so this cannot fail on existing rows.

alter table message_log add constraint message_log_status_known
  check (status in ('queued', 'sent', 'failed', 'dead'));

-- ---------------------------------------------------------------------------
-- The drain's index
-- ---------------------------------------------------------------------------
-- Partial on the two statuses that still owe work, so it stays small however
-- many messages have been sent -- the same reasoning as bookings_expiring_idx
-- in the core schema. Ordered by updated_at so the drain takes the longest-
-- waiting first and one hot failure cannot starve the queue behind it: the
-- message_log_set_updated_at trigger moves a row to the back of the queue
-- every time an attempt writes to it.

create index message_log_pending_idx
  on message_log (status, updated_at)
  where status in ('queued', 'failed');

-- ---------------------------------------------------------------------------
-- What dedupe_key actually promises
-- ---------------------------------------------------------------------------
-- The core schema says of this column: "Unique, so a retried job cannot
-- message the same person twice." That is false in the way that matters, and
-- this is the first thing an outbox implementer reads. The constraint is
-- unique per ROW, so it refuses a second ENQUEUE of a decision already
-- recorded -- and it has nothing to say about the drain re-attempting the row
-- it already has, which is precisely what the attempts column above exists to
-- bound. Believing the old sentence is how you end up building a retry loop
-- that thinks the database is protecting it.
--
-- The same claim was deleted from lib/notifications/providers/meta.ts in Task
-- 1 for the same reason: a send whose outcome could not be read is retried,
-- and may deliver twice.
--
-- Corrected here rather than in 20260808000001, which is applied -- editing an
-- applied file changes nothing on a database that has already run it.

comment on column message_log.dedupe_key is
  'Caller-supplied natural key, e.g. booking:<id>:ticket. Unique per row, so '
  'the same decision cannot be enqueued twice. It makes the decision '
  'idempotent, not the delivery: nothing here stops the drain re-attempting a '
  'row it has already tried, which is what attempts bounds.';
