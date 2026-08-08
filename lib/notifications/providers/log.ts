import { renderTemplate } from '@/lib/notifications/templates'
import type { NotificationProvider, OutboundMessage, SendResult } from '@/lib/notifications/types'

/**
 * Development provider. Prints what would have been sent.
 *
 * This is the default (WHATSAPP_PROVIDER=log) so the whole app runs end to end
 * before the WhatsApp Business Account is approved — which is the point of
 * ordering Phase 2 before Phase 4.
 */
export class LogNotificationProvider implements NotificationProvider {
  readonly name = 'log'

  /** Everything "sent", for assertions in tests. */
  readonly sent: Array<OutboundMessage & { body: string }> = []

  async send(message: OutboundMessage): Promise<SendResult> {
    const body = renderTemplate(message.template, message.variables)
    this.sent.push({ ...message, body })

    console.info(
      `[whatsapp:log] -> ${message.to} (${message.template})\n${body}\n` +
        `  dedupeKey=${message.dedupeKey}`,
    )

    return {
      status: 'sent',
      providerMessageId: `log-${message.dedupeKey}`,
    }
  }
}
