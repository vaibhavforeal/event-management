import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { __setNotificationProvider } from '@/lib/notifications'
import { renderTemplate } from '@/lib/notifications/templates'
import type { NotificationProvider, OutboundMessage, SendResult } from '@/lib/notifications/types'
import { drainOutbox, enqueueOwedMessages, MAX_ATTEMPTS } from '@/lib/notifications/service'

const db = adminClient()

/** A provider a test can steer. */
class FakeProvider implements NotificationProvider {
  readonly name = 'fake'
  readonly sent: OutboundMessage[] = []
  result: SendResult = { status: 'sent', providerMessageId: 'fake-1' }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message)
    return this.result
  }
}

let provider: FakeProvider
let seed: SeededEvent
let attendeePhone = ''
let hostPhone = ''
/** Attendees minted inside a test, deleted only once their bookings are gone. */
const extraUsers: string[] = []

/**
 * The window teardown deletes message_log rows in.
 *
 * enqueueOwedMessages is a GLOBAL sweep — it is not given an event, and it
 * cannot be — so a stray booking left behind by a crashed run of some other
 * file gets a row written for it too. Scoping teardown to this event's
 * bookings would leave that row queued, and per the outbox migration a stray
 * queued row is not litter, it is a WhatsApp message somebody eventually
 * receives. So teardown is scoped by time instead: rows created since this
 * file started. vitest runs files serially (fileParallelism: false) and
 * nothing else writes message_log while it does.
 *
 * Backdated five minutes because the two clocks are different — Node's here,
 * Postgres's in the container — and a container clock a few seconds behind
 * would put our own rows outside a tight window and leave them queued.
 */
const CREATED_SINCE = new Date(Date.now() - 5 * 60_000).toISOString()

let phoneCounter = 0

/**
 * A number the sweep can actually dial, in the shape the database really holds.
 *
 * createTestUser mints `+1555…`, and GoTrue stores a phone with the '+'
 * stripped, so profiles.phone reads `1555…` — thirteen digits normalisePhone
 * refuses, which makes the sweep skip the row and every assertion here
 * vacuous. Twelve digits starting `91` is what GoTrue stores for a real Indian
 * number, and it is the input normalisePhone has to add the '+' to — so the
 * '+91' assertions below are evidence of normalisation rather than of a
 * fixture written already normalised.
 */
function indianPhone(): string {
  phoneCounter += 1
  return `919${String(Date.now() % 100_000_000).padStart(8, '0')}${phoneCounter % 10}`
}

async function setPhone(profileId: string, phone: string): Promise<void> {
  const { error } = await db.from('profiles').update({ phone }).eq('id', profileId)
  if (error) throw new Error(`could not set a dialable phone: ${error.message}`)
}

async function newAttendee(): Promise<string> {
  const id = await createTestUser(db)
  extraUsers.push(id)
  await setPhone(id, indianPhone())
  return id
}

/**
 * Back to an empty event between tests.
 *
 * Bookings are deleted rather than cancelled, which does not return inventory
 * — reserved_count is only ever moved by reserve_tickets/release_tickets — so
 * it is put back by hand. Without that the fifth booking in this file is
 * refused for a sold-out event. Messages go first: message_log.booking_id is
 * ON DELETE SET NULL, so deleting bookings first would orphan the rows rather
 * than remove them.
 */
async function clearOutboxAndBookings(): Promise<void> {
  if (!seed) return
  await db.from('message_log').delete().gte('created_at', CREATED_SINCE)
  await db.from('bookings').delete().eq('event_id', seed.eventId)
  await db.from('ticket_types').update({ reserved_count: 0 }).eq('id', seed.ticketTypeId)
}

beforeAll(async () => {
  seed = await seedEvent(db, { quantity: 5, pricePaise: 50_000 })
  attendeePhone = indianPhone()
  hostPhone = indianPhone()
  await setPhone(seed.attendeeId, attendeePhone)
  await setPhone(seed.hostProfileId, hostPhone)
})

