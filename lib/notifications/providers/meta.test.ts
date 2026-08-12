import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '@/lib/notifications/types'

/**
 * serverEnv() caches its parse in a module-level variable (lib/env.ts), so
 * mutating process.env after the first read changes nothing. Mocking the
 * module is the only way to vary credentials per test — and it also keeps
 * this file from needing a real .env at all.
 */
const env = { WHATSAPP_API_KEY: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '111222333' }
vi.mock('@/lib/env', () => ({ serverEnv: () => env }))

const { MetaNotificationProvider } = await import('@/lib/notifications/providers/meta')

const OK_BODY = {
  messaging_product: 'whatsapp',
  contacts: [{ input: '+919876543210', wa_id: '919876543210' }],
  messages: [{ id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSN' }],
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * These keys are DELIBERATELY not in the template's declared order.
 *
 * `variables` is a Record, so nothing about the call site constrains its
 * insertion order — a caller building one from a database row or a spread is
 * free to emit any order at all. Written in template order, this fixture would
 * make `Object.values(variables)` — the exact shortcut the adapter warns
 * against — produce an identical payload, and the assertion below would pass
 * on an adapter that scrambles every real message.
 */
const message: OutboundMessage = {
  to: '+919876543210',
  template: 'booking_confirmed',
  variables: {
    venue: 'The Terrace',
    bookingReference: 'VYRB4SHQ',
    attendeeName: 'Asha',
    eventDateTime: '12 Aug 2026, 7:00 pm',
    eventTitle: 'Diwali Supper',
  },
  dedupeKey: 'booking:b-1:confirmed',
  bookingId: 'b-1',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  env.WHATSAPP_API_KEY = 'test-token'
  env.WHATSAPP_PHONE_NUMBER_ID = '111222333'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MetaNotificationProvider', () => {
  it('posts the exact shape Meta expects, with components in template order', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY))

    const result = await new MetaNotificationProvider().send(message)

    expect(result).toEqual({
      status: 'sent',
      providerMessageId: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSN',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v25.0/111222333/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    })

    // The whole payload, asserted exactly. A partial match here would let a
    // wrong `type`, a missing `messaging_product`, or components in the wrong
    // ORDER through — and positional {{n}} templates fail silently when the
    // order is wrong, producing a message with the venue where the name goes.
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+919876543210',
      type: 'template',
      template: {
        name: 'booking_confirmed',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Asha' },
              { type: 'text', text: 'Diwali Supper' },
              { type: 'text', text: '12 Aug 2026, 7:00 pm' },
              { type: 'text', text: 'The Terrace' },
              { type: 'text', text: 'VYRB4SHQ' },
            ],
          },
        ],
      },
    })
  })

  it('sends an authentication template with the code in the body AND the button', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY))

    const otp: OutboundMessage = {
      to: '+919876543210',
      template: 'auth_otp',
      variables: { otp: '482913' },
      dedupeKey: 'otp:+919876543210:1',
    }

    const result = await new MetaNotificationProvider().send(otp)
    expect(result).toMatchObject({ status: 'sent' })

    const [, init] = fetchMock.mock.calls[0]
    // The whole payload again, and for the same reason as above: this one is
    // the live login path, and the button component is exactly the kind of
    // thing a toMatchObject would let vanish. Meta requires the button on
    // every authentication template, so a body-only payload is rejected —
    // which would break OTP login on the first send after the provider flips
    // to meta, not gradually.
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+919876543210',
      type: 'template',
      template: {
        name: 'auth_otp',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          {
            type: 'button',
            sub_type: 'url',
            // A string, not the number 0. Meta's example writes it quoted and
            // this payload is JSON on the wire, where the two are not the same
            // token.
            index: '0',
            parameters: [{ type: 'text', text: '482913' }],
          },
        ],
      },
    })
  })

  it('sends a utility template with a body component and nothing else', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY))

    await new MetaNotificationProvider().send(message)

    const [, init] = fetchMock.mock.calls[0]
    const { components } = JSON.parse(init.body).template
    // The button is scoped to authentication by category. Bolting one onto a
    // utility send is rejected just as surely as omitting one from an
    // authentication send — the payload has to match what the template was
    // registered with, in both directions.
    expect(components).toHaveLength(1)
    expect(components[0].type).toBe('body')
    expect(JSON.stringify(components)).not.toContain('button')
  })

  it('reports a 5xx as retryable and does not throw', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { message: 'upstream' } }))

    const result = await new MetaNotificationProvider().send(message)

    expect(result.status).toBe('failed')
    expect(result.retryable).toBe(true)
    expect(result.error).toContain('upstream')
  })

  it('reports 429 as retryable — rate limiting is temporary', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'rate limit hit' } }))

    const result = await new MetaNotificationProvider().send(message)
    expect(result).toMatchObject({ status: 'failed', retryable: true })
  })

  it('reports a 4xx as NOT retryable — a bad template never becomes good', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: 'Template name does not exist', code: 132001 } }),
    )

    const result = await new MetaNotificationProvider().send(message)

    expect(result.status).toBe('failed')
    expect(result.retryable).toBe(false)
    expect(result.error).toContain('Template name does not exist')
    // The numeric code survives into the recorded error. It is what an operator
    // triages a dead-lettered row from — the prose alone is not searchable.
    expect(result.error).toContain('132001')
  })

  it('treats a network throw as retryable rather than letting it escape', async () => {
    // send() must never throw: the drain records a result per message, and one
    // unreachable host must not abort the rest of the batch.
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    const result = await new MetaNotificationProvider().send(message)
    expect(result).toMatchObject({ status: 'failed', retryable: true })
    expect(result.error).toContain('ECONNRESET')
  })

  it('refuses to send when the credentials are absent', async () => {
    env.WHATSAPP_API_KEY = undefined as unknown as string

    const result = await new MetaNotificationProvider().send(message)

    expect(result).toMatchObject({ status: 'failed', retryable: false })
    expect(result.error).toContain('WHATSAPP_API_KEY')
    // Nothing was attempted — a misconfigured server must not burn attempts.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a failure rather than throwing when a variable is missing', async () => {
    // templateComponents throws on a missing variable. send() must never throw
    // — a caller that built one bad message must not abort the whole batch —
    // and the same message is just as incomplete next tick, so: not retryable.
    const incomplete: OutboundMessage = { ...message, variables: { attendeeName: 'Asha' } }

    const result = await new MetaNotificationProvider().send(incomplete)

    expect(result).toMatchObject({ status: 'failed', retryable: false })
    expect(result.error).toContain('eventTitle')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a 200 that carries no message id as a failure', async () => {
    // Meta answering 200 with an unexpected body means we do not have a
    // provider_message_id to record. Calling that "sent" would lose the send.
    fetchMock.mockResolvedValue(jsonResponse(200, { messaging_product: 'whatsapp' }))

    const result = await new MetaNotificationProvider().send(message)
    expect(result).toMatchObject({ status: 'failed', retryable: true })
  })
})
