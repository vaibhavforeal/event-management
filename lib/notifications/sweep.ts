import { formatIst } from '@/lib/events/datetime'
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
  payment_mode: string
  total_paise: number
  quantity: number
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
    const startsAt = new Date(booking.event.starts_at)

    // Gate one: the event is over, or under way. A WhatsApp link outlives its
    // event, and so does a bookings row; a reminder for last night is worse
    // than silence.
    if (startsAt.getTime() <= now.getTime()) continue

    // Gate two: the cutoff. Inclusive, so a booking made in the same second
    // the phase went live is not dropped.
    if (new Date(booking.created_at).getTime() < launchAt.getTime()) continue

    const attendee = normalisePhone(booking.attendee_phone)
    const base = { bookingId: booking.id }
    const eventDateTime = formatIst(startsAt)

    if (booking.status === 'confirmed') {
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
      owed.push({
        ...base,
        to: normalisePhone(booking.event.host_phone),
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
      const deadline = booking.hold_expires_at ? formatIst(new Date(booking.hold_expires_at)) : ''

      if (booking.event.has_waitlist) {
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
