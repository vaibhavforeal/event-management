import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { clientEnv } from '@/lib/env'

/**
 * Refreshes the Supabase auth session on every request.
 *
 * Named `proxy` (not `middleware`) — Next.js 16 renamed the convention. It runs
 * on the Node.js runtime; the edge runtime is not supported here.
 *
 * Without this, expired access tokens are never refreshed and Server Components
 * intermittently see a signed-out user.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // Do not remove: this call is what performs the refresh. Use getUser(), not
  // getSession() — getSession() trusts the cookie without revalidating it.
  await supabase.auth.getUser()

  return response
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. Notably this DOES run on
     * /e/[slug] public event pages, which is intentional: an attendee arriving
     * from a WhatsApp link should already be signed in if they have a session.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)',
  ],
}
