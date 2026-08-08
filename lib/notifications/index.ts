import { serverEnv } from '@/lib/env'
import { LogNotificationProvider } from '@/lib/notifications/providers/log'
import type { NotificationProvider } from '@/lib/notifications/types'

export * from '@/lib/notifications/types'
export * from '@/lib/notifications/templates'

let cached: NotificationProvider | undefined

/**
 * Resolves the configured WhatsApp provider.
 *
 * Defaults to the log provider so the app is fully runnable before the
 * WhatsApp Business Account exists. Phase 4 adds the Meta Cloud API and BSP
 * adapters here; nothing that calls send() has to change.
 */
export function notificationProvider(): NotificationProvider {
  if (cached) return cached

  const configured = serverEnv().WHATSAPP_PROVIDER

  switch (configured) {
    case 'log':
      cached = new LogNotificationProvider()
      break
    case 'meta':
    case 'aisensy':
      throw new Error(
        `WHATSAPP_PROVIDER="${configured}" is not implemented yet (Phase 4). ` +
          'Use "log" until the WhatsApp Business Account is approved.',
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
