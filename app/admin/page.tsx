import { requireUser } from '@/lib/auth/session'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { requirePlatformAdmin } from '@/lib/payouts/admin'
import { hostPayoutTarget, listSettleableEvents } from '@/lib/payouts/queries'
import { RecordPayoutForm } from '@/app/admin/record-payout-form'

export const metadata = { title: 'Settlements' }

const STATUS_BADGE: Record<'pending' | 'paid' | 'on_hold', string> = {
  pending: 'bg-raised text-muted',
  paid: 'bg-green-100 text-green-800',
  on_hold: 'bg-amber-100 text-amber-800',
}

export default async function AdminConsole() {
  await requireUser()
  await requirePlatformAdmin()

  const events = await listSettleableEvents()

  // Resolved BEFORE the JSX, not inside the map. `events.map(async …)` yields an
  // array of promises as children, which is not a thing a Server Component may
  // render — and it would fire one RPC per row serially even if it were.
  const targets = new Map(
    await Promise.all(
      events
        .filter((event) => event.payout?.status !== 'paid')
        .map(async (event) => [event.eventId, await hostPayoutTarget(event.hostId)] as const),
    ),
  )

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Settlements</h1>

      {events.length === 0 ? (
        <p className="border-line text-muted rounded-xl border border-dashed p-8 text-center">
          No events have ended yet.
        </p>
      ) : (
        <ul className="space-y-4">
          {events.map((event) => {
            const target = targets.get(event.eventId) ?? null
            return (
              <li key={event.eventId} className="border-line rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{event.title}</p>
                    <p className="text-muted text-sm">
                      {formatIst(new Date(event.startsAt))} · {event.hostName}
                      {event.hostKycStatus !== 'verified' && ` · KYC ${event.hostKycStatus}`}
                    </p>
                  </div>
                  {event.payout && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-xs ${STATUS_BADGE[event.payout.status]}`}
                    >
                      {event.payout.status === 'on_hold' ? 'on hold' : event.payout.status}
                    </span>
                  )}
                </div>

                <dl className="text-muted mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt>Gross</dt>
                  <dd className="text-right">{formatPaise(event.statement.grossPaise)}</dd>
                  <dt>Commission</dt>
                  <dd className="text-right">−{formatPaise(event.statement.commissionPaise)}</dd>
                  <dt className="text-ink font-medium">Net owed</dt>
                  <dd className="text-ink text-right font-medium">
                    {formatPaise(event.statement.netPaise)}
                  </dd>
                  {event.statement.forfeitedPaise > 0 && (
                    <>
                      <dt>of which forfeited</dt>
                      <dd className="text-right">{formatPaise(event.statement.forfeitedPaise)}</dd>
                    </>
                  )}
                  {event.statement.cashPaise > 0 && (
                    <>
                      <dt>Cash the host already holds</dt>
                      <dd className="text-right">{formatPaise(event.statement.cashPaise)}</dd>
                    </>
                  )}
                </dl>

                {event.driftPaise !== null && event.driftPaise !== 0 && (
                  <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    Settled at {formatPaise(event.payout!.net_paise)}, now computes{' '}
                    {formatPaise(event.statement.netPaise)} — a difference of{' '}
                    {formatPaise(Math.abs(event.driftPaise))}. The settled row is what left the
                    bank; settle the difference out of band and note it here.
                  </p>
                )}

                {event.payout?.status === 'paid' ? (
                  <p className="text-muted mt-3 text-sm">
                    Paid {event.payout.paid_at && formatIst(new Date(event.payout.paid_at))} ·{' '}
                    {event.payout.utr_reference}
                    {event.payout.notes && ` · ${event.payout.notes}`}
                  </p>
                ) : (
                  <>
                    {target && (
                      <p className="text-muted mt-3 text-sm">
                        Pay to {target.upi_id ?? target.bank_account_ref ?? 'no destination on file'}
                      </p>
                    )}
                    <RecordPayoutForm eventId={event.eventId} />
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
