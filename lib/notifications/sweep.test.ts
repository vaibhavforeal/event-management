import { describe, expect, it } from 'vitest'
import { messagesOwed, type SweepBooking } from '@/lib/notifications/sweep'
import { renderTemplate } from '@/lib/notifications/templates'

const NOW = new Date('2026-08-12T06:00:00Z')
const LAUNCH = new Date('2026-08-01T00:00:00Z')
const options = { now: NOW, launchAt: LAUNCH }

// formatIst renders "Wed, 19 Aug, 7:00 pm" — the product's one time format,
// deliberately without a year, and pinned to Asia/Kolkata. Asserting the whole
// string rather than a fragment is what makes these tests notice a message that
// carries `now` instead of the event, or the hold instead of the start.
const EVENT_TIME = 'Wed, 19 Aug, 7:00 pm' // starts_at 2026-08-19T13:30Z
const HOLD_TIME = 'Thu, 13 Aug, 10:30 am' // hold_expires_at 2026-08-13T05:00Z

/** A confirmed booking on an event a week out. Override one field per test. */
function booking(overrides: Partial<SweepBooking> = {}): SweepBooking {
  return {
    id: 'b-1',
    reference: 'VYRB4SHQ',
    status: 'confirmed',
    cancellation_reason: null,
    approved_at: null,
    payment_mode: 'online',
    total_paise: 50_000,
    quantity: 2,
    attendee_name: 'Asha',
    attendee_phone: '919876543210',
    created_at: '2026-08-10T00:00:00Z',
    hold_expires_at: null,
    event: {
      title: 'Diwali Supper',
      starts_at: '2026-08-19T13:30:00Z',
      venue_name: 'The Terrace',
      city: 'Indore',
      requires_approval: false,
      has_waitlist: false,
      host_phone: '919000000001',
      host_display_name: 'Ravi',
    },
    ...overrides,
  }
}

/** An approved hold waiting on payment — the shape both queues leave behind. */
const APPROVED = {
  status: 'awaiting_payment',
  approved_at: '2026-08-12T05:00:00Z',
  hold_expires_at: '2026-08-13T05:00:00Z',
} satisfies Partial<SweepBooking>

describe('the two gates', () => {
  it('says nothing about an event that has already started', () => {
    // The WhatsApp link outlives the event; a reminder for last night is worse
    // than silence.
    expect(
      messagesOwed([booking({ event: { ...booking().event, starts_at: '2026-08-11T13:30:00Z' } })], options),
    ).toEqual([])
  })

  it('says nothing about an event starting in this very second', () => {
    // Inclusive, matching hasStarted and the EH013 guard in book_free_tickets:
    // an event under way is not one to send anybody anything about.
    expect(
      messagesOwed([booking({ event: { ...booking().event, starts_at: NOW.toISOString() } })], options),
    ).toEqual([])
  })

  it('says nothing about a booking made before the launch timestamp', () => {
    // THE test that stops the first production run messaging every attendee
    // about every event this product has ever run.
    expect(messagesOwed([booking({ created_at: '2026-07-30T00:00:00Z' })], options)).toEqual([])
  })

  it('includes a booking made exactly at the launch timestamp', () => {
    // Inclusive boundary, so a booking made in the same second the phase went
    // live is not silently dropped.
    const owed = messagesOwed([booking({ created_at: LAUNCH.toISOString() })], options)
    expect(owed.map((m) => m.template)).toContain('booking_confirmed')
  })
})

