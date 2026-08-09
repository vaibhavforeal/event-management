import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/auth/next-path'
import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Sign in',
}

export default async function LoginPage(props: PageProps<'/login'>) {
  const { next } = await props.searchParams

  // Vetted here as well as in the action. This value decides where an already
  // signed-in visitor is sent below, before any form is rendered, so it cannot
  // wait for the submit to be checked.
  const target = safeNextPath(typeof next === 'string' ? next : null) ?? '/'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) redirect(target)

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-neutral-500">
          No password. We&apos;ll send a one-time code to your WhatsApp.
        </p>
      </div>

      <LoginForm next={target} />
    </main>
  )
}
