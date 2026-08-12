import { serverEnv } from '@/lib/env'
import { LogNotificationProvider } from '@/lib/notifications/providers/log'
import { MetaNotificationProvider } from '@/lib/notifications/providers/meta'
import type { NotificationProvider } from '@/lib/notifications/types'

export * from '@/lib/notifications/types'
export * from '@/lib/notifications/templates'

let cached: NotificationProvider | undefined

/**
 * Resolves the configured WhatsApp provider.
 *
 * Defaults to the log provider so the app is fully runnable before the
 * WhatsApp Business Account exists. Phase 4 added the Meta Cloud API adapter
 * here — and only that one; nothing that calls send() has to change.
 */
export function notificationProvider(): NotificationProvider {
  if (cached) return cached

  const configured = serverEnv().WHATSAPP_PROVIDER

  switch (configured) {
    case 'log':
      cached = new LogNotificationProvider()
      break
    case 'meta':
      cached = new MetaNotificationProvider()
      break
    case 'aisensy':
      throw new Error(
        'WHATSAPP_PROVIDER="aisensy" is not implemented. Phase 4 went to the Meta ' +
          'Cloud API direct, because a BSP\'s monthly platform fee is not in this ' +
          "product's per-message costing. The enum member stays as a documented " +
          'escape hatch if Facebook Business verification ever stalls.',
      )
    default: {
      const exhaustive: never = configured
      throw new Error(`Unknown WHATSAPP_PROVIDER: ${String(exhaustive)}`)
    }
  }

  return cached
}

/** Test seam. */
export function __setNotificationProvider(provider: NotificationProvider | undefined): void {
  cached = provider
}
