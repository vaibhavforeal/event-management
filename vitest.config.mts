import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'tests/e2e/**'],
    // Pin the zone so timezone bugs cannot hide. Vercel runs UTC, most of this
    // team runs IST, and IST is the one zone where reading the ambient zone
    // instead of Asia/Kolkata still produces the right answer — so an unpinned
    // suite is green locally and wrong in production. See lib/events/datetime.ts.
    env: { TZ: 'UTC' },
    // Integration tests hit a shared local Postgres; running files in parallel
    // makes them fight over the same rows.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/supabase/types.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` exists to break the build if a module is imported into a
      // client bundle. Vitest is neither, so it is stubbed rather than removed
      // from the source — the guard still protects the real build.
      'server-only': fileURLToPath(new URL('./tests/helpers/empty-module.ts', import.meta.url)),
    },
  },
})
