import { describe, expect, it } from 'vitest'
import {
  TEMPLATES,
  renderTemplate,
  templateComponents,
  type TemplateName,
} from '@/lib/notifications/templates'
import { LogNotificationProvider } from '@/lib/notifications/providers/log'
import { NotificationError, normalisePhone } from '@/lib/notifications/types'

describe('template registry', () => {
  it('declares every placeholder its body uses', () => {
    for (const [key, definition] of Object.entries(TEMPLATES)) {
      const placeholders = [...definition.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) =>
        Number(m[1]),
      )
      const highest = placeholders.length > 0 ? Math.max(...placeholders) : 0

      expect(
        highest,
        `template "${key}" uses {{${highest}}} but declares ${definition.variables.length} variables`,
      ).toBeLessThanOrEqual(definition.variables.length)

      // Positional placeholders must be contiguous from 1, or Meta rejects them.
      const unique = [...new Set(placeholders)].sort((a, b) => a - b)
      expect(unique, `template "${key}" has non-contiguous placeholders`).toEqual(
        Array.from({ length: unique.length }, (_, i) => i + 1),
      )
    }
  })

  it('sends no marketing templates, which are 7.5x the price', () => {
    for (const definition of Object.values(TEMPLATES)) {
      expect(definition.category).not.toBe('marketing')
    }
  })

  it('keeps the OTP template free of links and emoji, as Meta requires', () => {
    const otp = TEMPLATES.auth_otp
    expect(otp.category).toBe('authentication')
    expect(otp.body).not.toMatch(/https?:\/\//)
    expect(otp.body).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it('renders positional placeholders', () => {
    const rendered = renderTemplate('event_reminder', {
      attendeeName: 'Asha',
      eventTitle: 'Board Game Night',
      eventDateTime: 'Sat 15 Aug, 7pm',
      venue: 'The Loft, Indore',
    })

    expect(rendered).toBe(
      'Hi Asha, reminder: Board Game Night is on Sat 15 Aug, 7pm at The Loft, Indore. See you there.',
    )
  })

  it('refuses to render with a variable missing rather than printing undefined', () => {
    expect(() => renderTemplate('event_reminder', { attendeeName: 'Asha' })).toThrow(
      /missing variable "eventTitle"/,
    )
  })

  it('orders components the way Meta expects', () => {
    expect(
      templateComponents('booking_confirmed', {
        attendeeName: 'Asha',
        eventTitle: 'Supper Club',
        eventDateTime: 'Sat 7pm',
        venue: 'The Loft',
        bookingReference: 'A1B2C3D4',
      }),
    ).toEqual(['Asha', 'Supper Club', 'Sat 7pm', 'The Loft', 'A1B2C3D4'])
  })

  it('names every template consistently with its key', () => {
    for (const [key, definition] of Object.entries(TEMPLATES)) {
      expect(definition.name).toBe(key)
      // Meta requires lowercase alphanumeric plus underscore.
      expect(definition.name).toMatch(/^[a-z0-9_]+$/)
    }
  })
})

describe('normalisePhone', () => {
  it('accepts the forms an Indian user actually types', () => {
    expect(normalisePhone('9876543210')).toBe('+919876543210')
    expect(normalisePhone('09876543210')).toBe('+919876543210')
    expect(normalisePhone('919876543210')).toBe('+919876543210')
    expect(normalisePhone('+919876543210')).toBe('+919876543210')
    expect(normalisePhone('98765 43210')).toBe('+919876543210')
    expect(normalisePhone('+91 98765-43210')).toBe('+919876543210')
  })

  it('rejects what it cannot confidently interpret', () => {
    expect(() => normalisePhone('12345')).toThrow(NotificationError)
    expect(() => normalisePhone('')).toThrow(NotificationError)
  })
})

describe('LogNotificationProvider', () => {
  it('records what it would have sent', async () => {
    const provider = new LogNotificationProvider()
    const result = await provider.send({
      to: '+919876543210',
      template: 'auth_otp' as TemplateName,
      variables: { otp: '123456' },
      dedupeKey: 'otp:test',
    })

    expect(result.status).toBe('sent')
    expect(provider.sent).toHaveLength(1)
    expect(provider.sent[0].body).toBe('123456 is your verification code.')
  })
})