beforeEach(() => {
  provider = new FakeProvider()
  __setNotificationProvider(provider)
})

afterEach(async () => {
  await clearOutboxAndBookings()
})

afterAll(async () => {
  if (!seed) return
  await clearOutboxAndBookings()
  // After the bookings, never before: bookings.attendee_id is ON DELETE
  // RESTRICT, so deleting an attendee who still holds one fails silently
  // through the catch and leaves an orphan user in a shared dev database.
  for (const id of extraUsers) await db.auth.admin.deleteUser(id).catch(() => {})
  extraUsers.length = 0
  await cleanupEvent(db, seed)
  __setNotificationProvider(undefined)
})

/** A confirmed booking on the seeded event. */
async function confirmedBooking(attendeeId: string, name = 'Asha'): Promise<string> {
  const { data, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: attendeeId,
    p_quantity: 1,
    p_attendee_name: name,
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)
  await db.rpc('confirm_booking', { p_booking_id: data!.id })
  return data!.id
}

async function messageRow(dedupeKey: string) {
  const { data } = await db.from('message_log').select('*').eq('dedupe_key', dedupeKey).single()
  return data
}

async function messageCount(bookingId: string): Promise<number | null> {
  const { count } = await db
    .from('message_log')
    .select('*', { count: 'exact', head: true })
    .eq('booking_id', bookingId)
  return count
}

describe('enqueueOwedMessages', () => {
  it('writes a queued row carrying the template and the variables that render it', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const { data: booking } = await db.from('bookings').select('reference').eq('id', bookingId).single()

    const result = await enqueueOwedMessages()
    expect(result.enqueued).toBeGreaterThanOrEqual(1)
    expect(result.scanned).toBeGreaterThanOrEqual(1)

    const row = await messageRow(`booking:${bookingId}:confirmed`)

    expect(row).toMatchObject({
      status: 'queued',
      attempts: 0,
      template: 'booking_confirmed',
      booking_id: bookingId,
    })
    // The attendee's number, normalised. profiles.phone holds digits with no
    // '+', so the leading '+' can only have come from normalisePhone, and the
    // exact value separates the two profiles the reader joins through — a
    // /^\+91/ pattern would pass just as happily on the host's.
    expect(hostPhone).not.toBe(attendeePhone)
    expect(row!.recipient_phone).toBe(`+${attendeePhone}`)

    const variables = row!.variables as Record<string, string>
    expect(variables.attendeeName).toBe('Asha')
    expect(variables.bookingReference).toBe(booking!.reference)
    expect(variables.eventTitle).toBe('Test Supper Club')
    // Not a spot check on two keys: a row missing any placeholder is a row the
    // drain can never send, and renderTemplate is the thing that says so.
    expect(() => renderTemplate('booking_confirmed', variables)).not.toThrow()

    // Enqueue does NOT send. That is the drain's job, and conflating them is
    // what would put a Meta call back on a user-facing path.
    expect(provider.sent).toHaveLength(0)
  })

  it('is idempotent — running it twice records the decision once', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)

    const first = await enqueueOwedMessages()
    const second = await enqueueOwedMessages()

    expect(first.enqueued).toBeGreaterThanOrEqual(1)
    expect(second.enqueued).toBe(0)

    // Counted by booking rather than by dedupe key: dedupe_key is UNIQUE, so
    // counting by it can never return 2 and would pass against an
    // implementation that minted a fresh key every tick.
    expect(await messageCount(bookingId)).toBe(1)
  })

  it('ignores a booking made before the launch cutoff, and only that one', async () => {
    const backdatedAttendee = await newAttendee()
    const backdated = await confirmedBooking(backdatedAttendee, 'Older')
    await db
      .from('bookings')
      .update({ created_at: new Date('2000-01-01T00:00:00Z').toISOString() })
      .eq('id', backdated)

    // The control row. Without it a reader that returns nothing at all — a
    // broken join, a status list with a typo in it — passes this test for
    // exactly the wrong reason.
    const current = await confirmedBooking(seed.attendeeId)

    await enqueueOwedMessages()

    expect(await messageCount(backdated)).toBe(0)
    expect(await messageCount(current)).toBe(1)
  })

  it('reads past an event that has already started instead of dying on it', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const { data: event } = await db.from('events').select('starts_at').eq('id', seed.eventId).single()
    await db
      .from('events')
      .update({ starts_at: new Date(Date.now() - 3_600_000).toISOString() })
      .eq('id', seed.eventId)

    try {
      // Two claims in one, and the first is the reason this test exists.
      // events!inner is what makes the starts_at filter drop the BOOKING; a
      // plain embed filters nothing, nulls the embedded event and keeps the
      // row, and the mapper then throws reading .title off null — which takes
      // the whole batch with it. Total silence is the worst failure this
      // system has, so "did not throw" is the assertion, not a formality.
      await expect(enqueueOwedMessages()).resolves.toBeDefined()
      // And the second: a reminder for a supper club that started an hour ago
      // is worse than saying nothing.
      expect(await messageCount(bookingId)).toBe(0)
    } finally {
      await db.from('events').update({ starts_at: event!.starts_at }).eq('id', seed.eventId)
    }
  })

  it('addresses the one host-facing message to the host', async () => {
    await db.from('events').update({ requires_approval: true }).eq('id', seed.eventId)
    try {
      const { data: booking, error } = await db.rpc('request_booking', {
        p_ticket_type_id: seed.ticketTypeId,
        p_attendee_id: seed.attendeeId,
        p_quantity: 1,
        p_attendee_name: 'Asha',
      })
      if (error) throw new Error(`setup request failed: ${error.message}`)

      await enqueueOwedMessages()

      const row = await messageRow(`booking:${booking!.id}:requested`)
      expect(row!.template).toBe('approval_requested')
      // The whole reason the reader joins events -> hosts -> profiles a second
      // time. Every other assertion in this file would still pass if
      // host_phone were mapped from the attendee's profile.
      expect(row!.recipient_phone).toBe(`+${hostPhone}`)
      const variables = row!.variables as Record<string, string>
      expect(variables.hostName).toBe('Test Host')
      expect(variables.attendeeName).toBe('Asha')
    } finally {
      await db.from('events').update({ requires_approval: false }).eq('id', seed.eventId)
    }
  })
})

