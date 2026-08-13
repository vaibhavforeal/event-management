import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  anonClient,
  cleanupEvent,
  createTestUser,
  seedCapturedBooking,
  seedEvent,
  seedPlatformAdmin,
  userClient,
  type SeededEvent,
} from '@/tests/helpers/db'

/**
 * The two functions that guard real money. Every assertion here calls them the
 * way the app will — as a signed-in user through PostgREST — rather than
 * inspecting their source, because "the gate is written" and "the gate fires"
 * are different claims.
 */

const db: SupabaseClient = adminClient()
const HOUR = 3600 * 1000

let adminId: string
let outsiderId: string
let ended: SeededEvent
let future: SeededEvent
let noEndTime: SeededEvent
let held: SeededEvent
let bare: SeededEvent
let cancelledEnded: SeededEvent

beforeAll(async () => {
  adminId = await seedPlatformAdmin(db)
  outsiderId = await createTestUser(db)
  ended = await seedEvent(db, {
    startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
  })
  future = await seedEvent(db, {
    startsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  })
  noEndTime = await seedEvent(db, {
    startsAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    endsAt: null,
  })
  held = await seedEvent(db, {
    startsAt: new Date(Date.now() - 72 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 71 * HOUR).toISOString(),
  })
  // Ended, never settled — the target for refusals that must not meet a
  // frozen row first.
  bare = await seedEvent(db, {
    startsAt: new Date(Date.now() - 30 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 29 * HOUR).toISOString(),
  })
  // Ended but cancelled after the fact — settles by refunds, not payouts.
  cancelledEnded = await seedEvent(db, {
    startsAt: new Date(Date.now() - 96 * HOUR).toISOString(),
    endsAt: new Date(Date.now() - 95 * HOUR).toISOString(),
  })
  await db.from('events').update({ status: 'cancelled' }).eq('id', cancelledEnded.eventId)
  await db.from('hosts').update({ upi_id: 'host@upi' }).eq('id', ended.hostId)
})

afterAll(async () => {
  await cleanupEvent(db, ended)
  await cleanupEvent(db, future)
  await cleanupEvent(db, noEndTime)
  await cleanupEvent(db, held)
  await cleanupEvent(db, bare)
  await cleanupEvent(db, cancelledEnded)
  await db.auth.admin.deleteUser(adminId).catch(() => {})
  await db.auth.admin.deleteUser(outsiderId).catch(() => {})
})

function paid(eventId: string, over: Record<string, unknown> = {}) {
  return {
    p_event_id: eventId,
    p_gross_paise: 50_000,
    p_commission_paise: 0,
    p_forfeited_paise: 0,
    p_status: 'paid',
    p_utr_reference: 'UTR123456',
    p_notes: null,
    ...over,
  }
}

describe('record_payout', () => {
  it('refuses a caller who is not a platform admin', async () => {
    const { error } = await userClient(outsiderId).rpc('record_payout', paid(ended.eventId))
    expect(error?.code).toBe('EH071')
  })

  it('refuses a signed-in non-admin, even the event\'s own host', async () => {
    const { error } = await userClient(ended.hostProfileId).rpc('record_payout', paid(ended.eventId))
    // The host of the event is still not an admin. Hosting is not settling.
    expect(error?.code).toBe('EH071')
  })

  it('refuses a truly anonymous caller at the grant, before the gate', async () => {
    // EH071 is unreachable for anon: EXECUTE is revoked, so PostgREST answers
    // permission-denied before the function body ever runs. Pinned to the
    // exact code — if this ever changes, a grant was added and the gate
    // became the only defence.
    const { error } = await anonClient().rpc('record_payout', paid(ended.eventId))
    expect(error?.code).toBe('42501')
  })

  it('refuses an event that does not exist', async () => {
    const { error } = await userClient(adminId).rpc('record_payout', paid(crypto.randomUUID()))
    expect(error?.code).toBe('EH072')
  })

  it('refuses an event that is not published', async () => {
    const { error } = await userClient(adminId).rpc('record_payout', paid(cancelledEnded.eventId))
    expect(error?.code).toBe('EH077')
  })

  it('refuses a forfeit exceeding gross — the table CHECK, not an app check', async () => {
    const { error } = await userClient(adminId).rpc(
      'record_payout',
      paid(bare.eventId, { p_gross_paise: 1_000, p_forfeited_paise: 2_000 }),
    )
    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('payouts_forfeit_within_gross')
  })

  it('refuses an event that has not ended', async () => {
    const { error } = await userClient(adminId).rpc('record_payout', paid(future.eventId))
    expect(error?.code).toBe('EH073')
  })

  it('accepts an event with no end time whose start has passed', async () => {
    // ends_at is nullable. Without the coalesce these hosts are unpayable.
    const { data, error } = await userClient(adminId).rpc('record_payout', paid(noEndTime.eventId))
    expect(error).toBeNull()
    expect(data.status).toBe('paid')
  })

  it('refuses a status other than paid or on_hold', async () => {
    const { error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_status: 'pending' }),
    )
    expect(error?.code).toBe('EH074')
  })

  it('refuses a paid payout with no UTR', async () => {
    const { error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_utr_reference: '   ' }),
    )
    expect(error?.code).toBe('EH075')
  })

  it('records a settlement, deriving net and stamping paid_at', async () => {
    const { data, error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_gross_paise: 80_000, p_commission_paise: 8_000, p_forfeited_paise: 30_000 }),
    )
    expect(error).toBeNull()
    expect(data.net_paise).toBe(72_000)
    expect(data.forfeited_paise).toBe(30_000)
    expect(data.host_id).toBe(ended.hostId)
    expect(data.paid_at).not.toBeNull()
  })

  it('freezes the amounts once paid', async () => {
    const { error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, { p_gross_paise: 10_000 }),
    )
    expect(error?.code).toBe('EH070')
  })

  it('still allows a note on a settled row, which is how a correction is recorded', async () => {
    const { data, error } = await userClient(adminId).rpc(
      'record_payout',
      paid(ended.eventId, {
        p_gross_paise: 80_000,
        p_commission_paise: 8_000,
        p_forfeited_paise: 30_000,
        p_notes: 'refund landed after settlement; ₹200 recovered by UPI',
      }),
    )
    expect(error).toBeNull()
    expect(data.notes).toContain('recovered')
  })

  it('freezes against the service role too — the trigger, not an app check', async () => {
    const { error } = await db
      .from('payouts')
      .update({ gross_paise: 1 })
      .eq('event_id', ended.eventId)
    expect(error?.code).toBe('EH070')
  })

  it('freezes the pointers too — a settled row cannot be re-pointed', async () => {
    const repointEvent = await db
      .from('payouts')
      .update({ event_id: future.eventId })
      .eq('event_id', ended.eventId)
    expect(repointEvent.error?.code).toBe('EH070')

    const repointHost = await db
      .from('payouts')
      .update({ host_id: future.hostId })
      .eq('event_id', ended.eventId)
    expect(repointHost.error?.code).toBe('EH070')
  })

  it('updates an unsettled row rather than duplicating it, and holds are not frozen', async () => {
    const hold = { p_status: 'on_hold', p_utr_reference: null }
    const first = await userClient(adminId).rpc(
      'record_payout',
      paid(held.eventId, { ...hold, p_notes: 'KYC pending' }),
    )
    expect(first.error).toBeNull()
    expect(first.data.paid_at).toBeNull()

    const second = await userClient(adminId).rpc(
      'record_payout',
      paid(held.eventId, { ...hold, p_gross_paise: 12_000, p_notes: 'KYC cleared, paying Friday' }),
    )
    expect(second.error).toBeNull()
    expect(second.data.gross_paise).toBe(12_000)

    const { data: rows } = await db.from('payouts').select('id').eq('event_id', held.eventId)
    expect(rows).toHaveLength(1)
  })
})