describe('confirmed bookings', () => {
  it('owes a confirmation, addressed to the attendee in E.164', () => {
    const [message] = messagesOwed([booking()], options)
    expect(message).toMatchObject({
      to: '+919876543210', // profiles.phone has no '+'; normalisePhone adds it
      template: 'booking_confirmed',
      dedupeKey: 'booking:b-1:confirmed',
      bookingId: 'b-1',
    })
    expect(message.variables).toEqual({
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
      eventDateTime: EVENT_TIME,
      venue: 'The Terrace',
      bookingReference: 'VYRB4SHQ',
    })
  })

  it('falls back to the city when an event has no venue name', () => {
    const [message] = messagesOwed(
      [booking({ event: { ...booking().event, venue_name: null } })],
      options,
    )
    expect(message.variables.venue).toBe('Indore')
  })

  it('calls an unnamed attendee Guest rather than sending "Hi null"', () => {
    const [message] = messagesOwed([booking({ attendee_name: null })], options)
    expect(message.variables.attendeeName).toBe('Guest')

    // A name of spaces is a name nobody typed, and "Hi   ," reads worse than
    // "Hi Guest" — profiles.full_name is free text with no trim behind it.
    const [blank] = messagesOwed([booking({ attendee_name: '   ' })], options)
    expect(blank.variables.attendeeName).toBe('Guest')
  })

  it('adds a reminder once the event is inside the window, and not before', () => {
    const outside = messagesOwed([booking()], options).map((m) => m.template)
    expect(outside).toEqual(['booking_confirmed'])

    const soon = booking({ event: { ...booking().event, starts_at: '2026-08-13T02:00:00Z' } })
    const inside = messagesOwed([soon], options)
    expect(inside.map((m) => m.template)).toEqual(['booking_confirmed', 'event_reminder'])
    // Different keys, so the confirmation already sent on an earlier tick is
    // not re-sent and the reminder is not suppressed by it.
    expect(inside.map((m) => m.dedupeKey)).toEqual([
      'booking:b-1:confirmed',
      'booking:b-1:reminder',
    ])
  })

  it('treats the window edge as inside it', () => {
    // The sweep runs on a cron, not continuously: an exclusive edge means a
    // tick that lands exactly 24 hours out sends nothing and the next tick is
    // already late. NOW + 24h, to the second, and one minute beyond it.
    const at = messagesOwed(
      [booking({ event: { ...booking().event, starts_at: '2026-08-13T06:00:00Z' } })],
      options,
    )
    expect(at.map((m) => m.template)).toEqual(['booking_confirmed', 'event_reminder'])

    const past = messagesOwed(
      [booking({ event: { ...booking().event, starts_at: '2026-08-13T06:01:00Z' } })],
      options,
    )
    expect(past.map((m) => m.template)).toEqual(['booking_confirmed'])
  })

  it('reminds on the callers window rather than its own default', () => {
    // The default is 24 and every other test in this file sits either side of
    // it, so an implementation that ignored the option would still be green.
    const wide = messagesOwed([booking()], { ...options, reminderWindowHours: 180 })
    expect(wide.map((m) => m.template)).toEqual(['booking_confirmed', 'event_reminder'])
  })

  it('honours a window of zero as "no reminders", not as "unset"', () => {
    // `||` would read 0 as absent and fall back to 24, which turns the one
    // switch for muting reminders into a no-op.
    const soon = booking({ event: { ...booking().event, starts_at: '2026-08-13T02:00:00Z' } })
    const owed = messagesOwed([soon], { ...options, reminderWindowHours: 0 })
    expect(owed.map((m) => m.template)).toEqual(['booking_confirmed'])
  })

  it('gives the reminder exactly the four variables its template names', () => {
    // A wrong or missing key here is invisible until Meta is asked to render
    // it, hours later, for someone who then never learns the event is tomorrow.
    const soon = booking({ event: { ...booking().event, starts_at: '2026-08-13T02:00:00Z' } })
    const [, reminder] = messagesOwed([soon], options)
    expect(reminder.variables).toEqual({
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
      eventDateTime: 'Thu, 13 Aug, 7:30 am',
      venue: 'The Terrace',
    })
  })
})

