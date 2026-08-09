/**
 * Validation for the `?next=` return path.
 *
 * The value is attacker-controlled — it arrives in a URL, and a URL is the one
 * thing this product exists to have forwarded into a WhatsApp group. Handing it
 * to redirect() unchecked turns every "sign in to continue" link into an open
 * redirect wearing this site's own domain, which is the shape a phishing page
 * wants most.
 *
 * The rule is allow-list, not deny-list: a same-origin path, spelled as a path,
 * or nothing. Anything this cannot vouch for becomes null and the caller falls
 * back to its own default.
 */

/**
 * Where proxy.ts leaves the path the visitor asked for.
 *
 * A Server Component is not given its own URL, so this header is the only way
 * requireUser() can know what the host was trying to reach. Nothing outside
 * this app writes it — and safeNextPath still vets the value, because a header
 * arriving from somewhere else is exactly the case worth surviving.
 */
export const PATHNAME_HEADER = 'x-pathname'

/**
 * CR, LF, tab and the rest of C0, plus DEL.
 *
 * Spelled as a code-point scan rather than a regex literal, because the
 * characters being matched are exactly the ones that do not survive being
 * written into a source file legibly.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * A path this app will redirect to, or null.
 *
 * Callers treat null as "no opinion" and use their own landing page, so a
 * rejected value costs the visitor one extra tap, never an error page.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null
  if (hasControlCharacter(value)) return null

  // Exactly one leading slash. `//evil.example` also starts with a slash and is
  // read by the browser as another origin entirely, which is the bypass a bare
  // startsWith('/') check is famous for missing. Backslash is the same attack
  // spelled differently: browsers normalise it to '/' in the authority position.
  if (!value.startsWith('/')) return null
  if (value.startsWith('//') || value.startsWith('/\\')) return null

  // Signing in must not return to the sign-in page: the visitor would arrive
  // back where they started, already authenticated, with nothing to do.
  const path = value.split(/[?#]/)[0]
  if (path === '/login' || path.startsWith('/login/')) return null

  return value
}
