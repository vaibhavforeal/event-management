import { serverEnv } from '@/lib/env'
import { templateComponents } from '@/lib/notifications/templates'
import type { NotificationProvider, OutboundMessage, SendResult } from '@/lib/notifications/types'

/**
 * The Meta Cloud API, direct.
 *
 * Direct rather than through a BSP because the per-message economics this
 * product is costed on — ~₹0.115 for an authentication or utility template,
 * utility free inside an open 24-hour service window — are Meta's list price,
 * and a BSP adds a monthly platform fee on top of them.
 *
 * The only module in the repo that knows Meta's wire format. Everything else
 * speaks OutboundMessage.
 *
 * Sends BODY PARAMETERS ONLY. If a template is registered with a copy-code or
 * one-tap button, Meta rejects a payload that omits the matching button
 * component — so auth_otp must be registered as a plain authentication
 * template with no button. See the note in lib/notifications/templates.ts.
 */

/** Pinned rather than floating: Meta ships breaking changes between versions,
 *  and a silently-moving URL is a silently-changing payload contract. */
const GRAPH_VERSION = 'v21.0'

/** The language a template is registered under. Templates are per-language in
 *  Meta's registry, so this must match what was submitted or the send 404s. */
const TEMPLATE_LANGUAGE = 'en'

export class MetaNotificationProvider implements NotificationProvider {
  readonly name = 'meta'

  /**
   * Never throws. The drain records an outcome per message and one
   * unreachable host must not abort the rest of the batch — so every failure
   * path returns a SendResult instead.
   *
   * The serverEnv() call below is the only statement here outside a try, and
   * it cannot throw at this point: notificationProvider() reads serverEnv() in
   * order to decide on this class at all, and lib/env.ts memoises the parse —
   * so by the time send() runs, that parse has already succeeded once.
   */
  async send(message: OutboundMessage): Promise<SendResult> {
    const env = serverEnv()
    const token = env.WHATSAPP_API_KEY
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID

    // Both are optional in the schema because the app runs on the log provider
    // long before a WABA exists. Reaching here without them is config drift,
    // and retrying config drift never helps.
    if (!token || !phoneNumberId) {
      return {
        status: 'failed',
        retryable: false,
        error:
          'WHATSAPP_API_KEY and WHATSAPP_PHONE_NUMBER_ID must be set when WHATSAPP_PROVIDER=meta',
      }
    }

    let body: string
    try {
      body = JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: message.to,
        type: 'template',
        template: {
          name: message.template,
          language: { code: TEMPLATE_LANGUAGE },
          components: [
            {
              type: 'body',
              // templateComponents returns the values in the template's declared
              // order, which is what positional {{1}}, {{2}} … means. Building
              // this from Object.values(variables) instead would be correct
              // until someone reorders the object literal.
              parameters: templateComponents(message.template, message.variables).map((text) => ({
                type: 'text',
                text,
              })),
            },
          ],
        },
      })
    } catch (cause) {
      // templateComponents throws on a missing variable. That is a caller bug,
      // not weather — the same message will be just as incomplete next tick.
      return {
        status: 'failed',
        retryable: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    let response: Response
    try {
      response = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        },
      )
    } catch (cause) {
      // DNS, TLS, connection reset. All of them are worth another tick.
      return {
        status: 'failed',
        retryable: true,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    const payload = (await response.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } }
      | null

    if (!response.ok) {
      // 429 is rate limiting and 5xx is Meta having a bad day; both pass. Every
      // other 4xx is a statement about the request — a template that is not
      // approved, a number not on WhatsApp, an expired token — and repeating
      // it changes nothing.
      const retryable = response.status === 429 || response.status >= 500
      // Keep the numeric code. It is what an operator triages a dead-lettered
      // row from; "Template name does not exist" on its own turns a lookup in
      // Meta's error reference into a search.
      const detail = payload?.error?.message ?? `Meta returned ${response.status}`
      const code = payload?.error?.code
      return {
        status: 'failed',
        retryable,
        error: code === undefined ? detail : `${detail} (Meta code ${code})`,
      }
    }

    const providerMessageId = payload?.messages?.[0]?.id
    if (!providerMessageId) {
      // A 200 whose message id we cannot record. Retryable on purpose, and the
      // trade is explicit: a retry may deliver the message twice, because
      // nothing downstream can tell whether the first attempt landed. The
      // dedupe key does not help — it is unique per message_log ROW, so it
      // stops a duplicate enqueue, not the drain re-attempting this same row.
      //
      // We take that risk because a send lost in silence is worse than a rare
      // duplicate, and the only thing that gets us here is Meta changing its
      // response shape.
      return {
        status: 'failed',
        retryable: true,
        error: 'Meta returned 200 with no message id',
      }
    }

    return { status: 'sent', providerMessageId }
  }
}