describe('the approval queue', () => {
  it('tells the HOST about a pending request, not the attendee', () => {
    const [message] = messagesOwed(
      [booking({ status: 'pending_approval', event: { ...booking().event, requires_approval: true } })],
      options,
    )
    expect(message).toMatchObject({
      to: '+919000000001', // the host's number
      template: 'approval_requested',
      dedupeKey: 'booking:b-1:requested',
    })
    expect(message.variables).toEqual({
      hostName: 'Ravi',
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
    })
  })

  it('tells the attendee they are approved, with the deadline', () => {
    const [message] = messagesOwed(
      [booking({ ...APPROVED, event: { ...booking().event, requires_approval: true } })],
      options,
    )
    expect(message).toMatchObject({
      to: '+919876543210',
      template: 'approval_granted',
      dedupeKey: 'booking:b-1:approved',
    })
    // The hold, not the event and not now: those are the two wrong dates a
    // "complete payment by" sentence can carry, and both would still read fine.
    expect(message.variables.paymentDeadline).toBe(HOLD_TIME)
  })
})

describe('the waitlist', () => {
  it('offers the seat, and says nothing about money', () => {
    const [message] = messagesOwed(
      [booking({ ...APPROVED, event: { ...booking().event, has_waitlist: true } })],
      options,
    )
    expect(message).toMatchObject({
      template: 'waitlist_seat_offered',
      dedupeKey: 'booking:b-1:offered',
    })
    expect(Object.keys(message.variables).sort()).toEqual([
      'attendeeName',
      'deadline',
      'eventTitle',
    ])
    expect(message.variables.deadline).toBe(HOLD_TIME)
  })

  it('says nothing at all about someone merely standing in the line', () => {
    // A message per join is the one thing that would make a queue feel like
    // spam, and being in a line is not news.
    expect(messagesOwed([booking({ status: 'waitlisted' })], options)).toEqual([])
  })

  it('does not confuse an approval with an offer, in either direction', () => {
    const offer = messagesOwed(
      [booking({ ...APPROVED, event: { ...booking().event, has_waitlist: true } })],
      options,
    )
    const approval = messagesOwed(
      [booking({ ...APPROVED, event: { ...booking().event, requires_approval: true } })],
      options,
    )
    expect(offer[0].template).toBe('waitlist_seat_offered')
    expect(approval[0].template).toBe('approval_granted')
  })

  it('owes nothing for an awaiting_payment hold that was never approved', () => {
    // A plain Phase 3 checkout hold. approved_at is what separates it.
    expect(messagesOwed([booking({ status: 'awaiting_payment' })], options)).toEqual([])
  })
})

describe('endings', () => {
  it('tells a removed guest, and says the money is coming when it is', () => {
    // refundIfOwed flips a paid cancellation to 'refunded' and leaves the
    // reason intact. Matching only 'cancelled' would skip every PAID removal.
    const [message] = messagesOwed(
      [booking({ status: 'refunded', cancellation_reason: 'cancelled by host' })],
      options,
    )
    expect(message).toMatchObject({
      template: 'booking_cancelled',
      dedupeKey: 'booking:b-1:cancelled',
    })
    expect(message.variables.refundNote).toBe('₹500 will be refunded.')
  })

  it('tells a removed guest when no money was involved, without promising any', () => {
    const [message] = messagesOwed(
      [booking({ status: 'cancelled', cancellation_reason: 'cancelled by host', total_paise: 0 })],
      options,
    )
    expect(message.variables.refundNote).toBe('No payment was taken.')
  })

  it('promises nothing to a removed guest who had not paid yet', () => {
    // total_paise is the PRICE, not evidence that money moved: a cash booking
    // and an unpaid online hold both carry it. Only the flip to 'refunded' says
    // a refund exists, so a note keyed on the amount promises ₹500 to someone
    // who never sent it — and this row differs from the one above in status
    // alone, which is the difference that decides.
    const [message] = messagesOwed(
      [booking({ status: 'cancelled', cancellation_reason: 'cancelled by host', total_paise: 50_000 })],
      options,
    )
    expect(message.variables.refundNote).toBe('No payment was taken.')
  })

  it('declines a request in its own words', () => {
    const [message] = messagesOwed(
      [booking({ status: 'cancelled', cancellation_reason: 'declined by host' })],
      options,
    )
    expect(message).toMatchObject({
      template: 'request_declined',
      dedupeKey: 'booking:b-1:declined',
    })
  })

  it('says nothing when the attendee cancelled it themselves', () => {
    // They did it. Telling them is noise.
    expect(
      messagesOwed([booking({ status: 'cancelled', cancellation_reason: 'cancelled by attendee' })], options),
    ).toEqual([])
  })

  it('says nothing when the attendee cancelled a paid booking either', () => {
    // refundIfOwed flips to 'refunded' whoever started it, so 'refunded' alone
    // is not a host removal — this is the reachable row that a status-only
    // match would message, and it is the attendee's own doing.
    expect(
      messagesOwed([booking({ status: 'refunded', cancellation_reason: 'cancelled by attendee' })], options),
    ).toEqual([])
  })

  it('says nothing when a hold simply expired', () => {
    // Already the whole story on their own page, and nobody chose it.
    expect(
      messagesOwed([booking({ status: 'expired', cancellation_reason: 'payment hold expired' })], options),
    ).toEqual([])
  })

  it('says nothing for a cancellation with no reason recorded', () => {
    // Fails closed: an unrecognised reason is not an excuse to guess which of
    // four sentences applies.
    expect(messagesOwed([booking({ status: 'cancelled', cancellation_reason: null })], options)).toEqual([])
  })
})

