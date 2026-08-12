import { serverEnv } from '@/lib/env'
import { TEMPLATES, templateComponents } from '@/lib/notifications/templates'
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
 * Utility templates send BODY PARAMETERS ONLY. Authentication templates send a
 * body component AND a button component carrying the same code, because Meta
 * requires a buttons component on every authentication template and rejects a
 * payload that omits the matching component at send time. See the note in
 * lib/notifications/templates.ts for why a buttonless authentication template
 * is not available to us.
 *
 * The two shapes are chosen by the template's CATEGORY, never by its name. A
 * name check would be a list to keep in sync with the registry; the category
 * is already the thing that decides the wire format, and the registry is its
 * only source.
 */

/**
 * Pinned rather than floating: Meta ships breaking changes between versions,
 * and a silently-moving URL is a silently-changing payload contract.
 *
 * **Available until 29 July 2028.** The expiry is in this comment because a
 * pin without one stops pinning on a date nobody wrote down: Meta routes
 * calls to an expired version onto the next-oldest usable one *silently*, so
 * the failure is not an error but a different contract than this file claims.
 * Bump before that date, and move the date with it.
 */
const GRAPH_VERSION = 'v25.0'

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
      // templateComponents returns the values in the template's declared order,
      // which is what positional {{1}}, {{2}} … means. Building this from
      // Object.values(variables) instead would be correct until someone
      // reorders the object literal.
      const values = templateComponents(message.template, message.variables)
      const components: unknown[] = [
        { type: 'body', parameters: values.map((text) => ({ type: 'text', text })) },
      ]

      if (TEMPLATES[message.template].category === 'authentication') {
        // The code, a second time. Meta's copy-code button carries the value it
        // copies, so the same string appears in both components — and a send
        // that omits this one is rejected outright rather than degraded, which
        // on the OTP path means nobody can log in.
        //
        // `index` is a string because Meta's example quotes it, and this is
        // JSON on the wire where '0' and 0 are different tokens. Meta's own
        // body is the fixed one-parameter "{{1}} is your verification code.",
        // so values[0] is the code.
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: values[0] }],
        })
      }

      body = JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: message.to,
        type: 'template',
        template: {
          name: message.template,
          language: { code: TEMPLATE_LANGUAGE },
          components,
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
