import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, createTestUser, userClient } from '@/tests/helpers/db'

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

/**
 * The update writer's full argument list, driven as the host who owns the
 * event — the shape lib/events/atomicity.test.ts uses.
 *
 * A `userClient` and not `db`: the service role carries no auth.uid(), so
 * current_host_id() is null and update_event_with_ticket_type refuses at its
 * EH002 ownership guard before it reaches a single write. A test that calls it
 * as the service role asserts the guard, not the toggle — which is exactly how
 * this file used to leave `has_waitlist`'s UPDATE untested by anything.
 */
async function update(
  event: { id: string; title: string; starts_at: string },
  requiresApproval: boolean,
  hasWaitlist: boolean,
) {
  const user = userClient(hostProfileId)
  const { data, error } = await user.rpc('update_event_with_ticket_type', {
    p_event_id: event.id,
    p_title: event.title,
    p_description: null,
    p_city: 'Indore',
    p_venue_name: 'Somewhere',
    p_venue_address: null,
    p_cover_image_url: null,
    p_starts_at: event.starts_at,
    p_ends_at: null,
    p_requires_approval: requiresApproval,
    p_allows_cash: false,
    p_hide_venue_until_approved: false,
    p_price_paise: 50_000,
    p_quantity: 10,
    p_refund_cutoff_hours: 24,
    p_has_waitlist: hasWaitlist,
  })
  if (error) throw new Error(`update failed (${error.code}): ${error.message}`)
  return data!
}

describe('the event writers and the waitlist toggle', () => {
  it('stores the toggle on an instant-book event', async () => {
    const event = await create(false, true)
    expect(event.has_waitlist).toBe(true)
    expect(event.requires_approval).toBe(false)
  })

  // The off cases are not symmetry for its own sake. With only the two `true`
  // cases asserted, `has_waitlist = not p_requires_approval` — which ignores
  // the host's tick entirely and gives EVERY instant-book event a waitlist —
  // passes the whole suite, as does `p_has_waitlist <> p_requires_approval`.
  // These two pin the parameter itself.
  it('leaves the waitlist off on an instant-book event that did not ask for one', async () => {
    const event = await create(false, false)
    expect(event.has_waitlist).toBe(false)
    expect(event.requires_approval).toBe(false)
  })

  it('leaves the waitlist off on an approval event that did not ask for one', async () => {
    const event = await create(true, false)
    expect(event.has_waitlist).toBe(false)
    expect(event.requires_approval).toBe(true)
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
    expect(event.has_waitlist).toBe(true) // the precondition, not the assertion

    // Both flags asked for at once, through the update door this time: the same
    // coercion create does, honouring the approval tick over the stale waitlist.
    const switched = await update(event, true, true)
    expect(switched.requires_approval).toBe(true)
    expect(switched.has_waitlist).toBe(false)
  })

  it('turns the waitlist off when the host simply unticks it', async () => {
    // The raw-off path, with no approval flag anywhere near it. Without this,
    // an update writing `not p_requires_approval` would turn the waitlist back
    // ON here and no test would notice.
    const event = await create(false, true)
    const updated = await update(event, false, false)
    expect(updated.requires_approval).toBe(false)
    expect(updated.has_waitlist).toBe(false)
  })

  it('turns the waitlist on when the host ticks it on an event that had none', async () => {
    // The update writer's only ON case. Without it `has_waitlist = false`
    // hard-coded in the UPDATE passes every other assertion here, and a host
    // ticking the box on an existing event would silently get nothing.
    const event = await create(false, false)
    const updated = await update(event, false, true)
    expect(updated.has_waitlist).toBe(true)
  })

  it('keeps the waitlist off when an event switches to approvals without asking for one', async () => {
    // The fourth corner of the same two-flag truth table, and the one that
    // separates `p_has_waitlist and not p_requires_approval` from an XOR: XOR
    // would write true here, trip events_one_queue, and raise. The other three
    // update cases agree with XOR, so this is the only one that can tell them
    // apart.
    const event = await create(false, true)
    const updated = await update(event, true, false)
    expect(updated.requires_approval).toBe(true)
    expect(updated.has_waitlist).toBe(false)
  })
})
