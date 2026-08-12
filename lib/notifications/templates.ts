/**
 * WhatsApp template registry.
 *
 * Meta must pre-approve every template before it can be sent, and approval
 * takes hours to days. This file is the authoritative list to submit — treat it
 * as a deliverable for day one, not for the week you wire up sending.
 *
 * Category drives cost (India rates, effective Jan 2026):
 *   authentication  ~₹0.115  always charged
 *   utility         ~₹0.115  FREE inside an open 24h customer service window
 *   marketing       ~₹0.8631 always charged — we send none of these
 *
 * Register the WhatsApp Business Account with India as Sold-To country and INR
 * billing. A WABA registered elsewhere bills authentication at the
 * authentication-international rate of ~₹2.30, twenty times more, and the
 * setting cannot be changed afterwards.
 *
 * Register auth_otp WITH a copy-code OTP button:
 *
 *   { "type": "buttons",
 *     "buttons": [{ "type": "otp", "otp_type": "copy_code" }] }
 *
 * Not optional, and not a preference. Meta requires a buttons component on
 * every authentication template. Its docs offer "no button at all" only for
 * zero-tap, and zero-tap still requires one-tap and copy-code buttons in the
 * creation payload — plus an Android package_name and signature_hash, which a
 * web app does not have. That leaves copy code.
 *
 * The consequence lands on the send: an authentication template's payload
 * carries the code TWICE, once in the body component and once in a button
 * component. lib/notifications/providers/meta.ts adds the second one for
 * templates whose category here is 'authentication', so the category field
 * below is not documentation — it is what decides the wire format.
 *
 * The other seven are utility and must be created with NO buttons, since a
 * button they were registered with is a button every send has to carry.
 */

export type TemplateCategory = 'authentication' | 'utility' | 'marketing'

export interface TemplateDefinition {
  /** Name as registered with Meta. Lowercase with underscores is required. */
  name: string
  category: TemplateCategory
  /** Ordered placeholders. WhatsApp templates use positional {{1}}, {{2}}, ... */
  variables: readonly string[]
  /** Body copy submitted to Meta, with {{n}} placeholders in position. */
  body: string
  /** Why this message exists, for the reviewer and for us. */
  purpose: string
}

export const TEMPLATES = {
  auth_otp: {
    name: 'auth_otp',
    category: 'authentication',
    variables: ['otp'],
    // Authentication templates are format-restricted: no links, no emoji.
    body: '{{1}} is your verification code.',
    purpose: 'Login OTP. Replaces SMS entirely, which also avoids TRAI DLT registration.',
  },
  booking_confirmed: {
    name: 'booking_confirmed',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle', 'eventDateTime', 'venue', 'bookingReference'],
    body:
      'Hi {{1}}, you are confirmed for {{2}} on {{3}} at {{4}}.\n\n' +
      'Booking reference: {{5}}\n' +
      'Show the QR code in the app at the door.',
    purpose:
      'Sent once a booking reaches confirmed, by any route: payment capture, ' +
      'a free booking, a cash booking, an approved cash-or-free request, or a ' +
      'claimed waitlist seat. Carries the reference; the QR lives in the app.',
  },
  event_reminder: {
    name: 'event_reminder',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle', 'eventDateTime', 'venue'],
    body: 'Hi {{1}}, reminder: {{2}} is on {{3}} at {{4}}. See you there.',
    purpose: 'Sent 24 hours before. The single biggest lever on no-show rate.',
  },
  booking_cancelled: {
    name: 'booking_cancelled',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle', 'refundNote'],
    // The closing sentence is here to keep {{3}} off the end of the body, which
    // Meta rejects at submission. It also earns its place: refundNote is a whole
    // sentence from cancelConsequence and says nothing about what the attendee
    // is expected to do next, which after a cancellation is the open question.
    body:
      'Hi {{1}}, your booking for {{2}} has been cancelled. {{3}} ' +
      'Nothing else is needed from you.',
    purpose: 'Sent when a host cancels an event or a booking is refunded.',
  },
  approval_requested: {
    name: 'approval_requested',
    category: 'utility',
    variables: ['hostName', 'attendeeName', 'eventTitle'],
    body: 'Hi {{1}}, {{2}} has requested a spot at {{3}}. Review it in your dashboard.',
    purpose: 'Sent to the host when a curated event receives a request.',
  },
  approval_granted: {
    name: 'approval_granted',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle', 'paymentDeadline'],
    body:
      'Hi {{1}}, you are approved for {{2}}. ' +
      'Complete payment by {{3}} to confirm your spot.',
    purpose:
      'Sent when a host approves a request that still owes an online payment. ' +
      'NOT sent for cash or free approvals: approve_booking confirms those ' +
      'straight from pending_approval, so there is no payment to complete and ' +
      'no hold to beat — they get booking_confirmed instead.',
  },
  waitlist_seat_offered: {
    name: 'waitlist_seat_offered',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle', 'deadline'],
    // Deliberately silent about money so one template serves both paths: an
    // online offer that is paid for, and a cash or free offer that is claimed
    // with a tap. Naming an amount would mean two templates, two approval
    // rounds, and a routing decision at send time.
    body:
      'Hi {{1}}, a seat opened up for {{2}}. It’s held for you until {{3}} — ' +
      'open your booking to take it.',
    purpose:
      'Sent when the waitlist promotes someone. Without it a freed seat is ' +
      'discovered only by opening the page, which is what Phase 5b named as ' +
      'its worst case: 24 hours lost per inattentive person in the line.',
  },
  request_declined: {
    name: 'request_declined',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle'],
    body:
      'Hi {{1}}, {{2}} is full this time and the host couldn’t fit you in. ' +
      'You’ll see other events from them soon.',
    purpose:
      'Sent when a host declines a request. Separate from booking_cancelled ' +
      'because that one opens "your booking has been cancelled", which is ' +
      'false for someone who asked and was turned down.',
  },
} as const satisfies Record<string, TemplateDefinition>

export type TemplateName = keyof typeof TEMPLATES

/** Renders a template body locally — used by the log provider and by tests. */
export function renderTemplate(
  name: TemplateName,
  variables: Record<string, string>,
): string {
  const definition = TEMPLATES[name]
  let rendered: string = definition.body
  definition.variables.forEach((variableName, index) => {
    const value = variables[variableName]
    if (value === undefined) {
      throw new Error(`Template "${name}" is missing variable "${variableName}"`)
    }
    rendered = rendered.replaceAll(`{{${index + 1}}}`, value)
  })
  return rendered
}

/** Positional arguments, in the order Meta's API expects them. */
export function templateComponents(
  name: TemplateName,
  variables: Record<string, string>,
): string[] {
  return TEMPLATES[name].variables.map((variableName) => {
    const value = variables[variableName]
    if (value === undefined) {
      throw new Error(`Template "${name}" is missing variable "${variableName}"`)
    }
    return value
  })
}
