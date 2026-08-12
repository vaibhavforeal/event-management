import { describe, expect, it } from 'vitest'
import {
  renderTemplate,
  templateComponents,
  TEMPLATES,
  type TemplateDefinition,
} from '@/lib/notifications/templates'

/** Every {{n}} in a body, in the order it appears. */
function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
}

describe('every template is valid for submission to Meta', () => {
  // Widened to the declared interface deliberately. `as const` narrows category
  // to the literals that happen to be present, which would turn the marketing
  // check below into a compile error rather than a test — and a check that
  // cannot fail at runtime is not guarding the submission.
  const entries = Object.entries(TEMPLATES) as Array<[string, TemplateDefinition]>

  it('covers all eight templates', () => {
    // A count, so that deleting one to make another test pass is loud.
    expect(entries).toHaveLength(8)
  })

  it('registers exactly the eight names the product sends', () => {
    // The count alone survives a rename, and a renamed template is one Meta has
    // never seen: every send of it 404s, months after the approval round that
    // would have fixed it.
    expect(Object.keys(TEMPLATES).sort()).toEqual([
      'approval_granted',
      'approval_requested',
      'auth_otp',
      'booking_cancelled',
      'booking_confirmed',
      'event_reminder',
      'request_declined',
      'waitlist_seat_offered',
    ])
  })

  it.each(entries)('%s: placeholders are 1..n, in order, each used once', (_name, definition) => {
    const found = placeholders(definition.body)
    const expected = definition.variables.map((_, index) => index + 1)
    // Positional templates are the one place where a reordering is silent:
    // Meta fills {{1}} with whatever we send first, so a body numbered
    // 1,3,2 puts the venue where the name belongs and nothing errors.
    expect(found).toEqual(expected)
  })

  it.each(entries)('%s: names each variable once', (_name, definition) => {
    // A repeated name passes every other check in this file — the placeholders
    // are still 1..n — while renderTemplate quietly writes the same value into
    // both positions, so the message names the attendee where the venue goes.
    expect(new Set(definition.variables).size).toBe(definition.variables.length)
  })

  it.each(entries)('%s: body neither starts nor ends with a placeholder', (_name, definition) => {
    // Meta rejects these at submission. Finding out here costs a minute;
    // finding out at submission costs a round trip of hours.
    //
    // Authentication is exempt from the leading check, and it is an exemption
    // rather than a loophole: Meta calls that body "fixed, non-customizable
    // preset text" and the creation payload has no `text` property to override
    // it with. It begins with the code because Meta wrote it that way, and the
    // string here is a transcription of Meta's copy, not ours.
    if (definition.category !== 'authentication') {
      expect(definition.body.trimStart().startsWith('{{')).toBe(false)
    }
    expect(definition.body.trimEnd().endsWith('}}')).toBe(false)
  })

  it('has exactly one authentication template', () => {
    // The exemption above is scoped by category, so this count is what stops it
    // widening: a second authentication template would inherit a pass on the
    // leading-placeholder check without anyone deciding that it should.
    expect(entries.filter(([, d]) => d.category === 'authentication')).toHaveLength(1)
  })

  it.each(entries)('%s: no two placeholders are adjacent', (_name, definition) => {
    // Also a submission-time rejection: Meta requires literal text between
    // parameters so a reviewer can tell what the message says.
    expect(/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(definition.body)).toBe(false)
  })

  it.each(entries)('%s: name matches its key and is lowercase with underscores', (name, definition) => {
    expect(definition.name).toBe(name)
    expect(definition.name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it.each(entries)('%s: writes apostrophes typographically, never as U+0027', (_name, definition) => {
    // This repo writes U+2019 in the strings a person reads, and a body here is
    // read by every attendee. The straight quote is what a keyboard produces,
    // so it is what slips in — and once submitted it is another approval round.
    expect(definition.body).not.toContain("'")
  })

  it('sends no marketing templates', () => {
    // Marketing is ~₹0.8631 against ~₹0.115, and this product has nothing to
    // market. A marketing template appearing here is a costing bug.
    expect(entries.filter(([, d]) => d.category === 'marketing')).toHaveLength(0)
  })

  it('keeps auth_otp free of the things authentication templates forbid', () => {
    const { body, category } = TEMPLATES.auth_otp
    expect(category).toBe('authentication')
    expect(body).not.toMatch(/https?:\/\//)
    // Emoji and other non-ASCII are rejected in authentication bodies.
    expect(body).toMatch(/^[\x20-\x7E{}\n]*$/)
  })
})

describe('the two templates Phase 5a and 5b needed', () => {
  it('offers a waitlist seat without mentioning money', () => {
    // One template serves both paths — pay online, or claim a cash/free seat.
    // Naming an amount would need two templates and two approval rounds.
    // Shuffled relative to the declared order, the same way the
    // templateComponents fixture below is. Written in declared order this
    // assertion is blind to the one shortcut it exists to catch: a
    // renderTemplate that substitutes by the caller's key order renders this
    // sentence identically, and only differs on the call sites that happen to
    // pass their keys in some other order.
    const rendered = renderTemplate('waitlist_seat_offered', {
      deadline: '13 Aug 2026, 7:00 pm',
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
    })
    expect(rendered).toBe(
      'Hi Asha, a seat opened up for Diwali Supper. It’s held for you until ' +
        '13 Aug 2026, 7:00 pm — open your booking to take it.',
    )
    // Asserted as escapes, not as literals: a body and its expected string can
    // drift to ASCII together and the equality above stays green. A codepoint
    // cannot be wrong and look right.
    expect(rendered).toContain('\u2019')
    expect(rendered).toContain('\u2014')
    expect(rendered).not.toMatch(/₹|\bpay\b/i)
  })

  it('declines a request without claiming a booking was cancelled', () => {
    const rendered = renderTemplate('request_declined', {
      eventTitle: 'Diwali Supper',
      attendeeName: 'Asha',
    })
    expect(rendered).toBe(
      'Hi Asha, Diwali Supper is full this time and the host couldn’t fit you in. ' +
        'You’ll see other events from them soon.',
    )
    expect(rendered).toContain('\u2019')
    // The whole reason this template exists rather than reusing
    // booking_cancelled: nothing was ever booked.
    expect(rendered).not.toMatch(/cancel/i)
  })
})

describe('rendering', () => {
  it('passes components in the template order, not the object order', () => {
    // The object is deliberately shuffled relative to the declared order.
    expect(
      templateComponents('booking_confirmed', {
        bookingReference: 'VYRB4SHQ',
        venue: 'The Terrace',
        attendeeName: 'Asha',
        eventDateTime: '12 Aug 2026, 7:00 pm',
        eventTitle: 'Diwali Supper',
      }),
    ).toEqual(['Asha', 'Diwali Supper', '12 Aug 2026, 7:00 pm', 'The Terrace', 'VYRB4SHQ'])
  })

  it('throws rather than sending a message with a hole in it', () => {
    expect(() =>
      renderTemplate('request_declined', { attendeeName: 'Asha' }),
    ).toThrow('missing variable "eventTitle"')
  })
})
