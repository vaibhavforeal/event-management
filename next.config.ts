import type { NextConfig } from 'next'

const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname

const nextConfig: NextConfig = {
  images: {
    // Covers are served straight from Supabase Storage. Without this, next/image
    // refuses the URL at runtime with a vague "hostname not configured" error.
    remotePatterns: [
      { protocol: 'http', hostname: '127.0.0.1', port: '54321', pathname: '/storage/v1/object/public/**' },
      { protocol: 'https', hostname: supabaseHost, pathname: '/storage/v1/object/public/**' },
    ],
  },
}

export default nextConfig
