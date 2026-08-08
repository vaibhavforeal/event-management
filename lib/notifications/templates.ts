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
    purpose: 'Sent immediately on payment capture. Carries the ticket.',
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
    body: 'Hi {{1}}, your booking for {{2}} has been cancelled. {{3}}',
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
    purpose: 'Sent when a host approves a request. Starts the payment hold clock.',
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
