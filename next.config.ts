import type { NextConfig } from 'next'
import type { RemotePattern } from 'next/dist/shared/lib/image-config'

/**
 * next.config is evaluated before any application code, so lib/env.ts — which
 * validates this same variable and explains itself when it is missing — has not
 * run yet. A bare `new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!)` here dies
 * with `TypeError: Invalid URL`, naming neither the variable nor this file, and
 * it fires on `next build` in CI before anything useful has happened.
 *
 * We throw rather than quietly dropping the pattern: lib/env.ts already refuses
 * to load without this variable, so a build that skipped it would not be a
 * working build — it would be one that fails later, further from the cause, or
 * ships and 400s on every cover image at runtime. Fail early, and say why.
 */
function supabaseImagePattern(): RemotePattern {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set, so next.config.ts cannot tell which host serves event cover images.\n\n' +
        'Copy .env.example to .env.local and fill in the missing values.',
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL is not a valid URL (got ${JSON.stringify(url)}), so next.config.ts ` +
        'cannot tell which host serves event cover images.\n\n' +
        'It should look like https://<project-ref>.supabase.co, or http://127.0.0.1:54321 for local development.\n' +
        'Copy .env.example to .env.local and fill in the missing values.',
    )
  }

  return {
    // Derived, not hard-coded: a self-hosted Supabase behind plain http would
    // silently fail to match a hardcoded 'https'.
    protocol: parsed.protocol.replace(/:$/, '') as 'http' | 'https',
    hostname: parsed.hostname,
    // Pinned. Next reads an omitted port as "any port", which would let this
    // pattern match the same host on a port we never intended to proxy.
    // `new URL()` gives '' for a default port, which is what we want.
    port: parsed.port,
    pathname: '/storage/v1/object/public/**',
  }
}

/**
 * Whether Supabase is the CLI stack running on this machine.
 *
 * Next 16 refuses to optimize a remote image whose hostname resolves to a
 * private or loopback address — SSRF protection — and reports it as a bare
 * `400 "url" parameter is not allowed`, the same message a missing
 * remotePattern gives, which sends you looking in the wrong place. Locally that
 * hits every single cover: Storage lives on http://127.0.0.1:54321, so /e/[slug]
 * renders its hero as a broken image for every developer while being perfectly
 * fine in production. Turning `dangerouslyAllowLocalIP` on unblocks it.
 *
 * Derived rather than hard-coded to `true`, and from the hostname literal rather
 * than a DNS lookup, so it cannot become true for a deployed project: a real
 * `<ref>.supabase.co` never matches. Split-horizon DNS that points a public
 * hostname at a private IP is still refused, which is the conservative answer.
 * Checked by evaluating this config against seven hostnames — the flag is false
 * for `<ref>.supabase.co` and for a public corporate host, true only for
 * localhost, 127/8, 10/8, 192.168/16 and 172.16-31/12.
 *
 * If you are here because covers 404-ish with `400 "url" parameter is not
 * allowed` — in a feed card, a listing, anywhere — this is the flag, not
 * `remotePatterns`. The two failures are reported with the identical message.
 */
function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  )
}

// Computed once, so the check below reuses the hostname supabaseImagePattern()
// has already validated rather than re-parsing the variable.
const supabasePattern = supabaseImagePattern()

const nextConfig: NextConfig = {
  images: {
    // Covers are served straight from Supabase Storage. Without this, next/image
    // refuses the URL at runtime with a vague "hostname not configured" error.
    // The local entry is static so it works regardless of how the env var is
    // set; the second is derived from it. In local development the two coincide
    // exactly, which is harmless — Next tests each pattern in turn.
    remotePatterns: [
      { protocol: 'http', hostname: '127.0.0.1', port: '54321', pathname: '/storage/v1/object/public/**' },
      supabasePattern,
    ],
    // Only ever true against the local Supabase stack; see above.
    dangerouslyAllowLocalIP: isLocalHostname(supabasePattern.hostname),
  },
  async headers() {
    // The SW files must never be served stale: a cached sw.js is how a bad
    // deploy becomes permanent. Everything else keeps Next's defaults.
    const noCache = [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }]
    return [
      { source: '/sw.js', headers: noCache },
      { source: '/sw-strategy.mjs', headers: noCache },
    ]
  },
}

export default nextConfig
