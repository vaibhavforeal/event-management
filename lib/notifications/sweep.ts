import { formatIst, hasStarted } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { normalisePhone } from '@/lib/notifications/types'
import type { OutboundMessage } from '@/lib/notifications/types'

/**
 * What the product owes people, derived from state.
 *
 * Pure on purpose. There are no send sites anywhere in this codebase: nothing
 * in lib/bookings, lib/payments or any SQL function knows that notifications
 * exist. Instead this module is handed rows and a clock and says which
 * messages are owed, which means the whole feature can be tested in
 * milliseconds without a database or a provider — and that messages are owed
 * for bookings that already existed before this phase shipped, not only for
 * ones created after it.
 *
 * Every decision is keyed `booking:<id>:<kind>`, and message_log.dedupe_key is
 * UNIQUE, so running this twice, or running two drains at once, converges on
 * one message.
 */

/** How long before an event the reminder goes out. */
const DEFAULT_REMINDER_WINDOW_HOURS = 24

export interface SweepBooking {
  id: string
  reference: string
  status: string
  cancellation_reason: string | null
  approved_at: string | null
  total_paise: number
  attendee_name: string | null
  /** profiles.phone. GoTrue stores it WITHOUT a leading '+'. */
  attendee_phone: string
  created_at: string
  hold_expires_at: string | null
  event: {
    title: string
    starts_at: string
    venue_name: string | null
    city: string
    requires_approval: boolean
    has_waitlist: boolean
    /** profiles.phone of the host, for the one message they receive. */
    host_phone: string
    host_display_name: string
  }
}

export interface SweepOptions {
  now: Date
  /**
   * Bookings created before this are ignored. Without it the first run
   * messages every attendee about every event this product has ever run.
   */
  launchAt: Date
  reminderWindowHours?: number
}

/** What a host reads at the door, and what a template says "Hi" to. */
function displayName(booking: SweepBooking): string {
  return booking.attendee_name?.trim() || 'Guest'
}

/** Venue name if there is one, else the city — never an empty line. */
function venueOf(booking: SweepBooking): string {
  return booking.event.venue_name?.trim() || booking.event.city
}

/**
 * E.164 for a number we can send to, or undefined for one we cannot.
 *
 * `attendee_phone: string` is a promise the database cannot keep. profiles.phone
 * is NOT NULL but nothing constrains its shape, and normalisePhone throws on
 * anything it cannot map — '', '   ', an eleven-digit number. Thrown from a
 * sweep, that takes the whole batch with it: one bad row in four hundred and
 * nobody hears anything, including the rows already appended. Total silence is
 * the worst failure a notification system has, so the row skips itself.
 *
 * Called at the point of use, never before the status switch, so a row that
 * owes nothing — a waitlisted one, an attendee's own cancellation — cannot log
 * about a number nothing was going to dial.
 */
function sendableNumber(raw: string, bookingId: string, whose: 'attendee' | 'host'): string | undefined {
  try {
    return normalisePhone(raw)
  } catch (cause) {
    // Not swallowed: the booking id is what makes the row findable, and a
    // message nobody receives is otherwise indistinguishable from one nobody
    // was owed.
    console.error(`[notifications] booking ${bookingId} has an unusable ${whose} number; it gets no messages`, cause)
    return undefined
  }
}

/**
 * What the cancellation did to their money. `refunded` means the refund was
 * created — settlement lag lives in refunds.status, and promising "refunded"
 * at creation is the same claim the booking page already makes.
 *
 * Keyed on the status and not on total_paise, which is the ticket PRICE and is
 * set on cash bookings and unpaid holds too. Only the flip to `refunded` is
 * evidence that money actually moved.
 */
function refundNote(booking: SweepBooking): string {
  if (booking.status === 'refunded' && booking.total_paise > 0) {
    return `${formatPaise(booking.total_paise)} will be refunded.`
  }
  return 'No payment was taken.'
}