describe('admin_host_payout_target', () => {
  it('refuses a caller who is not a platform admin', async () => {
    const { error } = await userClient(outsiderId).rpc('admin_host_payout_target', {
      p_host_id: ended.hostId,
    })
    expect(error?.code).toBe('EH071')
  })

  it('returns the payout destination to an admin, which no policy could', async () => {
    // The ordinary client cannot select upi_id at all — it is withheld by a
    // COLUMN GRANT, and RLS filters rows, not columns. This function is the
    // only route that does not either leak the column or reach for the
    // service role.
    const { data, error } = await userClient(adminId).rpc('admin_host_payout_target', {
      p_host_id: ended.hostId,
    })
    expect(error).toBeNull()
    expect(data[0].upi_id).toBe('host@upi')
  })
})

describe('host_settlement_rows', () => {
  let withMoney: SeededEvent
  let secondAttendee: string

  beforeAll(async () => {
    withMoney = await seedEvent(db, {
      startsAt: new Date(Date.now() - 48 * HOUR).toISOString(),
      endsAt: new Date(Date.now() - 24 * HOUR).toISOString(),
    })
    secondAttendee = await createTestUser(db)
    await seedCapturedBooking(db, withMoney, { subtotalPaise: 50_000 })
    await seedCapturedBooking(db, withMoney, {
      status: 'refunded',
      refunded: true,
      subtotalPaise: 30_000,
      attendeeId: secondAttendee,
    })
  })

  afterAll(async () => {
    await cleanupEvent(db, withMoney)
    await db.auth.admin.deleteUser(secondAttendee).catch(() => {})
  })

  it('gives the host the two money facts and no payment row', async () => {
    const { data, error } = await userClient(withMoney.hostProfileId).rpc('host_settlement_rows', {
      p_event_id: withMoney.eventId,
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    const paid = data.find((row: { subtotal_paise: number }) => row.subtotal_paise === 50_000)
    expect(paid.has_captured_payment).toBe(true)
    expect(paid.has_refund).toBe(false)
    const refunded = data.find((row: { subtotal_paise: number }) => row.subtotal_paise === 30_000)
    expect(refunded.has_refund).toBe(true)
    // The aggregate, and nothing about the instrument.
    expect(Object.keys(paid).sort()).toEqual([
      'commission_paise',
      'has_captured_payment',
      'has_refund',
      'id',
      'payment_mode',
      'status',
      'subtotal_paise',
    ])
  })

  it('refuses a host asking about an event they do not own', async () => {
    const { error } = await userClient(ended.hostProfileId).rpc('host_settlement_rows', {
      p_event_id: withMoney.eventId,
    })
    expect(error?.code).toBe('EH076')
  })

  it('gives an admin another host\'s rows — the gate\'s other branch', async () => {
    // The is_platform_admin() escape in the EH076 gate, exercised positively:
    // the console reads statements through the same function the host does.
    const { data, error } = await userClient(adminId).rpc('host_settlement_rows', {
      p_event_id: withMoney.eventId,
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
  })

  it('still refuses the host a direct read of payments', async () => {
    // The function is an aggregate escape hatch, not a widening. If this ever
    // returns rows, rls_policies.sql:157 has been undone by accident.
    const { data } = await userClient(withMoney.hostProfileId).from('payments').select('id')
    expect(data ?? []).toHaveLength(0)
  })
})
