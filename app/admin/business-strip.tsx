import {
  cashCountRatio,
  cashFlag,
  cashValueRatio,
  checkInRate,
  fillRate,
  netGmvPaise,
  payoutTotals,
  takeRate,
  type BusinessSnapshot,
} from '@/lib/analytics/rates'
import { formatPaise } from '@/lib/money'
import type { SettleableEvent } from '@/lib/payouts/queries'

/** "24%", or an em-dash when there is no data to divide — never "NaN%". */
function pct(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`
}

export function BusinessStrip({
  snapshot,
  events,
}: {
  snapshot: BusinessSnapshot
  events: SettleableEvent[]
}) {
  const { owedPaise, settledPaise } = payoutTotals(events)
  const flagged = cashFlag(snapshot)

  const tiles: Array<{ label: string; value: string; detail?: string; alert?: boolean }> = [
    {
      label: 'GMV',
      value: formatPaise(snapshot.gmv_paise),
      detail: `net ${formatPaise(netGmvPaise(snapshot))} after ${formatPaise(snapshot.refunds_processed_paise)} refunded`,
    },
    {
      label: 'Take rate',
      value: pct(takeRate(snapshot)),
      detail: formatPaise(snapshot.commission_paise),
    },
    {
      label: 'Owed to hosts',
      value: formatPaise(owedPaise),
      detail: `settled ${formatPaise(settledPaise)}`,
    },
    {
      label: 'Cash share',
      value: pct(cashCountRatio(snapshot)),
      detail: `${pct(cashValueRatio(snapshot))} by value · ${formatPaise(snapshot.cash_confirmed_paise)} the hosts hold — watch at 30%`,
      alert: flagged,
    },
    {
      label: 'Events',
      value: `${snapshot.events_live} live · ${snapshot.events_ended} ended`,
      detail: `${snapshot.waitlisted_count} waitlisted`,
    },
    {
      label: 'Fill',
      value: pct(fillRate(snapshot)),
      detail: `check-in ${pct(checkInRate(snapshot))} of ended`,
    },
  ]

  return (
    <section aria-label="The business at a glance" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className={`rounded-xl border p-3 ${
            tile.alert ? 'border-amber-300 bg-amber-50' : 'border-line'
          }`}
        >
          <p className={`mb-1 text-xs font-medium ${tile.alert ? 'text-amber-800' : 'text-muted'}`}>
            {tile.label}
          </p>
          <p className={`mb-1 text-xl font-semibold ${tile.alert ? 'text-amber-900' : 'text-ink'}`}>
            {tile.value}
          </p>
          {tile.detail && (
            <p className={`text-xs leading-snug ${tile.alert ? 'text-amber-700' : 'text-muted'}`}>
              {tile.detail}
            </p>
          )}
        </div>
      ))}
    </section>
  )
}
