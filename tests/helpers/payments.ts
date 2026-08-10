import { vi } from 'vitest'
import type { PaymentProvider, ProviderPayment } from '@/lib/payments/provider'

/** A PaymentProvider of vi.fn()s with happy-path defaults; override per test. */
export function fakeProvider(overrides: Partial<PaymentProvider> = {}): PaymentProvider {
  return {
    createOrder: vi.fn(async () => ({ orderId: 'order_test_1' })),
    listOrderPayments: vi.fn(async (): Promise<ProviderPayment[]> => []),
    createRefund: vi.fn(async () => ({ refundId: 'rfnd_test_1', status: 'pending' as const })),
    verifyWebhookSignature: vi.fn(() => true),
    verifyCheckoutSignature: vi.fn(() => true),
    ...overrides,
  }
}