describe('drainOutbox', () => {
  it('sends the values the row was queued with and marks it sent', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const key = `booking:${bookingId}:confirmed`
    await enqueueOwedMessages()

    // The booking changes shape between the decision and the send. What goes
    // out must still be the sentence that was decided — which is the whole
    // reason the variables column exists. Asserting 'Asha' against an
    // unchanged booking would pass for a drain that re-derived from state too.
    await db.from('bookings').update({ attendee_name: 'Renamed' }).eq('id', bookingId)

    const result = await drainOutbox()
    expect(result.sent).toBeGreaterThanOrEqual(1)

    const sent = provider.sent.find((m) => m.dedupeKey === key)
    expect(sent, 'the drain never sent our message').toBeDefined()
    expect(sent!.template).toBe('booking_confirmed')
    expect(sent!.to).toBe(`+${attendeePhone}`)
    expect(sent!.variables.attendeeName).toBe('Asha')
    expect(sent!.bookingId).toBe(bookingId)

    expect(await messageRow(key)).toMatchObject({
      status: 'sent',
      attempts: 1,
      provider_message_id: 'fake-1',
      provider: 'fake',
      error: null,
    })
  })

  it('does not re-send a row it already sent', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const key = `booking:${bookingId}:confirmed`
    await enqueueOwedMessages()

    await drainOutbox()
    expect(provider.sent.filter((m) => m.dedupeKey === key)).toHaveLength(1)

    await drainOutbox()
    expect(provider.sent.filter((m) => m.dedupeKey === key)).toHaveLength(1)
  })

  it('records a retryable failure and tries again on the next drain', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const key = `booking:${bookingId}:confirmed`
    await enqueueOwedMessages()

    provider.result = { status: 'failed', retryable: true, error: 'upstream' }
    await drainOutbox()

    expect(await messageRow(key)).toMatchObject({ status: 'failed', attempts: 1, error: 'upstream' })

    provider.result = { status: 'sent', providerMessageId: 'fake-2' }
    await drainOutbox()

    // error cleared, not left behind to be read as the outcome of a row that
    // in the end went out fine.
    expect(await messageRow(key)).toMatchObject({ status: 'sent', attempts: 2, error: null })
  })

  it('retries a failure that expressed no opinion on retrying', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const key = `booking:${bookingId}:confirmed`
    await enqueueOwedMessages()

    // No `retryable` flag at all — which is what the log provider and any
    // adapter that could not classify its own error return. Absent means "no
    // opinion", not "do not retry": only an explicit false kills a row, or a
    // single unclassified blip burns the whole message.
    provider.result = { status: 'failed', error: 'no opinion' }
    await drainOutbox()

    expect(await messageRow(key)).toMatchObject({ status: 'failed', attempts: 1 })

    provider.result = { status: 'sent', providerMessageId: 'fake-3' }
    await drainOutbox()
    expect(await messageRow(key)).toMatchObject({ status: 'sent', attempts: 2 })
  })

  it('kills a non-retryable failure immediately rather than burning five ticks', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const key = `booking:${bookingId}:confirmed`
    await enqueueOwedMessages()

    provider.result = { status: 'failed', retryable: false, error: 'Template name does not exist' }
    await drainOutbox()

    // A bad template name never becomes good. One attempt, then dead.
    expect(await messageRow(key)).toMatchObject({ status: 'dead', attempts: 1 })

    const before = provider.sent.length
    await drainOutbox()
    expect(provider.sent).toHaveLength(before)
  })

  it('gives up after MAX_ATTEMPTS and stops picking the row up', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    const key = `booking:${bookingId}:confirmed`
    await enqueueOwedMessages()

    provider.result = { status: 'failed', retryable: true, error: 'still down' }
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await drainOutbox()

    expect(await messageRow(key)).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS })

    const before = provider.sent.length
    await drainOutbox()
    expect(provider.sent).toHaveLength(before)
  })

  it('caps attempts at the number the migration documents', () => {
    // 20260812000001_message_outbox.sql explains the attempts column with
    // "Five rather than three because the drain's interval is hours and not
    // seconds". Shipping a different number here makes that comment a lie
    // about the running system, and nothing else in the suite would notice:
    // every other assertion is written against the constant.
    expect(MAX_ATTEMPTS).toBe(5)
  })

  it('two concurrent drains send each message once', async () => {
    // The property the whole outbox rests on. Same shape as the 50-buyer
    // reservation test: fire both at once and count the sends, not the rows.
    const second = await newAttendee()
    const firstBooking = await confirmedBooking(seed.attendeeId)
    const secondBooking = await confirmedBooking(second)
    await enqueueOwedMessages()

    await Promise.all([drainOutbox(), drainOutbox()])

    const keys = provider.sent.map((m) => m.dedupeKey)
    // Both halves matter. Uniqueness alone is satisfied by a drain that sent
    // nothing, which is the failure a set comparison cannot see.
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((k) => k === `booking:${firstBooking}:confirmed`)).toHaveLength(1)
    expect(keys.filter((k) => k === `booking:${secondBooking}:confirmed`)).toHaveLength(1)

    // One attempt each: a row sent twice by two drains that both claimed it
    // would have been incremented twice.
    for (const id of [firstBooking, secondBooking]) {
      expect(await messageRow(`booking:${id}:confirmed`)).toMatchObject({ status: 'sent', attempts: 1 })
    }
  })
})
