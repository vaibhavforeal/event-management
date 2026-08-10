import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { razorpayProvider as RazorpayProviderFn } from '@/lib/payments/razorpay'

const BASE_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3100',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  SEND_SMS_HOOK_SECRET: 'test-sms-secret',
  TICKET_SIGNING_SECRET: 't'.repeat(32),
}

const KEYS = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'checkout-secret',
  RAZORPAY_WEBHOOK_SECRET: 'webhook-secret',
}

async function loadProvider(extra: Record<string, string>) {
  vi.resetModules()
  vi.unstubAllEnvs()
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...extra })) vi.stubEnv(name, value)
  const mod = await import('@/lib/payments/razorpay')
  return mod as { razorpayProvider: typeof RazorpayProviderFn; RazorpayConfigError: typeof Error }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('configuration', () => {
  it('throws RazorpayConfigError when any of the three vars is missing', async () => {
    const { razorpayProvider, RazorpayConfigError } = await loadProvider({
      ...KEYS,
      RAZORPAY_WEBHOOK_SECRET: '',
    })
    expect(() => razorpayProvider()).toThrow(RazorpayConfigError)
  })
})

describe('signatures', () => {
  it('accepts the true webhook signature and rejects tampering', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const provider = razorpayProvider()
    const body = JSON.stringify({ event: 'payment.captured', payload: {} })
    const signature = createHmac('sha256', KEYS.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex')

    expect(provider.verifyWebhookSignature(body, signature)).toBe(true)
    expect(provider.verifyWebhookSignature(body + ' ', signature)).toBe(false) // tampered body
    const wrongSecret = createHmac('sha256', 'not-the-secret').update(body).digest('hex')
    expect(provider.verifyWebhookSignature(body, wrongSecret)).toBe(false)
    expect(provider.verifyWebhookSignature(body, 'too-short')).toBe(false) // length mismatch must not throw
  })

  it('verifies the checkout signature over order_id|payment_id with the key secret', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const provider = razorpayProvider()
    const signature = createHmac('sha256', KEYS.RAZORPAY_KEY_SECRET).update('order_1|pay_1').digest('hex')

    expect(provider.verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature })).toBe(true)
    expect(provider.verifyCheckoutSignature({ orderId: 'order_2', paymentId: 'pay_1', signature })).toBe(false)
  })
})

describe('REST calls', () => {
  it('creates an order with basic auth, INR, and the receipt', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const fetchMock = vi.fn(async () => Response.json({ id: 'order_test_1' }))
    vi.stubGlobal('fetch', fetchMock)

    const order = await razorpayProvider().createOrder({ amountPaise: 100_000, receipt: 'G09SPK0K' })

    expect(order).toEqual({ orderId: 'order_test_1' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.razorpay.com/v1/orders')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from('rzp_test_key:checkout-secret').toString('base64'),
    )
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 100_000,
      currency: 'INR',
      receipt: 'G09SPK0K',
      notes: {},
    })
  })

  it('lists an order\'s payments and normalises the entity', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({
        entity: 'collection',
        count: 1,
        items: [{
          id: 'pay_1', order_id: 'order_1', amount: 100_000, status: 'captured',
          method: 'upi', error_code: null, error_description: null,
        }],
      }),
    ))

    const payments = await razorpayProvider().listOrderPayments('order_1')

    expect(payments).toEqual([{
      paymentId: 'pay_1', orderId: 'order_1', amountPaise: 100_000, status: 'captured',
      method: 'upi', errorCode: null, errorDescription: null,
    }])
  })

  it('creates a FULL refund: no amount key, speed normal', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    const fetchMock = vi.fn(async () => Response.json({ id: 'rfnd_1', status: 'pending' }))
    vi.stubGlobal('fetch', fetchMock)

    const refund = await razorpayProvider().createRefund('pay_1')

    expect(refund).toEqual({ refundId: 'rfnd_1', status: 'pending' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund')
    const body = JSON.parse(init.body as string)
    expect(body.speed).toBe('normal')
    expect('amount' in body).toBe(false)
  })

  it('surfaces a non-2xx answer as an error naming the endpoint and status', async () => {
    const { razorpayProvider } = await loadProvider(KEYS)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { description: 'Authentication failed' } }), { status: 401 }),
    ))

    await expect(razorpayProvider().createOrder({ amountPaise: 100, receipt: 'X' })).rejects.toThrow(
      /POST \/orders answered 401/,
    )
  })
})
