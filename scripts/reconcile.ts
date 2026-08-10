/**
 * The reconcile sweep, hand-run: `npm run reconcile`.
 *
 * Runs under `--conditions=react-server` so the `import 'server-only'`
 * markers inside lib/payments resolve to that package's empty react-server
 * build instead of throwing; tsx resolves the repo's `@/` tsconfig paths.
 * Env comes from .env.local the same way tests/helpers/db.ts loads it:
 * `.env.local` first, then `.env` — dotenv does not overwrite a variable
 * that is already set, so `.env.local` wins.
 *
 * The body lives in main() rather than at the top level: package.json has no
 * `"type": "module"`, so tsx transforms this file as CommonJS, where esbuild
 * refuses top-level await. The import of the service stays dynamic ON PURPOSE
 * — a static import would hoist above the dotenv calls and lib/env.ts would
 * validate an empty environment.
 */
import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })
config({ path: '.env', quiet: true })

async function main(): Promise<void> {
  const { runReconciliationSweep } = await import('@/lib/payments/service')

  const counts = await runReconciliationSweep()
  console.log(
    `[reconcile] bookings reconciled: ${counts.reconciled}, holds released: ${counts.released}, refunds retried: ${counts.refundsRetried}`,
  )
}

main().catch((cause) => {
  console.error('[reconcile] the sweep failed', cause)
  process.exitCode = 1
})
