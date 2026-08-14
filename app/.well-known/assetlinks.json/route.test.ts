import { afterEach, describe, expect, it, vi } from 'vitest'
// Side effect: loads .env.local so serverEnv()'s full schema validates.
import '@/tests/helpers/db'

/**
 * serverEnv() caches on first read, so each case gets a fresh module graph:
 * set the env, resetModules, import the route, call GET.
 */
async function get(env: { pkg?: string; cert?: string }) {
  vi.resetModules()
  if (env.pkg === undefined) delete process.env.TWA_PACKAGE_NAME
  else process.env.TWA_PACKAGE_NAME = env.pkg
  if (env.cert === undefined) delete process.env.TWA_CERT_SHA256
  else process.env.TWA_CERT_SHA256 = env.cert
  const { GET } = await import('./route')
  return GET()
}

afterEach(() => {
  delete process.env.TWA_PACKAGE_NAME
  delete process.env.TWA_CERT_SHA256
})

describe('GET /.well-known/assetlinks.json', () => {
  it('404s while either credential is missing — nothing fake is ever served', async () => {
    expect((await get({})).status).toBe(404)
    expect((await get({ pkg: 'com.happenly.app' })).status).toBe(404)
    expect((await get({ cert: 'AA:BB' })).status).toBe(404)
  })

  it('serves the statement once both are set', async () => {
    const response = await get({ pkg: 'com.happenly.app', cert: 'AA:BB:CC' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.happenly.app',
          sha256_cert_fingerprints: ['AA:BB:CC'],
        },
      },
    ])
  })
})
