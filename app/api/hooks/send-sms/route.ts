import { Webhook } from 'standardwebhooks'
import { serverEnv } from '@/lib/env'
import { notificationProvider } from '@/lib/notifications'
import { normalisePhone } from '@/lib/notifications/types'

/**
 * Supabase Auth "Send SMS" hook.
 *
 * Supabase generates the OTP and calls this endpoint instead of sending an SMS
 * itself, which lets us deliver the code over WhatsApp. That matters twice
 * over: WhatsApp authentication templates are ~₹0.115 against ₹0.12–0.25 for
 * DLT-registered SMS, and using WhatsApp sidesteps TRAI DLT registration
 * altogether.
 *
 * Configured in supabase/config.toml under [auth.hook.send_sms].
 *
 * Payload: { user: { phone, ... }, sms: { otp } }
 */

interface SendSmsHookPayload {
  user: { id: string; phone?: string }
  sms: { otp: string }
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text()

  let payload: SendSmsHookPayload
  try {
    // Supabase signs the request with the Standard Webhooks scheme. The
    // configured secret carries a "v1,whsec_" prefix that the library does not
    // expect, so strip it.
    const secret = serverEnv().SEND_SMS_HOOK_SECRET.replace(/^v1,whsec_/, '')
    const webhook = new Webhook(secret)
    payload = webhook.verify(
      rawBody,
      Object.fromEntries(request.headers),
    ) as SendSmsHookPayload
  } catch (error) {
    // An unverifiable payload is either a misconfiguration or someone probing
    // the endpoint. Either way, do not send anything.
    console.error('[send-sms] signature verification failed', error)
    return Response.json({ error: 'invalid signature' }, { status: 401 })
  }

  const phone = payload.user?.phone
  const otp = payload.sms?.otp

  if (!phone || !otp) {
    return Response.json({ error: 'payload missing phone or otp' }, { status: 400 })
  }

  try {
    const result = await notificationProvider().send({
      to: normalisePhone(phone),
      template: 'auth_otp',
      variables: { otp },
      // OTPs are intentionally NOT deduped across attempts — a user who did not
      // receive the first code must be able to request another, and a stable
      // key would make the second request a no-op. This path sends straight
      // through the provider and writes no message_log row, so the key is never
      // persisted; the timestamp is here to keep it from ever colliding if it
      // one day is.
      dedupeKey: `otp:${payload.user.id}:${Date.now()}`,
    })

    if (result.status === 'failed') {
      // Returning an error tells Supabase the OTP was not delivered, so it does
      // not leave the user waiting for a code that will never arrive.
      return Response.json(
        { error: { http_code: 502, message: result.error ?? 'delivery failed' } },
        { status: 502 },
      )
    }

    return Response.json({})
  } catch (error) {
    console.error('[send-sms] delivery threw', error)
    return Response.json(
      {
        error: {
          http_code: 500,
          message: error instanceof Error ? error.message : 'unknown error',
        },
      },
      { status: 500 },
    )
  }
}
