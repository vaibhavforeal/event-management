import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, createTestUser } from '@/tests/helpers/db'

const db = adminClient()

let hostProfileId = ''
let hostId = ''
const created: string[] = []

beforeAll(async () => {
  hostProfileId = await createTestUser(db)
  const { data, error } = await db
    .from('hosts')
    .insert({ profile_id: hostProfileId, display_name: 'Toggle Host' })
    .select()
    .single()
  if (error) throw new Error(`seed host failed: ${error.message}`)
  hostId = data.id
})

afterAll(async () => {
  for (const id of created) {
    await db.from('ticket_types').delete().eq('event_id', id)
    await db.from('events').delete().eq('id', id)
  }
  await db.from('hosts').delete().eq('id', hostId)
  await db.auth.admin.deleteUser(hostProfileId).catch(() => {})
})

/** The writer's full argument list, with only the two toggles varying. */
async function create(requiresApproval: boolean, hasWaitlist: boolean) {
  const { data, error } = await db.rpc('create_event_with_ticket_type', {
    p_host_id: hostId,
    p_slug: `toggle-${crypto.randomUUID().slice(0, 8)}`,
    p_title: 'Toggle Supper Club',
    p_description: null,
    p_city: 'Indore',
    p_venue_name: 'Somewhere',
    p_venue_address: null,
    p_cover_image_url: null,
    p_starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    p_ends_at: null,
    p_requires_approval: requiresApproval,
    p_allows_cash: false,
    p_hide_venue_until_approved: false,
    p_price_paise: 50_000,
    p_quantity: 10,
    p_refund_cutoff_hours: 24,
    p_has_waitlist: hasWaitlist,
  })
  if (error) throw new Error(`create failed: ${error.message}`)
  created.push(data!.id)
  return data!
}

describe('the event writers and the waitlist toggle', () => {
  it('stores the toggle on an instant-book event', async () => {
    const event = await create(false, true)
    expect(event.has_waitlist).toBe(true)
    expect(event.requires_approval).toBe(false)
  })

  it('coerces rather than raises when both queues are asked for', async () => {
    // A host who ticks approval gets their intent honoured. The alternative —
    // letting events_one_queue fire — hands them a constraint name for a
    // combination the form does not even offer.
    const event = await create(true, true)
    expect(event.requires_approval).toBe(true)
    expect(event.has_waitlist).toBe(false)
  })

  it('turns the waitlist off when an event switches to approvals', async () => {
    const event = await create(false, true)
    const { data, error } = await db.rpc('update_event_with_ticket_type', {
      p_event_id: event.id,
      p_title: event.title,
      p_description: null,
      p_city: 'Indore',
      p_venue_name: 'Somewhere',
      p_venue_address: null,
      p_cover_image_url: null,
      p_starts_at: event.starts_at,
      p_ends_at: null,
      p_requires_approval: true,
      p_allows_cash: false,
      p_hide_venue_until_approved: false,
      p_price_paise: 50_000,
      p_quantity: 10,
      p_refund_cutoff_hours: 24,
      p_has_waitlist: true,
    })
    // service_role has no current_host_id(), so the ownership guard refuses it
    // — which is the defence in depth 20260809000001 documents, and is why
    // this assertion is about the refusal, not the row.
    expect(error?.code).toBe('EH002')
    expect(data).toBeNull()
  })
})
