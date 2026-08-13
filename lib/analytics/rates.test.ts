import { describe, expect, it } from 'vitest'
import {
  CASH_RATIO_THRESHOLD,
  cashCountRatio,
  cashFlag,
  cashValueRatio,
  checkInRate,
  fillRate,
  netGmvPaise,
  payoutTotals,
  ratio,
  takeRate,
  type BusinessSnapshot,
} from '@/lib/analytics/rates'

function snapshot(over: Partial<BusinessSnapshot> = {}): BusinessSnapshot {
  return {
    gmv_paise: 0,
    refunds_processed_paise: 0,
    commission_paise: 0,
    cash_confirmed_paise: 0,
    online_confirmed_paise: 0,
    cash_confirmed_count: 0,
    confirmed_count: 0,
    events_live: 0,
    events_ended: 0,
    capacity_seats: 0,
    confirmed_seats: 0,
    tickets_issued: 0,
    tickets_checked_in: 0,
    waitlisted_count: 0,
    ...over,
  }
}

describe('ratio', () => {
  it('is null on a zero denominator — no data is not 0%', () => {
    expect(ratio(5, 0)).toBeNull()
  })
  it('divides otherwise', () => {
    expect(ratio(1, 4)).toBe(0.25)
  })
})

describe('an empty platform', () => {
  it('answers null everywhere a rate needs data, never NaN', () => {
    const s = snapshot()
    expect(cashCountRatio(s)).toBeNull()
    expect(cashValueRatio(s)).toBeNull()
    expect(fillRate(s)).toBeNull()
    expect(checkInRate(s)).toBeNull()
    expect(takeRate(s)).toBeNull()
    expect(cashFlag(s)).toBe(false)
    expect(netGmvPaise(s)).toBe(0)
  })
})

describe('the cash flag', () => {
  it('stays quiet below the threshold', () => {
    expect(cashFlag(snapshot({ cash_confirmed_count: 299, confirmed_count: 1000 }))).toBe(false)
  })
  it('fires AT the threshold — at the threshold is at the threshold', () => {
    expect(cashFlag(snapshot({ cash_confirmed_count: 300, confirmed_count: 1000 }))).toBe(true)
  })
  it('fires past it', () => {
    expect(cashFlag(snapshot({ cash_confirmed_count: 301, confirmed_count: 1000 }))).toBe(true)
  })
})

describe('value vs count divergence', () => {
  it('a few large cash bookings hide in the count ratio and show in the value ratio', () => {
    const s = snapshot({
      cash_confirmed_count: 1,
      confirmed_count: 10,
      cash_confirmed_paise: 90_000,
      online_confirmed_paise: 10_000,
    })
    expect(cashCountRatio(s)).toBe(0.1)
    expect(cashValueRatio(s)).toBe(0.9)
  })
})

describe('netGmvPaise', () => {
  it('subtracts processed refunds from GMV', () => {
    expect(netGmvPaise(snapshot({ gmv_paise: 100_000, refunds_processed_paise: 40_000 }))).toBe(60_000)
  })
})

describe('payoutTotals', () => {
  const statement = (netPaise: number) =>
    ({ statement: { netPaise } }) as Parameters<typeof payoutTotals>[0][number]
  const paid = (netPaise: number, settledNet: number) =>
    ({
      statement: { netPaise },
      payout: { status: 'paid', net_paise: settledNet },
    }) as Parameters<typeof payoutTotals>[0][number]
  const onHold = (netPaise: number) =>
    ({
      statement: { netPaise },
      payout: { status: 'on_hold', net_paise: 0 },
    }) as Parameters<typeof payoutTotals>[0][number]

  it('sums unpaid statements as owed, frozen paid rows as settled', () => {
    const totals = payoutTotals([statement(50_000), paid(50_000, 80_000), onHold(20_000)])
    // The paid row contributes its FROZEN net (what left the bank), not the
    // recomputation; the on-hold row is still owed.
    expect(totals).toEqual({ owedPaise: 70_000, settledPaise: 80_000 })
  })

  it('is all zeros with no ended events', () => {
    expect(payoutTotals([])).toEqual({ owedPaise: 0, settledPaise: 0 })
  })

  it('says the threshold is 30%', () => {
    expect(CASH_RATIO_THRESHOLD).toBe(0.3)
  })
})
