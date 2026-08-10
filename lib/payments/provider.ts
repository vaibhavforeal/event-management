/**
 * The payment-provider seam.
 *
 * The v1 doc designed this boundary for vendor change; Phase 3 uses it as the
 * mocked seam in every integration test — the service and the webhook route
 * speak only these types, and lib/payments/razorpay.ts is the one file that
 * knows what is on the wire. Amounts are integer paise throughout
 * (lib/money.ts's rule); statuses reuse Razorpay's five words because our
 * payment_status enum was built from them in Phase 0.
 */

export interface CreateOrderInput {
  amountPaise: number
  /** ≤ 40 chars, unique per order — the 8-char booking reference qualifies. */
  receipt: string
  notes?: Record<string, string>
}

export interface ProviderOrder {
  orderId: string
}

export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'

export interface ProviderPayment {
  paymentId: string
  orderId: string
  amountPaise: number
  status: ProviderPaymentStatus
  method: string | null
  errorCode: string | null
  errorDescription: string | null
}

export interface CreatedRefund {
  refundId: string
  status: 'pending' | 'processed' | 'failed'
}

export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<ProviderOrder>
  listOrderPayments(orderId: string): Promise<ProviderPayment[]>
  /** A FULL refund of the payment; Phase 3 has no partial refunds. */
  createRefund(providerPaymentId: string, input?: { notes?: Record<string, string> }): Promise<CreatedRefund>
  verifyWebhookSignature(rawBody: string, signature: string): boolean
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean
}
