import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Kept out of notifications.test.ts because the factory is the only thing in
 * this folder that reads the environment. Testing it needs a file-wide
 * vi.mock('@/lib/env') and a cache reset between tests, and neither belongs on
 * that file's pure template-registry and phone-normalisation tests.
 *
 * The mock is a mutable object for the same reason meta.test.ts uses one:
 * serverEnv() memoises its parse (lib/env.ts), so mutating process.env after
 * the first read changes nothing.
 */
const env: { WHATSAPP_PROVIDER: string } = { WHATSAPP_PROVIDER: 'log' }
vi.mock('@/lib/env', () => ({ serverEnv: () => env }))

const { __setNotificationProvider, notificationProvider } = await import('@/lib/notifications')
const { LogNotificationProvider } = await import('@/lib/notifications/providers/log')
const { MetaNotificationProvider } = await import('@/lib/notifications/providers/meta')

beforeEach(() => {
  // notificationProvider() memoises into a module-level variable, so without
  // this reset every test after the first would be handed the first test's
  // provider and would pass no matter what the switch does.
  __setNotificationProvider(undefined)
  env.WHATSAPP_PROVIDER = 'log'
})

describe('notificationProvider', () => {
  it('builds the Meta adapter when WHATSAPP_PROVIDER=meta', () => {
    env.WHATSAPP_PROVIDER = 'meta'

    const provider = notificationProvider()

    // Both, deliberately. `name` alone would accept any object carrying the
    // right string; the instance check alone would not catch a class whose
    // name field drifted away from the value written to message_log.provider.
    expect(provider).toBeInstanceOf(MetaNotificationProvider)
    expect(provider.name).toBe('meta')
  })

  it('still defaults to the log provider, so the app runs without a WABA', () => {
    const provider = notificationProvider()

    expect(provider).toBeInstanceOf(LogNotificationProvider)
    expect(provider.name).toBe('log')
  })

  it('memoises, so every caller shares one provider', () => {
    env.WHATSAPP_PROVIDER = 'meta'

    expect(notificationProvider()).toBe(notificationProvider())
  })

  it('refuses aisensy and says why the enum member is still there', () => {
    env.WHATSAPP_PROVIDER = 'aisensy'

    expect(() => notificationProvider()).toThrow(/aisensy/)
    expect(() => notificationProvider()).toThrow(/platform fee/)
  })

  it('rejects a provider name that is not in the enum', () => {
    env.WHATSAPP_PROVIDER = 'twilio'

    expect(() => notificationProvider()).toThrow(/Unknown WHATSAPP_PROVIDER: twilio/)
  })
})
