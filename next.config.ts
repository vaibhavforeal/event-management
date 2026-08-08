import type { NextConfig } from 'next'

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
function supabaseHostname(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set, so next.config.ts cannot tell which host serves event cover images.\n\n' +
        'Copy .env.example to .env.local and fill in the missing values.',
    )
  }
  try {
    return new URL(url).hostname
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL is not a valid URL (got ${JSON.stringify(url)}), so next.config.ts ` +
        'cannot tell which host serves event cover images.\n\n' +
        'It should look like https://<project-ref>.supabase.co, or http://127.0.0.1:54321 for local development.\n' +
        'Copy .env.example to .env.local and fill in the missing values.',
    )
  }
}

const nextConfig: NextConfig = {
  images: {
    // Covers are served straight from Supabase Storage. Without this, next/image
    // refuses the URL at runtime with a vague "hostname not configured" error.
    remotePatterns: [
      { protocol: 'http', hostname: '127.0.0.1', port: '54321', pathname: '/storage/v1/object/public/**' },
      { protocol: 'https', hostname: supabaseHostname(), pathname: '/storage/v1/object/public/**' },
    ],
  },
}

export default nextConfig
