import { NextResponse } from 'next/server'
import { serverEnv } from '@/lib/env'

/**
 * Digital Asset Links: Android's proof that the TWA's signing key and this
 * origin belong to the same owner — without it the Play build shows browser
 * chrome. Env-gated because the fingerprint does not exist until the person
 * steps in docs/runbooks/play-store-twa.md mint a signing key. A 404 is the
 * honest state; a placeholder statement would be verified and cached wrong.
 */
export async function GET() {
  const { TWA_PACKAGE_NAME, TWA_CERT_SHA256 } = serverEnv()
  if (!TWA_PACKAGE_NAME || !TWA_CERT_SHA256) {
    return new NextResponse(null, { status: 404 })
  }
  return NextResponse.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: TWA_PACKAGE_NAME,
        sha256_cert_fingerprints: [TWA_CERT_SHA256],
      },
    },
  ])
}