export function messagesOwed(
  bookings: SweepBooking[],
  options: SweepOptions,
): OutboundMessage[] {
  const { now, launchAt } = options
  // ?? and not ||, so a caller can mute reminders with 0 rather than having it
  // read as "unset" and get the default back.
  const windowHours = options.reminderWindowHours ?? DEFAULT_REMINDER_WINDOW_HOURS
  const owed: OutboundMessage[] = []

  for (const booking of bookings) {
    // Gate one: the event is over, or under way. A WhatsApp link outlives its
    // event, and so does a bookings row; a reminder for last night is worse
    // than silence.
    //
    // hasStarted rather than an inline comparison: it is the tested authority
    // for this exact question, it is what the event page and book_free_tickets
    // agree with, and it fails closed on an unreadable time on EITHER side.
    // Every comparison against NaN is false, so the inline `<=` this replaced
    // called an unreadable start "not started" — and an unreadable `now`, which
    // a caller supplies, made the gate never fire at all.
    if (hasStarted(booking.event.starts_at, now)) continue

    // Gate two: the cutoff. Inclusive, so a booking made in the same second
    // the phase went live is not dropped.
    //
    // Fails closed the same way, and here it is the whole point of the gate:
    // Task 6 reads launchAt from configuration, so an unset or misspelled
    // variable is an Invalid Date, and a gate that never fires messages every
    // attendee of every event this product has ever run. A row we cannot place
    // against the cutoff is a row we cannot prove is ours to message.
    const createdAt = new Date(booking.created_at).getTime()
    const cutoff = launchAt.getTime()
    if (Number.isNaN(createdAt) || Number.isNaN(cutoff) || createdAt < cutoff) continue

    const startsAt = new Date(booking.event.starts_at)
    const base = { bookingId: booking.id }
    const eventDateTime = formatIst(startsAt)

    if (booking.status === 'confirmed') {
      const attendee = sendableNumber(booking.attendee_phone, booking.id, 'attendee')
      if (!attendee) continue

      owed.push({
        ...base,
        to: attendee,
        template: 'booking_confirmed',
        dedupeKey: `booking:${booking.id}:confirmed`,
        variables: {
          attendeeName: displayName(booking),
          eventTitle: booking.event.title,
          eventDateTime,
          venue: venueOf(booking),
          bookingReference: booking.reference,
        },
      })

      const hoursAway = (startsAt.getTime() - now.getTime()) / 3_600_000
      // Inclusive: the sweep runs on a cron, so an exclusive edge means the
      // tick that lands exactly on the window sends nothing and the next one
      // is already late.
      if (hoursAway <= windowHours) {
        owed.push({
          ...base,
          to: attendee,
          template: 'event_reminder',
          dedupeKey: `booking:${booking.id}:reminder`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            eventDateTime,
            venue: venueOf(booking),
          },
        })
      }
      continue
    }

    if (booking.status === 'pending_approval') {
      // The one message in the product addressed to the host.
      const host = sendableNumber(booking.event.host_phone, booking.id, 'host')
      if (!host) continue

      owed.push({
        ...base,
        to: host,
        template: 'approval_requested',
        dedupeKey: `booking:${booking.id}:requested`,
        variables: {
          hostName: booking.event.host_display_name,
          attendeeName: displayName(booking),
          eventTitle: booking.event.title,
        },
      })
      continue
    }

    if (booking.status === 'awaiting_payment' && booking.approved_at) {
      // Both queues leave a booking in exactly this shape — that reuse is the
      // whole of Phase 5b's design — so the event's flags are what separate
      // them, and events_one_queue keeps those mutually exclusive.
      //
      // No amount or payment_mode check is needed on the approval arm:
      // approve_booking confirms cash and free requests straight from
      // pending_approval, so they never reach awaiting_payment at all.
      //
      // The '' fallback is unreachable: both producers stamp hold_expires_at in
      // the same statement that sets approved_at, which is why the booking page
      // asserts it non-null. It stays a fallback rather than a skip because a
      // seat offer with a gap in its sentence still tells someone they have a
      // seat, and one that is never sent does not.
      const deadline = booking.hold_expires_at ? formatIst(new Date(booking.hold_expires_at)) : ''

      if (booking.event.has_waitlist) {
        const attendee = sendableNumber(booking.attendee_phone, booking.id, 'attendee')
        if (!attendee) continue

        owed.push({
          ...base,
          to: attendee,
          template: 'waitlist_seat_offered',
          dedupeKey: `booking:${booking.id}:offered`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            deadline,
          },
        })
      } else if (booking.event.requires_approval) {
        const attendee = sendableNumber(booking.attendee_phone, booking.id, 'attendee')
        if (!attendee) continue

        owed.push({
          ...base,
          to: attendee,
          template: 'approval_granted',
          dedupeKey: `booking:${booking.id}:approved`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            paymentDeadline: deadline,
          },
        })
      }
      continue
    }

    // 'refunded' is a cancelled booking whose money moved: refundIfOwed flips
    // cancelled -> refunded at refund CREATION and leaves cancellation_reason
    // alone. Matching only 'cancelled' here would skip every paid host
    // removal, which is the one case where the attendee most needs telling.
    if (booking.status === 'cancelled' || booking.status === 'refunded') {
      if (booking.cancellation_reason === 'cancelled by host') {
        const attendee = sendableNumber(booking.attendee_phone, booking.id, 'attendee')
        if (!attendee) continue

        owed.push({
          ...base,
          to: attendee,
          template: 'booking_cancelled',
          dedupeKey: `booking:${booking.id}:cancelled`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            refundNote: refundNote(booking),
          },
        })
      } else if (booking.cancellation_reason === 'declined by host') {
        // A request never held a payment, so it can never be 'refunded' —
        // and it was never a booking, which is why booking_cancelled's
        // opening sentence would be false for it.
        const attendee = sendableNumber(booking.attendee_phone, booking.id, 'attendee')
        if (!attendee) continue

        owed.push({
          ...base,
          to: attendee,
          template: 'request_declined',
          dedupeKey: `booking:${booking.id}:declined`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
          },
        })
      }
      // Any other reason — 'cancelled by attendee', 'payment hold expired',
      // or none recorded — sends nothing. They did it, or it is already the
      // whole story on their page.
    }
  }

  return owed
}
