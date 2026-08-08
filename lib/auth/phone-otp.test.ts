import { describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { adminClient } from '@/tests/helpers/db'

config({ path: '.env.local', quiet: true })

/**
 * End-to-end proof that phone-OTP login works.
 *
 * This is the assumption the whole auth design rests on: Supabase issues the
 * OTP, our send_sms hook delivers it over WhatsApp, and verifying the code
 * mints a session with a profile row already in place.
 *
 * Uses the fixed test OTPs from supabase/config.toml ([auth.sms.test_otp]), so
 * it needs no WhatsApp account. The hook is bypassed for these numbers — the
 * hook itself is covered separately.
 */

const TEST_PHONE = '+919999900001'
const TEST_OTP = '123456'

function publicClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

describe('phone OTP login', () => {
  it('signs a user in and provisions their profile', async () => {
    const db = adminClient()

    // Start clean so the test proves signup, not just sign-in.
    const { data: existing } = await db
      .from('profiles')
      .select('id')
      .eq('phone', TEST_PHONE)
      .maybeSingle()
    if (existing) {
      await db.auth.admin.deleteUser(existing.id).catch(() => {})
    }

    const supabase = publicClient()

    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: TEST_PHONE })
    expect(otpError, otpError?.message).toBeNull()

    const { data, error } = await supabase.auth.verifyOtp({
      phone: TEST_PHONE,
      token: TEST_OTP,
      type: 'sms',
    })

    expect(error, error?.message).toBeNull()
    expect(data.session).not.toBeNull()
    expect(data.user?.phone).toBe(TEST_PHONE.replace('+', ''))

    // The on_auth_user_created trigger must have made a profile, so the app
    // never sees a signed-in user without one.
    const { data: profile } = await db
      .from('profiles')
      .select('id, phone')
      .eq('id', data.user!.id)
      .single()

    expect(profile).not.toBeNull()
    expect(profile!.phone).toBe(TEST_PHONE.replace('+', ''))

    await db.auth.admin.deleteUser(data.user!.id).catch(() => {})
  }, 30_000)

  it('rejects a wrong code', async () => {
    const supabase = publicClient()
    await supabase.auth.signInWithOtp({ phone: '+919999900002' })

    const { data, error } = await supabase.auth.verifyOtp({
      phone: '+919999900002',
      token: '000000',
      type: 'sms',
    })

    expect(error).not.toBeNull()
    expect(data.session).toBeNull()
  }, 30_000)
})
