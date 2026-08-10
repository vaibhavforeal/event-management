import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaymentProvider, ProviderPayment } from '@/lib/payments/provider'
import type { Database } from '@/lib/supabase/types'
import type { SeededEvent } from '@/tests/helpers/db'

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

type Db = SupabaseClient<Database>
type BookingRow = Database['public']['Tables']['bookings']['Row']

let eventCounter = 0
function nextEventId(): string {
  eventCounter += 1
  return `evt_test_${Date.now()}_${eventCounter}`
}

/** A paid booking stopped at the hold, with its payments row — the state startPaidCheckout leaves. */
export async function seedPaidBooking(
  db: Db,
  seed: SeededEvent,
  opts: { quantity?: number; attendeeId?: string } = {},
): Promise<{ booking: BookingRow; orderId: string }> {
  const { data: booking, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: opts.attendeeId ?? seed.attendeeId,
    p_quantity: opts.quantity ?? 2,
    p_attendee_name: 'Asha',
  })
  if (error) throw new Error(`seedPaidBooking: ${error.message}`)
  const orderId = `order_${booking.reference}`
  const { error: insertError } = await db.from('payments').insert({
    booking_id: booking.id,
    provider: 'razorpay',
    provider_order_id: orderId,
    amount_paise: booking.total_paise,
    status: 'created',
  })
  if (insertError) throw new Error(`seedPaidBooking payments row: ${insertError.message}`)
  return { booking, orderId }
}

export function capturedEvent(input: { orderId: string; paymentId?: string; amountPaise: number; eventId?: string }) {
  return {
    eventId: input.eventId ?? nextEventId(),
    eventType: 'payment.captured',
    payload: {
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment.captured',
      contains: ['payment'],
      created_at: 1_770_000_000,
      payload: {
        payment: {
          entity: {
            id: input.paymentId ?? 'pay_test_1',
            order_id: input.orderId,
            amount: input.amountPaise,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
            error_code: null,
            error_description: null,
          },
        },
      },
    },
  }
}

export function failedEvent(input: {
  orderId: string
  paymentId?: string
  errorCode?: string
  errorDescription?: string
  eventId?: string
}) {
  return {
    eventId: input.eventId ?? nextEventId(),
    eventType: 'payment.failed',
    payload: {
      entity: 'event',
      account_id: 'acc_test',
      event: 'payment.failed',
      contains: ['payment'],
      created_at: 1_770_000_000,
      payload: {
        payment: {
          entity: {
            id: input.paymentId ?? 'pay_test_failed_1',
            order_id: input.orderId,
            amount: 0,
            currency: 'INR',
            status: 'failed',
            method: 'upi',
            error_code: input.errorCode ?? 'BAD_REQUEST_ERROR',
            error_description: input.errorDescription ?? 'Payment failed',
          },
        },
      },
    },
  }
}

export function refundEvent(
  kind: 'processed' | 'failed',
  input: { refundId: string; paymentId: string; amountPaise: number; eventId?: string },
) {
  return {
    eventId: input.eventId ?? nextEventId(),
    eventType: `refund.${kind}`,
    payload: {
      entity: 'event',
      account_id: 'acc_test',
      event: `refund.${kind}`,
      contains: ['refund'],
      created_at: 1_770_000_000,
      payload: {
        refund: {
          entity: {
            id: input.refundId,
            payment_id: input.paymentId,
            amount: input.amountPaise,
            currency: 'INR',
            status: kind === 'processed' ? 'processed' : 'failed',
          },
        },
      },
    },
  }
}
