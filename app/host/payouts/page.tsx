import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { listHostStatements } from '@/lib/payouts/queries'

export const metadata = { title: 'Your payouts' }

export default async function HostPayouts() {
  await requireUser()
  const statements = await listHostStatements()

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your payouts</h1>
        <Link href="/host" className="text-muted text-sm hover:underline">
          Your events
        </Link>
      </div>

      {statements.length === 0 ? (
        <p className="border-line text-muted rounded-xl border border-dashed p-8 text-center">
          Nothing to settle yet. Payouts appear here once an event has finished.
        </p>
      ) : (
        <ul className="space-y-3">
          {statements.map((row) => (
            <li key={row.eventId} className="border-line rounded-xl border p-4">
              <p className="font-medium break-words">{row.title}</p>
              <p className="text-muted text-sm">{formatIst(new Date(row.startsAt))}</p>

              <dl className="text-muted mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt>Ticket sales</dt>
                <dd className="text-right">{formatPaise(row.statement.grossPaise)}</dd>
                {row.statement.commissionPaise > 0 && (
                  <>
                    <dt>Platform commission</dt>
                    <dd className="text-right">−{formatPaise(row.statement.commissionPaise)}</dd>
                  </>
                )}
                <dt className="text-ink font-medium">
                  {row.payout?.status === 'paid' ? 'Paid to you' : 'Owed to you'}
                </dt>
                <dd className="text-ink text-right font-medium">
                  {formatPaise(
                    row.payout?.status === 'paid' ? row.payout.net_paise : row.statement.netPaise,
                  )}
                </dd>
                {row.statement.cashPaise > 0 && (
                  <>
                    <dt>Collected by you in cash</dt>
                    <dd className="text-right">{formatPaise(row.statement.cashPaise)}</dd>
                  </>
                )}
              </dl>

              {row.payout?.status === 'paid' ? (
                <p className="text-muted mt-3 text-sm">
                  Sent {row.payout.paid_at && formatIst(new Date(row.payout.paid_at))} · ref{' '}
                  {row.payout.utr_reference}
                </p>
              ) : row.payout?.status === 'on_hold' ? (
                <p className="text-muted mt-3 text-sm">
                  On hold{row.payout.notes ? ` — ${row.payout.notes}` : ''}.
                </p>
              ) : (
                <p className="text-muted mt-3 text-sm">Not settled yet.</p>
              )}

              {row.statement.cashPaise > 0 && (
                <p className="text-muted mt-1 text-xs">
                  Cash you took at the door never passed through the platform, so it is not part of
                  this transfer.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
