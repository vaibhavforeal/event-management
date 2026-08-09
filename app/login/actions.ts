'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/auth/next-path'
import { normalisePhone } from '@/lib/notifications/types'

export interface LoginState {
  step: 'phone' | 'otp'
  phone?: string
  error?: string
}

const phoneSchema = z.string().min(6).max(20)
const otpSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code')

/**
 * Step 1 — send the code.
 *
 * Supabase generates the OTP and hands it to our send_sms hook, which delivers
 * it over WhatsApp. See app/api/hooks/send-sms/route.ts.
 */
export async function requestOtp(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const raw = phoneSchema.safeParse(formData.get('phone'))
  if (!raw.success) {
    return { step: 'phone', error: 'Enter your phone number' }
  }

  let phone: string
  try {
    phone = normalisePhone(raw.data)
  } catch {
    return { step: 'phone', error: 'That does not look like a valid phone number' }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({ phone })

  if (error) {
    // Rate limits are the common case here and worth saying plainly.
    return { step: 'phone', phone, error: error.message }
  }

  return { step: 'otp', phone }
}

/** Step 2 — verify the code and start the session. */
export async function verifyOtp(
  previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const phone = previous.phone ?? String(formData.get('phone') ?? '')
  if (!phone) {
    return { step: 'phone', error: 'Start again — we lost your number' }
  }

  const token = otpSchema.safeParse(formData.get('token'))
  if (!token.success) {
    return { step: 'otp', phone, error: token.error.issues[0].message }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({
    phone,
    token: token.data,
    type: 'sms',
  })

  if (error) {
    return { step: 'otp', phone, error: 'That code was not right. Try again.' }
  }

  // Vetted again rather than trusted: this arrives as a form field, and a form
  // field is a POST body anyone can write, whatever the page rendered into it.
  redirect(safeNextPath(formData.get('next')?.toString()) ?? '/')
}
