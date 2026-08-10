import { razorpayProvider } from '@/lib/payments/razorpay'
import { processWebhookEvent } from '@/lib/payments/service'
import type { PaymentProvider } from '@/lib/payments/provider'

/**
 * Razorpay's webhook door. POST only; the raw body is read BEFORE any parse,
 * because the signature covers the exact bytes on the wire
 * (app/api/hooks/send-sms/route.ts is the house precedent).
 *
 * Status codes are the contract with Razorpay's redelivery: 2xx swallows the
 * event forever, anything else retries. So a duplicate is 200 (we have it), a
 * bad signature is 401 (not Razorpay's voice), and a processing failure is
 * 500 ON PURPOSE — a retry is exactly what a half-processed event needs.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()

  let provider: PaymentProvider
  try {
    provider = razorpayProvider()
  } catch (error) {
    // A webhook is arriving at a server with no webhook secret: config drift.
    console.error('[razorpay-webhook] refused: Razorpay env vars missing', error)
    return Response.json({ error: 'not configured' }, { status: 500 })
  }

  const signature = request.headers.get('x-razorpay-signature')
  if (!signature || !provider.verifyWebhookSignature(rawBody, signature)) {
    return Response.json({ error: 'invalid signature' }, { status: 401 })
  }

  const providerEventId = request.headers.get('x-razorpay-event-id')
  if (!providerEventId) {
    return Response.json({ error: 'missing event id' }, { status: 400 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'unparseable body' }, { status: 400 })
  }

  const event = (payload as { event?: unknown }).event
  const eventType = typeof event === 'string' ? event : ''

  try {
    await processWebhookEvent({ providerEventId, eventType, payload })
  } catch (error) {
    console.error('[razorpay-webhook] processing failed; Razorpay will retry', error)
    return Response.json({ error: 'processing failed' }, { status: 500 })
  }

  return Response.json({ received: true })
}
