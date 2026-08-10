import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/env'
import type {
  CreateOrderInput,
  CreatedRefund,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderPaymentStatus,
} from '@/lib/payments/provider'

/**
 * The Razorpay adapter: plain fetch, HTTP basic auth, four endpoints, no SDK
 * (the qrcode runtime-weight lesson). Razorpay's signature scheme is its own —
 * HMAC-SHA256 hex over the raw body (webhook secret) or over
 * `order_id|payment_id` (key secret) — NOT standardwebhooks, which serves the
 * Supabase SMS hook and stays there.
 *
 * Verified against razorpay.com/docs on 2026-08-10; the contract table in
 * docs/plans/2026-08-10-phase-3-payments.md holds the citations.
 */

const BASE_URL = 'https://api.razorpay.com/v1'

export class RazorpayConfigError extends Error {
  constructor() {
    super(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET in .env.local.',
    )
    this.name = 'RazorpayConfigError'
  }
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

/** Constant-time comparison; a length mismatch answers false rather than throwing. */
function safeEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

const PAYMENT_STATUSES = new Set<ProviderPaymentStatus>([
  'created',
  'authorized',
  'captured',
  'refunded',
  'failed',
])

function toProviderPayment(item: unknown): ProviderPayment {
  const record = item as Record<string, unknown>
  const status = record.status as ProviderPaymentStatus
  if (
    typeof record.id !== 'string' ||
    typeof record.order_id !== 'string' ||
    typeof record.amount !== 'number' ||
    !PAYMENT_STATUSES.has(status)
  ) {
    throw new Error(`Razorpay returned a payment entity this adapter does not recognise: ${JSON.stringify(item).slice(0, 200)}`)
  }
  return {
    paymentId: record.id,
    orderId: record.order_id,
    amountPaise: record.amount,
    status,
    method: typeof record.method === 'string' ? record.method : null,
    errorCode: typeof record.error_code === 'string' ? record.error_code : null,
    errorDescription: typeof record.error_description === 'string' ? record.error_description : null,
  }
}

export function razorpayProvider(): PaymentProvider {
  const env = serverEnv()
  const keyId = env.RAZORPAY_KEY_ID
  const keySecret = env.RAZORPAY_KEY_SECRET
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET
  if (!keyId || !keySecret || !webhookSecret) throw new RazorpayConfigError()

  const authorization = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64')

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Razorpay ${method} ${path} answered ${response.status}: ${detail.slice(0, 500)}`)
    }
    return (await response.json()) as T
  }

  return {
    async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
      const order = await request<{ id: string }>('POST', '/orders', {
        amount: input.amountPaise,
        currency: 'INR',
        receipt: input.receipt,
        notes: input.notes ?? {},
      })
      return { orderId: order.id }
    },

    async listOrderPayments(orderId: string): Promise<ProviderPayment[]> {
      const collection = await request<{ items?: unknown[] }>('GET', `/orders/${orderId}/payments`)
      return (collection.items ?? []).map(toProviderPayment)
    },

    async createRefund(providerPaymentId, input = {}): Promise<CreatedRefund> {
      // No `amount` key on purpose: omitting it is Razorpay's full refund.
      // `speed` is explicit because the docs disagree about the default.
      const refund = await request<{ id: string; status: string }>(
        'POST',
        `/payments/${providerPaymentId}/refund`,
        { speed: 'normal', notes: input.notes ?? {} },
      )
      const status = refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending'
      return { refundId: refund.id, status }
    },

    verifyWebhookSignature(rawBody: string, signature: string): boolean {
      return safeEqual(hmacHex(webhookSecret, rawBody), signature)
    },

    verifyCheckoutSignature(input): boolean {
      return safeEqual(hmacHex(keySecret, `${input.orderId}|${input.paymentId}`), input.signature)
    },
  }
}
