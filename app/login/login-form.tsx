'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { requestOtp, verifyOtp, type LoginState } from './actions'

const INITIAL: LoginState = { step: 'phone' }

function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-ember text-white rounded-full px-5 py-3 text-[15px] font-semibold hover:bg-ember-deep disabled:opacity-60 w-full"
    >
      {pending ? 'Just a moment…' : children}
    </button>
  )
}

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(
    async (previous: LoginState, formData: FormData) =>
      previous.step === 'phone'
        ? requestOtp(previous, formData)
        : verifyOtp(previous, formData),
    INITIAL,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/*
        Travels with both submissions — the phone step and the code step are the
        same form — so verifyOtp still knows where to send the host two screens
        later. The page has already vetted it, and the action vets it again.
      */}
      <input type="hidden" name="next" value={next} />

      {state.step === 'phone' ? (
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Phone number</span>
          <input
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="numeric"
            required
            autoFocus
            placeholder="98765 43210"
            defaultValue={state.phone ?? ''}
            className="border-cream-line bg-white focus:border-ink rounded-lg border px-4 py-3 text-base outline-none"
          />
          <span className="text-muted text-xs">
            We&apos;ll send a code on WhatsApp.
          </span>
        </label>
      ) : (
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Enter the code</span>
          <input
            name="token"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            placeholder="123456"
            className="border-cream-line bg-white focus:border-ink rounded-lg border px-4 py-3 text-center text-2xl tracking-[0.4em] outline-none"
          />
          <span className="text-muted text-xs">Sent to {state.phone}</span>
        </label>
      )}

      {state.error ? (
        <p role="alert" className="text-sm text-ember">
          {state.error}
        </p>
      ) : null}

      <SubmitButton>{state.step === 'phone' ? 'Send code' : 'Verify'}</SubmitButton>
    </form>
  )
}