describe('batches', () => {
  it('keeps every row independent and preserves input order', () => {
    const owed = messagesOwed(
      [
        booking({ id: 'b-1' }),
        booking({ id: 'b-2', status: 'waitlisted' }),
        booking({ id: 'b-3', status: 'cancelled', cancellation_reason: 'declined by host' }),
      ],
      options,
    )
    expect(owed.map((m) => m.dedupeKey)).toEqual([
      'booking:b-1:confirmed',
      'booking:b-3:declined',
    ])
  })
})

describe('everything it owes is sendable', () => {
  /** One booking per kind of message the sweep can produce. */
  const everyKind = [
    booking({ id: 'b-confirmed' }),
    booking({ id: 'b-soon', event: { ...booking().event, starts_at: '2026-08-13T02:00:00Z' } }),
    booking({ id: 'b-request', status: 'pending_approval' }),
    booking({ id: 'b-approved', ...APPROVED, event: { ...booking().event, requires_approval: true } }),
    booking({ id: 'b-offer', ...APPROVED, event: { ...booking().event, has_waitlist: true } }),
    booking({ id: 'b-removed', status: 'refunded', cancellation_reason: 'cancelled by host' }),
    booking({ id: 'b-declined', status: 'cancelled', cancellation_reason: 'declined by host' }),
  ]

  it('reaches all seven templates a booking can earn', () => {
    // auth_otp is the eighth and belongs to login. If a template registered for
    // Meta approval is unreachable from state, either this table is wrong or we
    // paid for a review of something nobody will ever receive.
    const owed = messagesOwed(everyKind, options)
    expect([...new Set(owed.map((m) => m.template))].sort()).toEqual([
      'approval_granted',
      'approval_requested',
      'booking_cancelled',
      'booking_confirmed',
      'event_reminder',
      'request_declined',
      'waitlist_seat_offered',
    ])
  })

  it('names the variables each of those templates asks for', () => {
    // renderTemplate throws on a missing variable — but it is called at SEND
    // time, so a mistyped key here surfaces days later as a message that never
    // arrives. Rendering every kind moves that failure into this file.
    for (const message of messagesOwed(everyKind, options)) {
      const body = renderTemplate(message.template, message.variables)
      expect(body).not.toMatch(/\{\{\d+\}\}/)
      expect(body).not.toContain('undefined')
    }
  })

  it('addresses every message to a real number, and keys each one uniquely', () => {
    // message_log.dedupe_key is UNIQUE, so two messages sharing a key inside
    // one sweep is not a duplicate that gets skipped — it is a message that is
    // never sent at all.
    const owed = messagesOwed(everyKind, options)
    expect(owed.every((m) => /^\+\d{10,15}$/.test(m.to))).toBe(true)
    expect(new Set(owed.map((m) => m.dedupeKey)).size).toBe(owed.length)
  })
})
