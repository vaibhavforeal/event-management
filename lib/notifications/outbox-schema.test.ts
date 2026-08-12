import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { adminClient } from '@/tests/helpers/db'

const db = adminClient()

/** Every dedupe key this file writes starts here, so the backstop can be scoped. */
const PREFIX = 'test:schema:'

/** Rows this file created, cleaned up even when an assertion fails. */
const created: string[] = []

afterEach(async () => {
  if (created.length > 0) {
    await db.from('message_log').delete().in('dedupe_key', created)
    created.length = 0
  }
})

// A backstop for anything a thrown assertion left behind. message_log is
// shared with the dev database, and once Task 5 lands a stray 'queued' row is
// not litter -- it is a WhatsApp message somebody eventually receives.
afterAll(async () => {
  await db.from('message_log').delete().like('dedupe_key', `${PREFIX}%`)
})

async function insert(row: Record<string, unknown>) {
  if (typeof row.dedupe_key === 'string') created.push(row.dedupe_key)
  return db.from('message_log').insert(row).select().single()
}

describe('message_log as an outbox', () => {
  it('defaults a new row to queued with no attempts and no variables', async () => {
    const { data, error } = await insert({
      dedupe_key: `${PREFIX}defaults`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'queued', attempts: 0 })
    // toEqual and not part of the toMatchObject above: toMatchObject treats a
    // nested {} as "any object", so a default of '{"x":1}'::jsonb would sail
    // through it.
    expect(data!.variables).toEqual({})
  })

  it('round-trips the template variables it was queued with', async () => {
    // The column the outbox cannot work without: a row says WHICH template,
    // and this says what to fill it with. Re-deriving at drain time would make
    // the queue a record rather than a queue.
    const variables = {
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
      eventDateTime: '19 Aug 2026, 7:00 pm',
      venue: 'The Terrace',
      bookingReference: 'VYRB4SHQ',
    }
    const { data, error } = await insert({
      dedupe_key: `${PREFIX}variables`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
      variables,
    })
    expect(error).toBeNull()
    expect(data!.variables).toEqual(variables)
  })

  it.each(['attempts', 'variables'])('refuses a null %s', async (column) => {
    const { error } = await insert({
      dedupe_key: `${PREFIX}null-${column}`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
      [column]: null,
    })
    // Both columns are read arithmetically or structurally by the drain:
    // a null attempts makes `attempts + 1` null forever, so the row is never
    // retried and never declared dead, and a null variables is a template with
    // nothing to fill it. A bare `default` without `not null` gives the right
    // answer for a row that omits the column and the wrong one for a row that
    // names it -- which is the shape every UPDATE the drain writes has.
    expect(error?.code, `${column} accepted a null`).toBe('23502')
  })

  it('refuses a status outside the vocabulary the drain branches on', async () => {
    const { error } = await insert({
      dedupe_key: `${PREFIX}bad-status`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
      status: 'delivered',
    })
    // Without the CHECK this insert succeeds and the row silently leaves
    // circulation -- never drained, never reported as failed.
    expect(error?.message).toContain('message_log_status_known')
  })

  it('holds that vocabulary against an UPDATE and not only an insert', async () => {
    const { data } = await insert({
      dedupe_key: `${PREFIX}bad-update`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })

    const { error } = await db
      .from('message_log')
      .update({ status: 'delivered' })
      .eq('id', data!.id)
    // The typo the constraint exists to catch is in an UPDATE, not an INSERT:
    // the drain inserts 'queued' from a default and then writes the other
    // three by hand. An insert-only guard -- a BEFORE INSERT trigger, say --
    // would pass the test above and miss every write that matters.
    expect(error?.message).toContain('message_log_status_known')
  })

  it('accepts each of the four the drain uses', async () => {
    for (const status of ['queued', 'sent', 'failed', 'dead']) {
      const { error } = await insert({
        dedupe_key: `${PREFIX}${status}`,
        recipient_phone: '+919876543210',
        template: 'booking_confirmed',
        status,
      })
      expect(error, `status ${status} should be allowed`).toBeNull()
    }
  })

  it('moves a row to the back of the queue when an attempt writes to it', async () => {
    const { data: queued } = await insert({
      dedupe_key: `${PREFIX}attempted`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })

    const { data: failed, error } = await db
      .from('message_log')
      .update({ status: 'failed', attempts: 1, error: 'Meta returned 503' })
      .eq('id', queued!.id)
      .select()
      .single()
    expect(error).toBeNull()
    expect(failed!.attempts).toBe(1)

    // message_log_pending_idx is ordered by updated_at so the drain takes the
    // longest-waiting row first. That ordering is only fair if a failed
    // attempt actually moves the row, which is the Phase 0 set_updated_at
    // trigger's job -- without it one hot failure sits at the front of the
    // partial index and starves everything queued behind it. Compared as
    // strings because both come back from PostgREST at microsecond precision,
    // which two round trips cannot collide on; Date would round them to the
    // same millisecond.
    expect(
      failed!.updated_at > queued!.updated_at,
      `updated_at did not move: ${queued!.updated_at} -> ${failed!.updated_at}`,
    ).toBe(true)
  })

  it('refuses a second row with the same dedupe key', async () => {
    const first = await insert({
      dedupe_key: `${PREFIX}dupe`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })
    expect(first.error).toBeNull()

    const { error } = await db.from('message_log').insert({
      dedupe_key: `${PREFIX}dupe`,
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })
    // This constraint is the entire idempotency story for the phase: it is
    // what makes re-running the sweep safe. It says nothing about the drain
    // re-attempting a row it already holds -- see the column comment the
    // migration rewrites.
    expect(error?.code).toBe('23505')
  })
})
