import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeProvider } from '@/tests/helpers/payments'

vi.mock('@/lib/payments/razorpay', () => {
  class RazorpayConfigError extends Error {}
  return { RazorpayConfigError, razorpayProvider: vi.fn() }
})
vi.mock('@/lib/payments/service', () => ({ processWebhookEvent: vi.fn() }))

const { razorpayProvider, RazorpayConfigError } = vi.mocked(await import('@/lib/payments/razorpay'))
const { processWebhookEvent } = vi.mocked(await import('@/lib/payments/service'))
const { POST } = await import('@/app/api/webhooks/razorpay/route')

const BODY = JSON.stringify({ event: 'payment.captured', payload: {} })

function post(input: { body?: string; signature?: string | null; eventId?: string | null } = {}): Promise<Response> {
  const headers = new Headers()
  if (input.signature !== null) headers.set('x-razorpay-signature', input.signature ?? 'sig')
  if (input.eventId !== null) headers.set('x-razorpay-event-id', input.eventId ?? 'evt_1')
  return POST(new Request('http://localhost:3100/api/webhooks/razorpay', { method: 'POST', body: input.body ?? BODY, headers }))
}

beforeEach(() => {
  vi.clearAllMocks()
  razorpayProvider.mockReturnValue(fakeProvider())
  processWebhookEvent.mockResolvedValue('processed')
})

describe('POST /api/webhooks/razorpay', () => {
  it('verifies the signature over the RAW body and processes', async () => {
    const provider = fakeProvider()
    razorpayProvider.mockReturnValue(provider)

    const response = await post()

    expect(response.status).toBe(200)
    expect(provider.verifyWebhookSignature).toHaveBeenCalledWith(BODY, 'sig')
    expect(processWebhookEvent).toHaveBeenCalledWith({
      providerEventId: 'evt_1',
      eventType: 'payment.captured',
      payload: JSON.parse(BODY),
    })
  })

  it('answers 401 to a bad signature and writes nothing', async () => {
    razorpayProvider.mockReturnValue(fakeProvider({ verifyWebhookSignature: vi.fn(() => false) }))

    const response = await post()

    expect(response.status).toBe(401)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 401 when the signature header is missing', async () => {
    const response = await post({ signature: null })
    expect(response.status).toBe(401)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 400 when the event id header is missing', async () => {
    const response = await post({ eventId: null })
    expect(response.status).toBe(400)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 400 to an unparseable body', async () => {
    const response = await post({ body: 'not json' })
    expect(response.status).toBe(400)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })

  it('answers 200 to a duplicate without reprocessing side effects', async () => {
    processWebhookEvent.mockResolvedValue('duplicate')
    const response = await post()
    expect(response.status).toBe(200)
  })

  it('answers 500 when processing throws, so Razorpay redelivers', async () => {
    processWebhookEvent.mockRejectedValue(new Error('half-processed'))
    const response = await post()
    expect(response.status).toBe(500)
  })

  it('answers 500 when Razorpay is not configured', async () => {
    razorpayProvider.mockImplementation(() => {
      throw new RazorpayConfigError()
    })
    const response = await post()
    expect(response.status).toBe(500)
    expect(processWebhookEvent).not.toHaveBeenCalled()
  })
})
