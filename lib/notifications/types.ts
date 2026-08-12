import type { TemplateName } from '@/lib/notifications/templates'

export interface OutboundMessage {
  /** E.164, e.g. +919876543210. */
  to: string
  template: TemplateName
  variables: Record<string, string>
  /**
   * Natural key for this send, e.g. `booking:<id>:confirmed`. Persisted with a
   * unique constraint so a retried job cannot message someone twice.
   */
  dedupeKey: string
  bookingId?: string
}

export interface SendResult {
  status: 'sent' | 'failed' | 'skipped_duplicate'
  providerMessageId?: string
  error?: string
  /**
   * Whether trying again could plausibly succeed. The drain sends a
   * non-retryable failure straight to `dead` rather than spending five
   * attempts discovering that a template name is still wrong.
   *
   * Optional because `status: 'sent'` has nothing to say about it, and
   * because the log provider never fails.
   */
  retryable?: boolean
}

/**
 * The seam between us and whichever WhatsApp vendor we are on.
 *
 * We start on a BSP for speed of onboarding and expect to move to the Meta
 * Cloud API direct once volume justifies dropping the platform fee. Callers
 * must never learn which one is in play.
 */
export interface NotificationProvider {
  readonly name: string
  send(message: OutboundMessage): Promise<SendResult>
}

export class NotificationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'NotificationError'
  }
}

/** Normalises Indian numbers to E.164, which is what WhatsApp requires. */
export function normalisePhone(input: string, defaultCountryCode = '91'): string {
  const digits = input.replace(/[^\d+]/g, '')

  if (digits.startsWith('+')) return digits

  // 10-digit local Indian mobile.
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`
  // 0-prefixed STD form.
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+${defaultCountryCode}${digits.slice(1)}`
  }
  // Already has the country code but no plus.
  if (digits.length === 12 && digits.startsWith(defaultCountryCode)) return `+${digits}`

  throw new NotificationError(`Cannot normalise "${input}" to E.164`, false)
}
