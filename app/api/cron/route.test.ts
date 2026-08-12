import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * serverEnv() caches its parse (lib/env.ts), so setting process.env.CRON_SECRET
 * after the first read would change nothing and the "no secret configured"
 * test would silently pass for the wrong reason. Mock the module instead —
 * the same reason meta.test.ts and factory.test.ts do.
 */
const env: { CRON_SECRET?: string } = { CRON_SECRET: 'test-cron-secret' }
vi.mock('@/lib/env', () => ({ serverEnv: () => env }))

vi.mock('@/lib/notifications/service', () => ({
  enqueueOwedMessages: vi.fn(),
  drainOutbox: vi.fn(),
}))
vi.mock('@/lib/payments/service', () => ({ runReconciliationSweep: vi.fn() }))

const { enqueueOwedMessages, drainOutbox } = vi.mocked(
  await import('@/lib/notifications/service'),
)
const { runReconciliationSweep } = vi.mocked(await import('@/lib/payments/service'))
const { GET } = await import('@/app/api/cron/route')

const SECRET = 'test-cron-secret'

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3100/api/cron', { method: 'GET', headers })
}

/** Lets every pending microtask AND timer callback run, so "has it been called
 *  yet?" is answered after the handler has had every chance to call it. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  env.CRON_SECRET = SECRET
  enqueueOwedMessages.mockResolvedValue({ scanned: 3, enqueued: 2 })
  drainOutbox.mockResolvedValue({ attempted: 2, sent: 2, failed: 0, dead: 0 })
  runReconciliationSweep.mockResolvedValue({ reconciled: 1, released: 0, refundsRetried: 0 })
})

describe('GET /api/cron', () => {
  it('refuses a request with no credential, before doing any work', async () => {
    const response = await GET(request())
    expect(response.status).toBe(401)
    expect(enqueueOwedMessages).not.toHaveBeenCalled()
    expect(drainOutbox).not.toHaveBeenCalled()
    expect(runReconciliationSweep).not.toHaveBeenCalled()
  })

  it('refuses a wrong credential', async () => {
    const response = await GET(request({ authorization: 'Bearer wrong-secret' }))
    expect(response.status).toBe(401)
    expect(enqueueOwedMessages).not.toHaveBeenCalled()
  })

  it('refuses a wrong credential of exactly the right length', async () => {
    // 'wrong-secret' above is SHORTER than the real one, so it is refused by
    // the length guard and never reaches the byte comparison at all — a route
    // that compared only lengths, or that returned `true` once the lengths
    // matched, would pass that test and open the door to this one. This
    // differs from the secret in a single character.
    const nearMiss = `${SECRET.slice(0, -1)}X`
    expect(nearMiss).toHaveLength(SECRET.length)
    expect(nearMiss).not.toBe(SECRET)

    const response = await GET(request({ authorization: `Bearer ${nearMiss}` }))

    expect(response.status).toBe(401)
    expect(enqueueOwedMessages).not.toHaveBeenCalled()
  })

  it('refuses the secret without the Bearer scheme', async () => {
    const response = await GET(request({ authorization: SECRET }))
    expect(response.status).toBe(401)
    expect(enqueueOwedMessages).not.toHaveBeenCalled()
  })

  it('refuses everything when the server has no secret configured', async () => {
    // An unset secret must close the door, not open it. This is the assertion
    // that stops a misconfigured deploy exposing an unauthenticated job.
    env.CRON_SECRET = undefined
    const response = await GET(request({ authorization: 'Bearer anything' }))
    expect(response.status).toBe(401)
    expect(enqueueOwedMessages).not.toHaveBeenCalled()
    expect(drainOutbox).not.toHaveBeenCalled()
    expect(runReconciliationSweep).not.toHaveBeenCalled()
  })

  it('refuses the literal "Bearer undefined" when no secret is configured', async () => {
    // The password to an unconfigured deploy, if the comparison is written the
    // obvious way: `header !== \`Bearer ${secret}\`` stringifies an absent
    // secret to "undefined", and that route answers 401 to the 'Bearer
    // anything' probe above while letting this one straight through. Anyone
    // who can guess the URL can guess this header.
    env.CRON_SECRET = undefined
    const response = await GET(request({ authorization: 'Bearer undefined' }))
    expect(response.status).toBe(401)
    expect(enqueueOwedMessages).not.toHaveBeenCalled()
  })

  it('refuses when the configured secret is an empty string', async () => {
    // .env.example ships CRON_SECRET="" and zod's .optional() does not read an
    // empty string as absent, so a deploy that copied the file and never
    // filled it in arrives here with '' rather than undefined. `!secret`
    // closes both; a check written as `secret === undefined` would not say so.
    //
    // Note what this does NOT prove: `Authorization: Bearer ` cannot be used
    // to present the matching empty token, because Headers strips trailing
    // whitespace from a header value, so the byte comparison is never reached
    // with two empty buffers. This is a fence around the intent, not a
    // reproduction of a live hole.
    env.CRON_SECRET = ''
    const response = await GET(request({ authorization: 'Bearer ' }))
    expect(response.status).toBe(401)
    expect(enqueueOwedMessages).not.toHaveBeenCalled()
  })

  it('runs all three arms in order and reports their counts', async () => {
    const response = await GET(request({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sweep: { scanned: 3, enqueued: 2 },
      drain: { attempted: 2, sent: 2, failed: 0, dead: 0 },
      reconcile: { reconciled: 1, released: 0, refundsRetried: 0 },
    })

    // reconcile -> sweep -> drain, each arm reading what the one before it
    // wrote. Reconcile must precede the sweep because it is what flips a
    // booking whose webhook was dropped to `confirmed`; a sweep that ran first
    // would read the stale row and defer that confirmation a whole interval,
    // which for a booking close to its event start is a message lost rather
    // than late. Enqueue must then precede drain for the same reason one step
    // on. Asserted on the pair of gaps, not just the ends, so reordering any
    // single arm fails here.
    expect(runReconciliationSweep.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueOwedMessages.mock.invocationCallOrder[0],
    )
    expect(enqueueOwedMessages.mock.invocationCallOrder[0]).toBeLessThan(
      drainOutbox.mock.invocationCallOrder[0],
    )
  })

  it('waits for the enqueue to finish before it starts the drain', async () => {
    // invocationCallOrder records only when a call STARTED. `Promise.all([
    // enqueue(), drain(), reconcile()])` evaluates its array left to right, so
    // it satisfies the ordering assertion above while draining an outbox the
    // sweep has not finished writing to — which is precisely the "waits a full
    // interval" bug that ordering exists to prevent. Only holding the sweep
    // open catches it.
    let releaseSweep: (value: { scanned: number; enqueued: number }) => void = () => {}
    enqueueOwedMessages.mockReturnValue(
      new Promise((resolve) => {
        releaseSweep = resolve
      }),
    )

    const pending = GET(request({ authorization: `Bearer ${SECRET}` }))
    await settle()

    expect(enqueueOwedMessages).toHaveBeenCalled()
    expect(drainOutbox).not.toHaveBeenCalled()

    releaseSweep({ scanned: 1, enqueued: 1 })
    const body = await (await pending).json()

    expect(drainOutbox).toHaveBeenCalled()
    expect(body.sweep).toEqual({ scanned: 1, enqueued: 1 })
  })

  it('still runs the later arms when an earlier one throws', async () => {
    // One broken arm must not silently stop the ones after it. The sweep is
    // the middle arm, so a database failure there must still leave the drain
    // free to send whatever earlier ticks queued — the outbox is durable, and
    // messages already owed should not wait on today's read succeeding.
    enqueueOwedMessages.mockRejectedValue(new Error('database is down'))

    const response = await GET(request({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(200)
    expect(drainOutbox).toHaveBeenCalled()
    expect(runReconciliationSweep).toHaveBeenCalled()
    const body = await response.json()
    expect(body.sweep).toEqual({ error: 'database is down' })
    expect(body.drain).toMatchObject({ sent: 2 })
  })

  it('isolates every arm, not only the first one', async () => {
    // Breaking only the sweep, as the test above does, is also passed by a
    // route that guards the sweep and leaves the other two bare — nothing else
    // throws there, so nothing else needs a guard to stay green. Break all
    // three: an unguarded arm anywhere makes GET reject instead of answer.
    enqueueOwedMessages.mockRejectedValue(new Error('the sweep could not read bookings'))
    drainOutbox.mockRejectedValue(new Error('the outbox could not be read'))
    runReconciliationSweep.mockRejectedValue(new Error('the sweep could not release holds'))

    const response = await GET(request({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(200)
    expect(drainOutbox).toHaveBeenCalled()
    expect(runReconciliationSweep).toHaveBeenCalled()
    expect(await response.json()).toEqual({
      sweep: { error: 'the sweep could not read bookings' },
      drain: { error: 'the outbox could not be read' },
      reconcile: { error: 'the sweep could not release holds' },
    })
  })
})
