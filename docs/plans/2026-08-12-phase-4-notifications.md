# Phase 4 — Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every outcome this product produces — a confirmed seat, a request waiting on a host, an approval, a waitlist offer, a removal, a decline, tomorrow's event — arrives as a WhatsApp message, over the channel the login OTP already uses.

**Architecture:** Phase 0 built the seam and stopped, so this phase fills it in rather than inventing it. A Meta Cloud API adapter implements the existing `NotificationProvider` interface, and `notificationProvider()` stops throwing for `'meta'`. `message_log` becomes a real outbox: one migration adds an attempt counter, pins the status vocabulary with a CHECK, and adds the drain's partial index. The decision layer is a **pure** module — given booking rows and a clock, which messages are owed and under which `dedupe_key` — so the phase's logic is testable with no database and no provider. A single fenced service module holds the service role, performs the reads that module judges, and owns every write to `message_log`. A cron-invoked API route runs sweep → drain → the reconciliation sweep that has been hand-run since Phase 3. **There are no send sites**: every non-OTP message is derivable from booking state, so `lib/bookings/`, `lib/payments/` and every SQL function are untouched.

**Tech Stack:** Next.js 16.3 App Router, React 19.2, TypeScript, Postgres 17 (local Supabase), supabase-js 2.x, Zod 4, Vitest 4, Vercel Cron. **No new runtime dependencies** — the Meta adapter uses `fetch`.

**Spec:** [`docs/specs/2026-08-12-phase-4-notifications-design.md`](../specs/2026-08-12-phase-4-notifications-design.md)

## Global Constraints

- **The WABA does not exist and no template is approved.** Nothing in this plan may require one. Every test runs against the log provider or a fake; the Meta adapter is tested with `fetch` mocked. Going live is a change of `WHATSAPP_PROVIDER`, not a code change.
- **The OTP path is not to be touched.** `app/api/hooks/send-sms/route.ts` is the one synchronous send and it already works. Its existing tests staying green untouched is this phase's evidence that login was not disturbed.
- **There are no send sites.** Nothing in `lib/bookings/`, `lib/payments/`, `app/e/`, `app/bookings/`, `app/host/` or any `supabase/migrations/*.sql` function changes. If a task seems to need one, the sweep is missing a derivation — fix the sweep.
- **`dedupe_key` is the whole idempotency story.** It is `UNIQUE` on `message_log`. Every enqueue is keyed `booking:<id>:<kind>`, so re-running the sweep, replaying a drain, and running two drains at once all collapse onto one row and one send.
- **The cutoff is load-bearing, not defensive.** The sweep considers only bookings whose event has not started **and** which were created at or after `NOTIFICATIONS_LAUNCH_AT`. Without it the first production run messages every attendee about every past event. A test proves it.
- **`approval_granted` must never be sent for a cash or free approval.** `approve_booking` confirms those straight from `pending_approval`, so there is no payment to complete; they get `booking_confirmed`. This is a routing rule in the sweep, not a copy fix.
- **Nothing is sent for a `waitlisted` row.** Being in a line is not news; a message per join is what would make the queue feel like spam.
- **An attendee's own cancellation sends nothing.** `cancellation_reason` separates `cancelled by host` (notify), `declined by host` (notify, different template), `cancelled by attendee` (silent — they did it), and `payment hold expired` (silent — it is already the whole story on their page).
- **The ESLint admin-import fence grows by exactly one file**, from three to four: `lib/notifications/service.ts` joins `lib/bookings/service.ts`, `lib/checkin/service.ts`, `lib/payments/service.ts`. `eslint.config.mjs:41` and the rule's message string both change. No other file may import `lib/supabase/admin`.
- **Money is integer paise** (`lib/money.ts`); display via `formatPaise`. Template variables are strings — format at the edge, never inside the sweep.
- **Phones come from `profiles.phone`,** which GoTrue stores **without** a leading `+` (`lib/auth/phone-otp.test.ts:69` pins this). Always pass through `normalisePhone` before sending.
- **Apply migrations with `npx supabase migration up` — NOT `supabase db reset`.** The dev database holds live evidence rows the user is keeping: booking `VYRB4SHQ` (confirmed), `9FEQ9S9Y` (refunded), three walkthrough events, 3 payments, 1 refund.
- `npx supabase migration up` will not re-apply an applied file. To amend a function body, edit the migration **and** re-apply just that block via `docker exec -i supabase_db_Event_Hoster psql -U postgres -d postgres`. The file's final state must still apply cleanly to a fresh database.
- **Run `npm run db:types` after the migration.** `lib/supabase/types.ts` is generated and committed, never hand-edited.
- **`npm test` needs `npm run db:start`,** which needs Docker Desktop, which starts only via PowerShell: `powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`. `createTestUser failed: fetch failed` means the stack is down, not an app bug.
- **Commands:** `npx vitest run <file>`, `npm test`, `npm run lint` (bare `eslint` — `npx next lint` does not exist in Next 16), `npm run typecheck` (`next typegen && tsc --noEmit`), `npm run build`.
- **Baseline: 665 tests / 64 files, all green** (at `be47dd8`). Never finish a task with a red suite.
- **Test teardown goes in `afterAll`/`afterEach`, guarded against a seed that was never assigned.** Inline per-test cleanup leaked seven events into the shared dev database during Phase 5b. Scope every delete to rows the file created.
- **Ask of every new assertion: "what wrong implementation would still make this green?"** Where the answer is "a plausible one", strengthen it and prove it by mutating the implementation, confirming red, and reverting. Phase 5b shipped five non-discriminating tests before this became routine.
- **Colours from the `globals.css` tokens**; no hex literals. (Only relevant if a task touches UI — none should.)
- **Work on branch `phase-4-notifications`** (created in Task 1, merged `--no-ff` after the final review).

## File Structure

| File | Responsibility |
|---|---|
| `lib/notifications/providers/meta.ts` | **New.** The Meta Cloud API adapter — the only module that knows Meta's wire format. `fetch` to `/{phone-number-id}/messages` with positional template components. |
| `lib/notifications/index.ts` | **Modified.** `'meta'` stops throwing; `'aisensy'` keeps throwing as the documented escape hatch. |
| `lib/notifications/templates.ts` | **Modified.** `waitlist_seat_offered` and `request_declined` added; two purpose lines corrected. |
| `lib/notifications/sweep.ts` | **New.** Pure: `messagesOwed(rows, now, launchAt)` → the list of `OutboundMessage`s. No I/O, no clock of its own, no provider. |
| `lib/notifications/service.ts` | **New.** The only holder of the service role and the only writer of `message_log`: `enqueueOwedMessages()`, `drainOutbox()`. Joins the ESLint fence. |
| `app/api/cron/route.ts` | **New.** Shared-secret auth, then sweep → drain → reconcile. |
| `supabase/migrations/20260812000001_message_outbox.sql` | **New.** `message_log.attempts`, the status CHECK, the drain's partial index. |
| `lib/env.ts` | **Modified.** `CRON_SECRET`, `NOTIFICATIONS_LAUNCH_AT`. |
| `.env.example` | **Modified.** The same two, documented. |
| `eslint.config.mjs` | **Modified.** The fence's `ignores` list and message string gain the fourth file. |
| `vercel.json` | **New.** The cron schedule. |
| `lib/supabase/types.ts` | **Regenerated.** |

---

### Task 1: The Meta Cloud API adapter

**Files:**
- Create: `lib/notifications/providers/meta.ts`
- Create: `lib/notifications/providers/meta.test.ts`
- Modify: `lib/notifications/index.ts`
- Modify: `lib/notifications/types.ts`

**Interfaces:**
- Consumes: `NotificationProvider`, `OutboundMessage`, `SendResult`, `NotificationError` (`lib/notifications/types.ts`); `templateComponents(name, variables): string[]` (`lib/notifications/templates.ts:104`); `serverEnv()` (`lib/env.ts`).
- Produces:
  - `class MetaNotificationProvider implements NotificationProvider` with `readonly name = 'meta'` and `send(message: OutboundMessage): Promise<SendResult>`.
  - `SendResult` gains `retryable?: boolean` — Task 5's drain uses it to send a permanently-broken message straight to `dead` instead of burning five attempts on it.
  - `notificationProvider()` returns a `MetaNotificationProvider` when `WHATSAPP_PROVIDER=meta`.

**A constraint that feeds back into what gets submitted to Meta.** Utility templates send **body parameters only**. Authentication templates do not: Meta's options are "one-tap autofill, copy code, or no button at all **if using zero-tap**", and zero-tap needs an Android `package_name` and `signature_hash` a web app does not have — so `auth_otp` is registered **with a copy-code OTP button**, and its send payload carries the code **twice**, once in the body parameters and once in `{ "type": "button", "sub_type": "url", "index": "0", … }`. The adapter branches on the template's own `category`, never its name. Task 2 records this in the registry's header for whoever submits it.

- [ ] **Step 1: Branch and confirm the baseline**

```bash
git checkout -b phase-4-notifications
npm run db:start   # Docker via PowerShell first if it is down
npm test           # expect 665 tests / 64 files
```

- [ ] **Step 2: Write the failing adapter tests**

`lib/notifications/providers/meta.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '@/lib/notifications/types'

/**
 * serverEnv() caches its parse in a module-level variable (lib/env.ts), so
 * mutating process.env after the first read changes nothing. Mocking the
 * module is the only way to vary credentials per test — and it also keeps
 * this file from needing a real .env at all.
 */
const env = { WHATSAPP_API_KEY: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '111222333' }
vi.mock('@/lib/env', () => ({ serverEnv: () => env }))

const { MetaNotificationProvider } = await import('@/lib/notifications/providers/meta')

const OK_BODY = {
  messaging_product: 'whatsapp',
  contacts: [{ input: '+919876543210', wa_id: '919876543210' }],
  messages: [{ id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSN' }],
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const message: OutboundMessage = {
  to: '+919876543210',
  template: 'booking_confirmed',
  variables: {
    attendeeName: 'Asha',
    eventTitle: 'Diwali Supper',
    eventDateTime: '12 Aug 2026, 7:00 pm',
    venue: 'The Terrace',
    bookingReference: 'VYRB4SHQ',
  },
  dedupeKey: 'booking:b-1:confirmed',
  bookingId: 'b-1',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  env.WHATSAPP_API_KEY = 'test-token'
  env.WHATSAPP_PHONE_NUMBER_ID = '111222333'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MetaNotificationProvider', () => {
  it('posts the exact shape Meta expects, with components in template order', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY))

    const result = await new MetaNotificationProvider().send(message)

    expect(result).toEqual({
      status: 'sent',
      providerMessageId: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSN',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v25.0/111222333/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    })

    // The whole payload, asserted exactly. A partial match here would let a
    // wrong `type`, a missing `messaging_product`, or components in the wrong
    // ORDER through — and positional {{n}} templates fail silently when the
    // order is wrong, producing a message with the venue where the name goes.
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+919876543210',
      type: 'template',
      template: {
        name: 'booking_confirmed',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Asha' },
              { type: 'text', text: 'Diwali Supper' },
              { type: 'text', text: '12 Aug 2026, 7:00 pm' },
              { type: 'text', text: 'The Terrace' },
              { type: 'text', text: 'VYRB4SHQ' },
            ],
          },
        ],
      },
    })
  })

  it('reports a 5xx as retryable and does not throw', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { message: 'upstream' } }))

    const result = await new MetaNotificationProvider().send(message)

    expect(result.status).toBe('failed')
    expect(result.retryable).toBe(true)
    expect(result.error).toContain('upstream')
  })

  it('reports 429 as retryable — rate limiting is temporary', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'rate limit hit' } }))

    const result = await new MetaNotificationProvider().send(message)
    expect(result).toMatchObject({ status: 'failed', retryable: true })
  })

  it('reports a 4xx as NOT retryable — a bad template never becomes good', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: 'Template name does not exist', code: 132001 } }),
    )

    const result = await new MetaNotificationProvider().send(message)

    expect(result.status).toBe('failed')
    expect(result.retryable).toBe(false)
    expect(result.error).toContain('Template name does not exist')
  })

  it('treats a network throw as retryable rather than letting it escape', async () => {
    // send() must never throw: the drain records a result per message, and one
    // unreachable host must not abort the rest of the batch.
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    const result = await new MetaNotificationProvider().send(message)
    expect(result).toMatchObject({ status: 'failed', retryable: true })
    expect(result.error).toContain('ECONNRESET')
  })

  it('refuses to send when the credentials are absent', async () => {
    env.WHATSAPP_API_KEY = undefined as unknown as string

    const result = await new MetaNotificationProvider().send(message)

    expect(result).toMatchObject({ status: 'failed', retryable: false })
    expect(result.error).toContain('WHATSAPP_API_KEY')
    // Nothing was attempted — a misconfigured server must not burn attempts.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a 200 that carries no message id as a failure', async () => {
    // Meta answering 200 with an unexpected body means we do not have a
    // provider_message_id to record. Calling that "sent" would lose the send.
    fetchMock.mockResolvedValue(jsonResponse(200, { messaging_product: 'whatsapp' }))

    const result = await new MetaNotificationProvider().send(message)
    expect(result).toMatchObject({ status: 'failed', retryable: true })
  })
})
```

- [ ] **Step 3: Run to verify they fail**

```bash
npx vitest run lib/notifications/providers/meta.test.ts
```

Expected: FAIL — the module does not resolve.

- [ ] **Step 4: Widen `SendResult`**

`lib/notifications/types.ts`:

```ts
export interface SendResult {
  status: 'sent' | 'failed' | 'skipped_duplicate'
  providerMessageId?: string
  error?: string
  /**
   * Whether trying again could plausibly succeed. The drain sends a
   * non-retryable failure straight to `dead` rather than spending five
   * attempts discovering that a template name is still wrong.
   *
   * Optional because `status: 'sent'` has nothing to say about it, and
   * because the log provider never fails.
   */
  retryable?: boolean
}
```

- [ ] **Step 5: Write the adapter**

`lib/notifications/providers/meta.ts`:

```ts
import { serverEnv } from '@/lib/env'
import { templateComponents } from '@/lib/notifications/templates'
import type { NotificationProvider, OutboundMessage, SendResult } from '@/lib/notifications/types'

/**
 * The Meta Cloud API, direct.
 *
 * Direct rather than through a BSP because the per-message economics this
 * product is costed on — ~₹0.115 for an authentication or utility template,
 * utility free inside an open 24-hour service window — are Meta's list price,
 * and a BSP adds a monthly platform fee on top of them.
 *
 * The only module in the repo that knows Meta's wire format. Everything else
 * speaks OutboundMessage.
 *
 * Utility templates send BODY PARAMETERS ONLY. Authentication templates also
 * carry a button component repeating the code, because Meta requires a
 * BUTTONS component on every authentication template — "no button at all"
 * applies only to zero-tap, which needs Android identifiers a web app does
 * not have. The branch keys on the registry's own `category`, never on a
 * template's name. See the header in lib/notifications/templates.ts.
 */

/**
 * Pinned rather than floating: Meta ships breaking changes between versions,
 * and a silently-moving URL is a silently-changing payload contract.
 *
 * **Available until 29 July 2028.** The expiry is in this comment because a
 * pin without one stops pinning on a date nobody wrote down: Meta routes
 * calls to an expired version onto the next-oldest usable one *silently*, so
 * the failure is not an error but a different contract than this file claims.
 * Bump before that date, and move the date with it.
 */
const GRAPH_VERSION = 'v25.0'

/** The language a template is registered under. Templates are per-language in
 *  Meta's registry, so this must match what was submitted or the send 404s. */
const TEMPLATE_LANGUAGE = 'en'

export class MetaNotificationProvider implements NotificationProvider {
  readonly name = 'meta'

  /**
   * Never throws. The drain records an outcome per message and one
   * unreachable host must not abort the rest of the batch — so every failure
   * path returns a SendResult instead.
   */
  async send(message: OutboundMessage): Promise<SendResult> {
    const env = serverEnv()
    const token = env.WHATSAPP_API_KEY
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID

    // Both are optional in the schema because the app runs on the log provider
    // long before a WABA exists. Reaching here without them is config drift,
    // and retrying config drift never helps.
    if (!token || !phoneNumberId) {
      return {
        status: 'failed',
        retryable: false,
        error:
          'WHATSAPP_API_KEY and WHATSAPP_PHONE_NUMBER_ID must be set when WHATSAPP_PROVIDER=meta',
      }
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'template',
      template: {
        name: message.template,
        language: { code: TEMPLATE_LANGUAGE },
        components: [
          {
            type: 'body',
            // templateComponents returns the values in the template's declared
            // order, which is what positional {{1}}, {{2}} … means. Building
            // this from Object.values(variables) instead would be correct
            // until someone reorders the object literal.
            parameters: templateComponents(message.template, message.variables).map((text) => ({
              type: 'text',
              text,
            })),
          },
        ],
      },
    }

    let response: Response
    try {
      response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      // DNS, TLS, connection reset. All of them are worth another tick.
      return {
        status: 'failed',
        retryable: true,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    const payload = (await response.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string } }
      | null

    if (!response.ok) {
      // 429 is rate limiting and 5xx is Meta having a bad day; both pass. Every
      // other 4xx is a statement about the request — a template that is not
      // approved, a number not on WhatsApp, an expired token — and repeating
      // it changes nothing.
      const retryable = response.status === 429 || response.status >= 500
      return {
        status: 'failed',
        retryable,
        error: payload?.error?.message ?? `Meta returned ${response.status}`,
      }
    }

    const providerMessageId = payload?.messages?.[0]?.id
    if (!providerMessageId) {
      // A 200 we cannot record. Treated as retryable on purpose: the likeliest
      // cause is a shape change on Meta's side, and the dedupe key means a
      // retry cannot double-send if the first one did land.
      return {
        status: 'failed',
        retryable: true,
        error: 'Meta returned 200 with no message id',
      }
    }

    return { status: 'sent', providerMessageId }
  }
}
```

- [ ] **Step 6: Let the factory build it**

`lib/notifications/index.ts` — the `'meta'` case stops throwing. `'aisensy'` keeps throwing, and its message changes to say why it is still there:

```ts
    case 'meta':
      cached = new MetaNotificationProvider()
      break
    case 'aisensy':
      throw new Error(
        'WHATSAPP_PROVIDER="aisensy" is not implemented. Phase 4 went to the Meta ' +
          'Cloud API direct, because a BSP\'s monthly platform fee is not in this ' +
          "product's per-message costing. The enum member stays as a documented " +
          'escape hatch if Facebook Business verification ever stalls.',
      )
```

with `import { MetaNotificationProvider } from '@/lib/notifications/providers/meta'` at the top.

Update the factory's doc comment: it currently says "Phase 4 adds the Meta Cloud API and BSP adapters here" — Phase 4 added one of them.

- [ ] **Step 7: Green, then commit**

```bash
npx vitest run lib/notifications/providers/meta.test.ts lib/notifications/notifications.test.ts
npm test
npm run lint
npm run typecheck
git add lib/notifications/providers/meta.ts lib/notifications/providers/meta.test.ts \
        lib/notifications/index.ts lib/notifications/types.ts
git commit -m "feat: the Meta Cloud API adapter behind the provider seam"
```

---

### Task 2: The template registry, finished

**Files:**
- Modify: `lib/notifications/templates.ts`
- Create: `lib/notifications/templates.test.ts`

This is the task whose output leaves the repo: the registry is what gets submitted to Meta, and **each approval round costs hours to days**, so the set must be complete and valid before submission. The tests here are less about our code than about catching a template that Meta would reject or that would render wrongly — after which fixing it is not a commit, it is another round.

**Interfaces:**
- Consumes: `TemplateDefinition`, `TEMPLATES`, `renderTemplate`, `templateComponents` (all in `lib/notifications/templates.ts`).
- Produces: `TemplateName` gains `'waitlist_seat_offered'` and `'request_declined'`. Task 4's sweep names all eight.

- [ ] **Step 1: Write the failing tests**

`lib/notifications/templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderTemplate, templateComponents, TEMPLATES } from '@/lib/notifications/templates'

/** Every {{n}} in a body, in the order it appears. */
function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
}

describe('every template is valid for submission to Meta', () => {
  const entries = Object.entries(TEMPLATES)

  it('covers all eight templates', () => {
    // A count, so that deleting one to make another test pass is loud.
    expect(entries).toHaveLength(8)
  })

  it.each(entries)('%s: placeholders are 1..n, in order, each used once', (_name, definition) => {
    const found = placeholders(definition.body)
    const expected = definition.variables.map((_, index) => index + 1)
    // Positional templates are the one place where a reordering is silent:
    // Meta fills {{1}} with whatever we send first, so a body numbered
    // 1,3,2 puts the venue where the name belongs and nothing errors.
    expect(found).toEqual(expected)
  })

  it.each(entries)('%s: body neither starts nor ends with a placeholder', (_name, definition) => {
    // Meta rejects these at submission. Finding out here costs a minute;
    // finding out at submission costs a round trip of hours.
    expect(definition.body.trimStart().startsWith('{{')).toBe(false)
    expect(definition.body.trimEnd().endsWith('}}')).toBe(false)
  })

  it.each(entries)('%s: no two placeholders are adjacent', (_name, definition) => {
    // Also a submission-time rejection: Meta requires literal text between
    // parameters so a reviewer can tell what the message says.
    expect(/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(definition.body)).toBe(false)
  })

  it.each(entries)('%s: name matches its key and is lowercase with underscores', (name, definition) => {
    expect(definition.name).toBe(name)
    expect(definition.name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('sends no marketing templates', () => {
    // Marketing is ~₹0.8631 against ~₹0.115, and this product has nothing to
    // market. A marketing template appearing here is a costing bug.
    expect(entries.filter(([, d]) => d.category === 'marketing')).toHaveLength(0)
  })

  it('keeps auth_otp free of the things authentication templates forbid', () => {
    const { body, category } = TEMPLATES.auth_otp
    expect(category).toBe('authentication')
    expect(body).not.toMatch(/https?:\/\//)
    // Emoji and other non-ASCII are rejected in authentication bodies.
    expect(body).toMatch(/^[\x20-\x7E{}\n]*$/)
  })
})

describe('the two templates Phase 5a and 5b needed', () => {
  it('offers a waitlist seat without mentioning money', () => {
    // One template serves both paths — pay online, or claim a cash/free seat.
    // Naming an amount would need two templates and two approval rounds.
    const rendered = renderTemplate('waitlist_seat_offered', {
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
      deadline: '13 Aug 2026, 7:00 pm',
    })
    expect(rendered).toBe(
      "Hi Asha, a seat opened up for Diwali Supper. It's held for you until " +
        '13 Aug 2026, 7:00 pm — open your booking to take it.',
    )
    expect(rendered).not.toMatch(/₹|\bpay\b/i)
  })

  it('declines a request without claiming a booking was cancelled', () => {
    const rendered = renderTemplate('request_declined', {
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
    })
    expect(rendered).toBe(
      "Hi Asha, Diwali Supper is full this time and the host couldn't fit you in. " +
        "You'll see other events from them soon.",
    )
    // The whole reason this template exists rather than reusing
    // booking_cancelled: nothing was ever booked.
    expect(rendered).not.toMatch(/cancel/i)
  })
})

describe('rendering', () => {
  it('passes components in the template order, not the object order', () => {
    // The object is deliberately shuffled relative to the declared order.
    expect(
      templateComponents('booking_confirmed', {
        bookingReference: 'VYRB4SHQ',
        venue: 'The Terrace',
        attendeeName: 'Asha',
        eventDateTime: '12 Aug 2026, 7:00 pm',
        eventTitle: 'Diwali Supper',
      }),
    ).toEqual(['Asha', 'Diwali Supper', '12 Aug 2026, 7:00 pm', 'The Terrace', 'VYRB4SHQ'])
  })

  it('throws rather than sending a message with a hole in it', () => {
    expect(() =>
      renderTemplate('request_declined', { attendeeName: 'Asha' }),
    ).toThrow('missing variable "eventTitle"')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run lib/notifications/templates.test.ts
```

Expected: FAIL — eight templates expected, six found; the two new names do not exist.

- [ ] **Step 3: Add the two templates**

`lib/notifications/templates.ts`, appended inside `TEMPLATES` after `approval_granted`:

```ts
  waitlist_seat_offered: {
    name: 'waitlist_seat_offered',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle', 'deadline'],
    // Deliberately silent about money so one template serves both paths: an
    // online offer that is paid for, and a cash or free offer that is claimed
    // with a tap. Naming an amount would mean two templates, two approval
    // rounds, and a routing decision at send time.
    body:
      "Hi {{1}}, a seat opened up for {{2}}. It's held for you until {{3}} — " +
      'open your booking to take it.',
    purpose:
      'Sent when the waitlist promotes someone. Without it a freed seat is ' +
      'discovered only by opening the page, which is what Phase 5b named as ' +
      'its worst case: 24 hours lost per inattentive person in the line.',
  },
  request_declined: {
    name: 'request_declined',
    category: 'utility',
    variables: ['attendeeName', 'eventTitle'],
    body:
      "Hi {{1}}, {{2}} is full this time and the host couldn't fit you in. " +
      "You'll see other events from them soon.",
    purpose:
      'Sent when a host declines a request. Separate from booking_cancelled ' +
      'because that one opens "your booking has been cancelled", which is ' +
      'false for someone who asked and was turned down.',
  },
```

- [ ] **Step 4: Correct the two purpose lines**

`booking_confirmed`'s purpose is now wrong about when it fires — it covers four more paths than payment capture:

```ts
    purpose:
      'Sent once a booking reaches confirmed, by any route: payment capture, ' +
      'a free booking, a cash booking, an approved cash-or-free request, or a ' +
      'claimed waitlist seat. Carries the reference; the QR lives in the app.',
```

`approval_granted` gains the routing rule it must not lose, since the template reads as though every approval owes money:

```ts
    purpose:
      'Sent when a host approves a request that still owes an online payment. ' +
      'NOT sent for cash or free approvals: approve_booking confirms those ' +
      'straight from pending_approval, so there is no payment to complete and ' +
      'no hold to beat — they get booking_confirmed instead.',
```

- [ ] **Step 5: Record the button constraint**

In the file's header comment, below the paragraph about India/INR registration:

```ts
 * Register auth_otp WITH a copy-code OTP button:
 *
 *   { "type": "buttons", "buttons": [{ "type": "otp", "otp_type": "copy_code" }] }
 *
 * Not optional, and not a preference. Meta's authentication templates offer a
 * one-tap autofill button, a copy code button, or no button at all ONLY when
 * using zero-tap -- and zero-tap still requires both buttons in the creation
 * payload plus an Android package_name and signature_hash, which a web app
 * does not have. So copy-code is the one reachable option.
 *
 * The send payload therefore carries the code TWICE: once in the body
 * parameters and once in a button component. lib/notifications/providers/meta.ts
 * does this, branching on this registry's own `category` field.
 *
 * The other seven are utility templates and must be created with NO buttons:
 * a send that adds a button component to them is rejected just as surely.
```

- [ ] **Step 6: Green, then commit**

```bash
npx vitest run lib/notifications/templates.test.ts
npm test
git add lib/notifications/templates.ts lib/notifications/templates.test.ts
git commit -m "feat: the waitlist offer and the declined request get their words"
```

- [ ] **Step 7: Hand the submission list to the user**

Not a code step. Print the eight template names, categories and bodies to the terminal so they can be submitted to Meta:

```bash
node --import=tsx -e "const {TEMPLATES}=require('./lib/notifications/templates.ts');for(const t of Object.values(TEMPLATES))console.log(\`\n--- \${t.name} [\${t.category}] ---\n\${t.body}\`)" 2>/dev/null \
  || grep -n "name:\|category:\|body:" lib/notifications/templates.ts
```

Say in the task report that this list is ready for submission, and that `auth_otp` must be created **with a copy-code OTP button** while the other seven are created with **no buttons at all**.

---

### Task 3: `message_log` becomes an outbox

**Files:**
- Create: `supabase/migrations/20260812000001_message_outbox.sql`
- Create: `lib/notifications/outbox-schema.test.ts`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Consumes: `message_log` as created in `supabase/migrations/20260808000001_core_schema.sql:356-371` — **read it first**. It already has `recipient_phone`, `template`, `dedupe_key UNIQUE`, `booking_id`, `provider`, `provider_message_id`, `status` (text, default `'queued'`), `error`, `cost_paise`, timestamps, and a `set_updated_at` trigger.
- Produces: `message_log.attempts integer not null default 0`; `message_log.variables jsonb not null default '{}'::jsonb`; a CHECK pinning `status` to `queued|sent|failed|dead`; `message_log_pending_idx`, partial on the two statuses the drain looks for.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260812000001_message_outbox.sql`:

```sql
-- Phase 4: message_log stops being a table nobody writes and becomes the
-- outbox.
--
-- Phase 0 created it with the right shape and then never wrote a row: a
-- unique dedupe_key, a status defaulting to 'queued', an error column and a
-- booking_id. What it lacks is the two things a queue needs to be drained
-- safely — a count of how many times we have tried, and an index that finds
-- the rows still owing work without scanning the rest.

-- ---------------------------------------------------------------------------
-- attempts
-- ---------------------------------------------------------------------------
-- Without this a permanently-failing message retries until the end of time,
-- once per cron tick, forever. Five rather than three because the drain's
-- interval is hours and not seconds: a transient Meta outage should not
-- exhaust the budget before anybody could notice it. The cap lives in
-- TypeScript (lib/notifications/service.ts) rather than here, because it is a
-- policy about how hard to try, not a fact about the data.

alter table message_log add column attempts integer not null default 0;

-- ---------------------------------------------------------------------------
-- variables
-- ---------------------------------------------------------------------------
-- Without this the outbox cannot work at all. A row records WHICH template to
-- send but not what to fill it with, so a message queued on one tick could not
-- be sent on the next -- the drain would have to re-derive the values from
-- state, which makes the queue a record rather than a queue.
--
-- Stored at enqueue time, deliberately: the message was decided then, and it
-- should say what it said then. A booking that changes shape between the
-- decision and the send does not retroactively rewrite the sentence somebody
-- was owed. It also makes message_log an audit record worth reading -- "what
-- exactly did we tell this person" becomes a query.
--
-- jsonb rather than text: it is read back as an object and handed straight to
-- the provider, and jsonb refuses malformed input at write time.

alter table message_log add column variables jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- The status vocabulary
-- ---------------------------------------------------------------------------
-- status has been free text defaulting to 'queued' since Phase 0. The drain
-- uses exactly four values and branches on them, so a typo in an UPDATE would
-- silently take a row out of circulation without ever reporting a failure.
--
-- A CHECK rather than an enum, deliberately: adding a fifth state later is one
-- migration that rewrites the constraint, where an enum needs the two-file
-- dance Phase 5b had to do for booking_status (Postgres cannot add an enum
-- value and use it in the same transaction).
--
-- The table has never been written to, so this cannot fail on existing rows.

alter table message_log add constraint message_log_status_known
  check (status in ('queued', 'sent', 'failed', 'dead'));

-- ---------------------------------------------------------------------------
-- The drain's index
-- ---------------------------------------------------------------------------
-- Partial on the two statuses that still owe work, so it stays small however
-- many messages have been sent — the same reasoning as bookings_expiring_idx
-- in the core schema. Ordered by updated_at so the drain takes the longest-
-- waiting first and one hot failure cannot starve the queue behind it.

create index message_log_pending_idx
  on message_log (status, updated_at)
  where status in ('queued', 'failed');
```

No grants and no RLS policy: `message_log` is service-role only and stays that way, exactly as `fee_rules` and `provider_webhook_events` are. `lib/supabase/rls.test.ts:280` already asserts the three are unreachable to a signed-in user; that test must still pass untouched.

- [ ] **Step 2: Apply it and regenerate types**

```bash
npx supabase migration up   # NOT db reset -- the dev DB holds kept evidence rows
npm run db:types
git diff --stat lib/supabase/types.ts   # message_log gains `attempts`
```

- [ ] **Step 3: Write the schema tests**

`lib/notifications/outbox-schema.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { adminClient } from '@/tests/helpers/db'

const db = adminClient()

/** Rows this file created, cleaned up even when an assertion fails. */
const created: string[] = []

afterEach(async () => {
  if (created.length > 0) {
    await db.from('message_log').delete().in('dedupe_key', created)
    created.length = 0
  }
})

async function insert(row: Record<string, unknown>) {
  if (typeof row.dedupe_key === 'string') created.push(row.dedupe_key)
  return db.from('message_log').insert(row).select().single()
}

describe('message_log as an outbox', () => {
  it('defaults a new row to queued with no attempts and no variables', async () => {
    const { data, error } = await insert({
      dedupe_key: 'test:schema:defaults',
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({ status: 'queued', attempts: 0, variables: {} })
  })

  it('round-trips the template variables it was queued with', async () => {
    // The column the outbox cannot work without: a row says WHICH template,
    // and this says what to fill it with. Re-deriving at drain time would make
    // the queue a record rather than a queue.
    const variables = {
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
      eventDateTime: '19 Aug 2026, 7:00 pm',
      venue: 'The Terrace',
      bookingReference: 'VYRB4SHQ',
    }
    const { data, error } = await insert({
      dedupe_key: 'test:schema:variables',
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
      variables,
    })
    expect(error).toBeNull()
    expect(data!.variables).toEqual(variables)
  })

  it('refuses a status outside the vocabulary the drain branches on', async () => {
    const { error } = await insert({
      dedupe_key: 'test:schema:bad-status',
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
      status: 'delivered',
    })
    // Without the CHECK this insert succeeds and the row silently leaves
    // circulation — never drained, never reported as failed.
    expect(error?.message).toContain('message_log_status_known')
  })

  it('accepts each of the four the drain uses', async () => {
    for (const status of ['queued', 'sent', 'failed', 'dead']) {
      const { error } = await insert({
        dedupe_key: `test:schema:${status}`,
        recipient_phone: '+919876543210',
        template: 'booking_confirmed',
        status,
      })
      expect(error, `status ${status} should be allowed`).toBeNull()
    }
  })

  it('refuses a second row with the same dedupe key', async () => {
    const first = await insert({
      dedupe_key: 'test:schema:dupe',
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })
    expect(first.error).toBeNull()

    const { error } = await db.from('message_log').insert({
      dedupe_key: 'test:schema:dupe',
      recipient_phone: '+919876543210',
      template: 'booking_confirmed',
    })
    // This constraint is the entire idempotency story for the phase: it is
    // what makes re-running the sweep and running two drains at once safe.
    expect(error?.code).toBe('23505')
  })

})
```

> No test here asserts the index's own definition: supabase-js cannot read `pg_indexes`, and adding an RPC so a test could would mean new production surface built for a test. `message_log_pending_idx` is verified against a fresh database in Task 7, where `psql` is available.

- [ ] **Step 4: Green, then commit**

```bash
npx vitest run lib/notifications/outbox-schema.test.ts lib/supabase/rls.test.ts
npm test
git add supabase/migrations/20260812000001_message_outbox.sql \
        lib/notifications/outbox-schema.test.ts lib/supabase/types.ts
git commit -m "feat: message_log gains an attempt count, a vocabulary and the drain's index"
```

---

### Task 4: The sweep — the pure decision layer

**Files:**
- Create: `lib/notifications/sweep.ts`
- Create: `lib/notifications/sweep.test.ts`

This is where the phase's judgement lives, and it is deliberately pure: no database, no provider, no clock of its own. Everything it decides is a function of rows and two timestamps, so it can be tested exhaustively in milliseconds — which matters, because the table below is the whole feature and a wrong row here is a message sent to the wrong person or not at all.

**Interfaces:**
- Consumes: `OutboundMessage` (`lib/notifications/types.ts`), `TemplateName`, `normalisePhone`, `formatPaise` (`lib/money.ts`), `formatIst` (`lib/events/datetime.ts`).
- Produces:
  - `interface SweepBooking` — the row shape Task 5's reader must supply.
  - `messagesOwed(bookings: SweepBooking[], options: { now: Date; launchAt: Date; reminderWindowHours?: number }): OutboundMessage[]`

**The derivation, in full.** Two gates first, applied to every row: skip if the event has already started (`starts_at <= now`), and skip if the booking predates `launchAt`. Then:

| Status | Extra condition | Template | Recipient | `dedupe_key` suffix |
|---|---|---|---|---|
| `confirmed` | — | `booking_confirmed` | attendee | `:confirmed` |
| `confirmed` | starts within the reminder window | `event_reminder` | attendee | `:reminder` |
| `pending_approval` | — | `approval_requested` | **host** | `:requested` |
| `awaiting_payment` | `approved_at` set, event `has_waitlist` | `waitlist_seat_offered` | attendee | `:offered` |
| `awaiting_payment` | `approved_at` set, event `requires_approval` | `approval_granted` | attendee | `:approved` |
| `cancelled` or `refunded` | reason `cancelled by host` | `booking_cancelled` | attendee | `:cancelled` |
| `cancelled` | reason `declined by host` | `request_declined` | attendee | `:declined` |
| anything else | — | nothing | — | — |

A `confirmed` booking inside the reminder window yields **two** messages, which is correct — they are different messages with different keys, and the outbox will have already sent the first one on an earlier tick.

**Three traps this task must not fall into:**

1. **`refunded` is a cancelled booking whose money moved.** `refundIfOwed` (`lib/payments/service.ts:516`) flips `cancelled` → `refunded` at refund creation, leaving `cancellation_reason` intact. Matching only `cancelled` skips every *paid* host removal — the one case where the attendee most needs telling.
2. **`awaiting_payment` + `approved_at` is two different messages**, separated by the event's flags, which `events_one_queue` keeps mutually exclusive. Cash and free approvals never reach this state at all (`approve_booking` confirms them straight from `pending_approval`), so no amount check is needed — but a comment must say so, or someone will add one.
3. **An attendee's own cancellation must send nothing.** The reason string is the only thing that distinguishes it.

- [ ] **Step 1: Write the failing tests**

`lib/notifications/sweep.test.ts`. Pure and fast — no `tests/helpers/db` import, no Supabase:

```ts
import { describe, expect, it } from 'vitest'
import { messagesOwed, type SweepBooking } from '@/lib/notifications/sweep'

const NOW = new Date('2026-08-12T06:00:00Z')
const LAUNCH = new Date('2026-08-01T00:00:00Z')
const options = { now: NOW, launchAt: LAUNCH }

/** A confirmed booking on an event a week out. Override one field per test. */
function booking(overrides: Partial<SweepBooking> = {}): SweepBooking {
  return {
    id: 'b-1',
    reference: 'VYRB4SHQ',
    status: 'confirmed',
    cancellation_reason: null,
    approved_at: null,
    payment_mode: 'online',
    total_paise: 50_000,
    quantity: 2,
    attendee_name: 'Asha',
    attendee_phone: '919876543210',
    created_at: '2026-08-10T00:00:00Z',
    hold_expires_at: null,
    event: {
      title: 'Diwali Supper',
      starts_at: '2026-08-19T13:30:00Z',
      venue_name: 'The Terrace',
      city: 'Indore',
      requires_approval: false,
      has_waitlist: false,
      host_phone: '919000000001',
      host_display_name: 'Ravi',
    },
    ...overrides,
  }
}

describe('the two gates', () => {
  it('says nothing about an event that has already started', () => {
    // The WhatsApp link outlives the event; a reminder for last night is worse
    // than silence.
    expect(
      messagesOwed([booking({ event: { ...booking().event, starts_at: '2026-08-11T13:30:00Z' } })], options),
    ).toEqual([])
  })

  it('says nothing about a booking made before the launch timestamp', () => {
    // THE test that stops the first production run messaging every attendee
    // about every event this product has ever run.
    expect(messagesOwed([booking({ created_at: '2026-07-30T00:00:00Z' })], options)).toEqual([])
  })

  it('includes a booking made exactly at the launch timestamp', () => {
    // Inclusive boundary, so a booking made in the same second the phase went
    // live is not silently dropped.
    const owed = messagesOwed([booking({ created_at: LAUNCH.toISOString() })], options)
    expect(owed.map((m) => m.template)).toContain('booking_confirmed')
  })
})

describe('confirmed bookings', () => {
  it('owes a confirmation, addressed to the attendee in E.164', () => {
    const [message] = messagesOwed([booking()], options)
    expect(message).toMatchObject({
      to: '+919876543210', // profiles.phone has no '+'; normalisePhone adds it
      template: 'booking_confirmed',
      dedupeKey: 'booking:b-1:confirmed',
      bookingId: 'b-1',
    })
    expect(message.variables).toEqual({
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
      eventDateTime: expect.stringContaining('19 Aug 2026'),
      venue: 'The Terrace',
      bookingReference: 'VYRB4SHQ',
    })
  })

  it('falls back to the city when an event has no venue name', () => {
    const [message] = messagesOwed(
      [booking({ event: { ...booking().event, venue_name: null } })],
      options,
    )
    expect(message.variables.venue).toBe('Indore')
  })

  it('calls an unnamed attendee Guest rather than sending "Hi null"', () => {
    const [message] = messagesOwed([booking({ attendee_name: null })], options)
    expect(message.variables.attendeeName).toBe('Guest')
  })

  it('adds a reminder once the event is inside the window, and not before', () => {
    const outside = messagesOwed([booking()], options).map((m) => m.template)
    expect(outside).toEqual(['booking_confirmed'])

    const soon = booking({ event: { ...booking().event, starts_at: '2026-08-13T02:00:00Z' } })
    const inside = messagesOwed([soon], options)
    expect(inside.map((m) => m.template)).toEqual(['booking_confirmed', 'event_reminder'])
    // Different keys, so the confirmation already sent on an earlier tick is
    // not re-sent and the reminder is not suppressed by it.
    expect(inside.map((m) => m.dedupeKey)).toEqual([
      'booking:b-1:confirmed',
      'booking:b-1:reminder',
    ])
  })
})

describe('the approval queue', () => {
  it('tells the HOST about a pending request, not the attendee', () => {
    const [message] = messagesOwed(
      [booking({ status: 'pending_approval', event: { ...booking().event, requires_approval: true } })],
      options,
    )
    expect(message).toMatchObject({
      to: '+919000000001', // the host's number
      template: 'approval_requested',
      dedupeKey: 'booking:b-1:requested',
    })
    expect(message.variables).toEqual({
      hostName: 'Ravi',
      attendeeName: 'Asha',
      eventTitle: 'Diwali Supper',
    })
  })

  it('tells the attendee they are approved, with the deadline', () => {
    const [message] = messagesOwed(
      [
        booking({
          status: 'awaiting_payment',
          approved_at: '2026-08-12T05:00:00Z',
          hold_expires_at: '2026-08-13T05:00:00Z',
          event: { ...booking().event, requires_approval: true },
        }),
      ],
      options,
    )
    expect(message).toMatchObject({
      to: '+919876543210',
      template: 'approval_granted',
      dedupeKey: 'booking:b-1:approved',
    })
    expect(message.variables.paymentDeadline).toContain('13 Aug 2026')
  })
})

describe('the waitlist', () => {
  it('offers the seat, and says nothing about money', () => {
    const [message] = messagesOwed(
      [
        booking({
          status: 'awaiting_payment',
          approved_at: '2026-08-12T05:00:00Z',
          hold_expires_at: '2026-08-13T05:00:00Z',
          event: { ...booking().event, has_waitlist: true },
        }),
      ],
      options,
    )
    expect(message).toMatchObject({
      template: 'waitlist_seat_offered',
      dedupeKey: 'booking:b-1:offered',
    })
    expect(Object.keys(message.variables).sort()).toEqual([
      'attendeeName',
      'deadline',
      'eventTitle',
    ])
  })

  it('says nothing at all about someone merely standing in the line', () => {
    // A message per join is the one thing that would make a queue feel like
    // spam, and being in a line is not news.
    expect(messagesOwed([booking({ status: 'waitlisted' })], options)).toEqual([])
  })

  it('does not confuse an approval with an offer, in either direction', () => {
    const shared = {
      status: 'awaiting_payment',
      approved_at: '2026-08-12T05:00:00Z',
      hold_expires_at: '2026-08-13T05:00:00Z',
    }
    const offer = messagesOwed(
      [booking({ ...shared, event: { ...booking().event, has_waitlist: true } })],
      options,
    )
    const approval = messagesOwed(
      [booking({ ...shared, event: { ...booking().event, requires_approval: true } })],
      options,
    )
    expect(offer[0].template).toBe('waitlist_seat_offered')
    expect(approval[0].template).toBe('approval_granted')
  })

  it('owes nothing for an awaiting_payment hold that was never approved', () => {
    // A plain Phase 3 checkout hold. approved_at is what separates it.
    expect(messagesOwed([booking({ status: 'awaiting_payment' })], options)).toEqual([])
  })
})

describe('endings', () => {
  it('tells a removed guest, and says the money is coming when it is', () => {
    // refundIfOwed flips a paid cancellation to 'refunded' and leaves the
    // reason intact. Matching only 'cancelled' would skip every PAID removal.
    const [message] = messagesOwed(
      [booking({ status: 'refunded', cancellation_reason: 'cancelled by host' })],
      options,
    )
    expect(message).toMatchObject({
      template: 'booking_cancelled',
      dedupeKey: 'booking:b-1:cancelled',
    })
    expect(message.variables.refundNote).toBe('₹500 will be refunded.')
  })

  it('tells a removed guest when no money was involved, without promising any', () => {
    const [message] = messagesOwed(
      [booking({ status: 'cancelled', cancellation_reason: 'cancelled by host', total_paise: 0 })],
      options,
    )
    expect(message.variables.refundNote).toBe('No payment was taken.')
  })

  it('declines a request in its own words', () => {
    const [message] = messagesOwed(
      [booking({ status: 'cancelled', cancellation_reason: 'declined by host' })],
      options,
    )
    expect(message).toMatchObject({
      template: 'request_declined',
      dedupeKey: 'booking:b-1:declined',
    })
  })

  it('says nothing when the attendee cancelled it themselves', () => {
    // They did it. Telling them is noise.
    expect(
      messagesOwed([booking({ status: 'cancelled', cancellation_reason: 'cancelled by attendee' })], options),
    ).toEqual([])
  })

  it('says nothing when a hold simply expired', () => {
    // Already the whole story on their own page, and nobody chose it.
    expect(
      messagesOwed([booking({ status: 'expired', cancellation_reason: 'payment hold expired' })], options),
    ).toEqual([])
  })

  it('says nothing for a cancellation with no reason recorded', () => {
    // Fails closed: an unrecognised reason is not an excuse to guess which of
    // four sentences applies.
    expect(messagesOwed([booking({ status: 'cancelled', cancellation_reason: null })], options)).toEqual([])
  })
})

describe('batches', () => {
  it('keeps every row independent and preserves input order', () => {
    const owed = messagesOwed(
      [
        booking({ id: 'b-1' }),
        booking({ id: 'b-2', status: 'waitlisted' }),
        booking({ id: 'b-3', status: 'cancelled', cancellation_reason: 'declined by host' }),
      ],
      options,
    )
    expect(owed.map((m) => m.dedupeKey)).toEqual([
      'booking:b-1:confirmed',
      'booking:b-3:declined',
    ])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run lib/notifications/sweep.test.ts
```

- [ ] **Step 3: Write the sweep**

`lib/notifications/sweep.ts`:

```ts
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { normalisePhone } from '@/lib/notifications/types'
import type { OutboundMessage } from '@/lib/notifications/types'

/**
 * What the product owes people, derived from state.
 *
 * Pure on purpose. There are no send sites anywhere in this codebase: nothing
 * in lib/bookings, lib/payments or any SQL function knows that notifications
 * exist. Instead this module is handed rows and a clock and says which
 * messages are owed, which means the whole feature can be tested in
 * milliseconds without a database or a provider — and that messages are owed
 * for bookings that already existed before this phase shipped, not only for
 * ones created after it.
 *
 * Every decision is keyed `booking:<id>:<kind>`, and message_log.dedupe_key is
 * UNIQUE, so running this twice, or running two drains at once, converges on
 * one message.
 */

/** How long before an event the reminder goes out. */
const DEFAULT_REMINDER_WINDOW_HOURS = 24

export interface SweepBooking {
  id: string
  reference: string
  status: string
  cancellation_reason: string | null
  approved_at: string | null
  payment_mode: string
  total_paise: number
  quantity: number
  attendee_name: string | null
  /** profiles.phone. GoTrue stores it WITHOUT a leading '+'. */
  attendee_phone: string
  created_at: string
  hold_expires_at: string | null
  event: {
    title: string
    starts_at: string
    venue_name: string | null
    city: string
    requires_approval: boolean
    has_waitlist: boolean
    /** profiles.phone of the host, for the one message they receive. */
    host_phone: string
    host_display_name: string
  }
}

export interface SweepOptions {
  now: Date
  /**
   * Bookings created before this are ignored. Without it the first run
   * messages every attendee about every event this product has ever run.
   */
  launchAt: Date
  reminderWindowHours?: number
}

/** What a host reads at the door, and what a template says "Hi" to. */
function displayName(booking: SweepBooking): string {
  return booking.attendee_name?.trim() || 'Guest'
}

/** Venue name if there is one, else the city — never an empty line. */
function venueOf(booking: SweepBooking): string {
  return booking.event.venue_name?.trim() || booking.event.city
}

/**
 * What the cancellation did to their money. `refunded` means the refund was
 * created — settlement lag lives in refunds.status, and promising "refunded"
 * at creation is the same claim the booking page already makes.
 */
function refundNote(booking: SweepBooking): string {
  if (booking.status === 'refunded' && booking.total_paise > 0) {
    return `${formatPaise(booking.total_paise)} will be refunded.`
  }
  return 'No payment was taken.'
}

export function messagesOwed(
  bookings: SweepBooking[],
  options: SweepOptions,
): OutboundMessage[] {
  const { now, launchAt } = options
  const windowHours = options.reminderWindowHours ?? DEFAULT_REMINDER_WINDOW_HOURS
  const owed: OutboundMessage[] = []

  for (const booking of bookings) {
    const startsAt = new Date(booking.event.starts_at)

    // Gate one: the event is over, or under way. A WhatsApp link outlives its
    // event, and so does a bookings row; a reminder for last night is worse
    // than silence.
    if (startsAt.getTime() <= now.getTime()) continue

    // Gate two: the cutoff. Inclusive, so a booking made in the same second
    // the phase went live is not dropped.
    if (new Date(booking.created_at).getTime() < launchAt.getTime()) continue

    const attendee = normalisePhone(booking.attendee_phone)
    const base = { bookingId: booking.id }
    const eventDateTime = formatIst(startsAt)

    if (booking.status === 'confirmed') {
      owed.push({
        ...base,
        to: attendee,
        template: 'booking_confirmed',
        dedupeKey: `booking:${booking.id}:confirmed`,
        variables: {
          attendeeName: displayName(booking),
          eventTitle: booking.event.title,
          eventDateTime,
          venue: venueOf(booking),
          bookingReference: booking.reference,
        },
      })

      const hoursAway = (startsAt.getTime() - now.getTime()) / 3_600_000
      if (hoursAway <= windowHours) {
        owed.push({
          ...base,
          to: attendee,
          template: 'event_reminder',
          dedupeKey: `booking:${booking.id}:reminder`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            eventDateTime,
            venue: venueOf(booking),
          },
        })
      }
      continue
    }

    if (booking.status === 'pending_approval') {
      // The one message in the product addressed to the host.
      owed.push({
        ...base,
        to: normalisePhone(booking.event.host_phone),
        template: 'approval_requested',
        dedupeKey: `booking:${booking.id}:requested`,
        variables: {
          hostName: booking.event.host_display_name,
          attendeeName: displayName(booking),
          eventTitle: booking.event.title,
        },
      })
      continue
    }

    if (booking.status === 'awaiting_payment' && booking.approved_at) {
      // Both queues leave a booking in exactly this shape — that reuse is the
      // whole of Phase 5b's design — so the event's flags are what separate
      // them, and events_one_queue keeps those mutually exclusive.
      //
      // No amount or payment_mode check is needed on the approval arm:
      // approve_booking confirms cash and free requests straight from
      // pending_approval, so they never reach awaiting_payment at all.
      const deadline = booking.hold_expires_at ? formatIst(new Date(booking.hold_expires_at)) : ''

      if (booking.event.has_waitlist) {
        owed.push({
          ...base,
          to: attendee,
          template: 'waitlist_seat_offered',
          dedupeKey: `booking:${booking.id}:offered`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            deadline,
          },
        })
      } else if (booking.event.requires_approval) {
        owed.push({
          ...base,
          to: attendee,
          template: 'approval_granted',
          dedupeKey: `booking:${booking.id}:approved`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            paymentDeadline: deadline,
          },
        })
      }
      continue
    }

    // 'refunded' is a cancelled booking whose money moved: refundIfOwed flips
    // cancelled -> refunded at refund CREATION and leaves cancellation_reason
    // alone. Matching only 'cancelled' here would skip every paid host
    // removal, which is the one case where the attendee most needs telling.
    if (booking.status === 'cancelled' || booking.status === 'refunded') {
      if (booking.cancellation_reason === 'cancelled by host') {
        owed.push({
          ...base,
          to: attendee,
          template: 'booking_cancelled',
          dedupeKey: `booking:${booking.id}:cancelled`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
            refundNote: refundNote(booking),
          },
        })
      } else if (booking.cancellation_reason === 'declined by host') {
        // A request never held a payment, so it can never be 'refunded' —
        // and it was never a booking, which is why booking_cancelled's
        // opening sentence would be false for it.
        owed.push({
          ...base,
          to: attendee,
          template: 'request_declined',
          dedupeKey: `booking:${booking.id}:declined`,
          variables: {
            attendeeName: displayName(booking),
            eventTitle: booking.event.title,
          },
        })
      }
      // Any other reason — 'cancelled by attendee', 'payment hold expired',
      // or none recorded — sends nothing. They did it, or it is already the
      // whole story on their page.
    }
  }

  return owed
}
```

- [ ] **Step 4: Green, then prove the tests discriminate**

```bash
npx vitest run lib/notifications/sweep.test.ts
```

Then mutate and confirm each goes red, reverting after every one:

| Mutation | Must fail |
|---|---|
| Drop the `launchAt` gate | the cutoff test |
| Drop the `startsAt <= now` gate | the started-event test |
| Match only `'cancelled'`, not `'refunded'` | the paid-removal test |
| Swap the `has_waitlist` / `requires_approval` arms | the not-confused-in-either-direction test |
| Send on `cancelled by attendee` too | the silence test |

Record the results in the report. If any mutation leaves the suite green, that test is not doing its job — strengthen it before moving on.

- [ ] **Step 5: Commit**

```bash
npm test
npm run lint
npm run typecheck
git add lib/notifications/sweep.ts lib/notifications/sweep.test.ts
git commit -m "feat: what the product owes people, derived from state"
```

---

### Task 5: The service — the only holder of the service role

**Files:**
- Create: `lib/notifications/service.ts`
- Create: `lib/notifications/service.test.ts`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: `createAdminClient` (`lib/supabase/admin.ts`), `messagesOwed` / `SweepBooking` (Task 4), `notificationProvider()` (Task 1), `OutboundMessage` / `SendResult` (`lib/notifications/types.ts`).
- Produces:
  - `enqueueOwedMessages(options?: { now?: Date }): Promise<{ scanned: number; enqueued: number }>`
  - `drainOutbox(options?: { limit?: number }): Promise<{ attempted: number; sent: number; failed: number; dead: number }>`
  - `MAX_ATTEMPTS = 5`

**The fence grows by one file, and this is the only place it does.** `eslint.config.mjs:41` lists the three modules allowed to import `lib/supabase/admin`; `lib/notifications/service.ts` becomes the fourth. Update both the `ignores` array and the rule's `message` string, which names the allowed files to whoever trips it — a message that lists three files while four are permitted is worse than no message.

- [ ] **Step 0: Add the cutoff environment variable**

`enqueueOwedMessages` reads it, so it must exist before this task's tests can run. (`CRON_SECRET` is Task 6's, because that is where it is first read.)

`lib/env.ts`, in `serverSchema`:

```ts
  // Bookings created before this instant are invisible to the notification
  // sweep. Without it the first run messages every attendee about every event
  // this product has ever run. ISO 8601; z.iso.datetime() rejects a date-only
  // value, which would otherwise be read as midnight UTC and silently shift
  // the cutoff by up to a day.
  NOTIFICATIONS_LAUNCH_AT: z.iso.datetime().default('2026-08-12T00:00:00Z'),
```

`.env.example`, after the WhatsApp block:

```bash
# --- Notifications (Phase 4) ---
# Bookings created before this instant are invisible to the notification
# sweep. Set it once, to the moment Phase 4 goes live. Moving it backwards
# will message people about events they booked long ago.
NOTIFICATIONS_LAUNCH_AT="2026-08-12T00:00:00Z"
```

- [ ] **Step 1: Widen the fence**

`eslint.config.mjs`:

```js
    ignores: ["lib/bookings/service.ts", "lib/checkin/service.ts", "lib/payments/service.ts", "lib/notifications/service.ts", "lib/supabase/admin.ts"],
```

and the message:

```js
          message:
            "Only lib/bookings/service.ts, lib/checkin/service.ts, lib/payments/service.ts and lib/notifications/service.ts may use the service role. Use @/lib/supabase/server, or add the write to one of those modules.",
```

Also extend the comment above the rule: notifications joins the list because `message_log` has no RLS policy at all — it is service-role only, exactly like `fee_rules` and `provider_webhook_events` — and because the sweep reads across every attendee and host on an event, which is not a scope any signed-in caller has.

- [ ] **Step 2: Write the failing tests**

`lib/notifications/service.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, createTestUser, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { __setNotificationProvider } from '@/lib/notifications'
import type { NotificationProvider, OutboundMessage, SendResult } from '@/lib/notifications/types'
import { drainOutbox, enqueueOwedMessages, MAX_ATTEMPTS } from '@/lib/notifications/service'

const db = adminClient()

/** A provider a test can steer. */
class FakeProvider implements NotificationProvider {
  readonly name = 'fake'
  readonly sent: OutboundMessage[] = []
  result: SendResult = { status: 'sent', providerMessageId: 'fake-1' }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message)
    return this.result
  }
}

let provider: FakeProvider
let seed: SeededEvent
let filler = ''

/** Every dedupe key this file created, so teardown is exact. */
async function clearMessages(): Promise<void> {
  if (!seed) return
  const { data } = await db.from('bookings').select('id').eq('event_id', seed.eventId)
  const ids = (data ?? []).map((b) => b.id)
  if (ids.length > 0) await db.from('message_log').delete().in('booking_id', ids)
}

beforeAll(async () => {
  seed = await seedEvent(db, { quantity: 5, pricePaise: 50_000 })
  filler = await createTestUser(db)
})

afterEach(async () => {
  await clearMessages()
})

afterAll(async () => {
  if (!seed) return
  await clearMessages()
  await db.from('bookings').delete().eq('event_id', seed.eventId)
  await cleanupEvent(db, seed)
  if (filler) await db.auth.admin.deleteUser(filler).catch(() => {})
  __setNotificationProvider(undefined)
})

beforeEach(() => {
  provider = new FakeProvider()
  __setNotificationProvider(provider)
})

/** A confirmed booking on the seeded event. */
async function confirmedBooking(attendeeId: string): Promise<string> {
  const { data, error } = await db.rpc('begin_paid_booking', {
    p_ticket_type_id: seed.ticketTypeId,
    p_attendee_id: attendeeId,
    p_quantity: 1,
    p_attendee_name: 'Asha',
  })
  if (error) throw new Error(`setup booking failed: ${error.message}`)
  await db.rpc('confirm_booking', { p_booking_id: data!.id })
  return data!.id
}

describe('enqueueOwedMessages', () => {
  it('writes a queued row carrying the template and its variables', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)

    const result = await enqueueOwedMessages()
    expect(result.enqueued).toBeGreaterThanOrEqual(1)

    const { data } = await db
      .from('message_log')
      .select('*')
      .eq('dedupe_key', `booking:${bookingId}:confirmed`)
      .single()

    expect(data).toMatchObject({
      status: 'queued',
      attempts: 0,
      template: 'booking_confirmed',
      booking_id: bookingId,
    })
    expect(data!.recipient_phone).toMatch(/^\+91/)
    expect(data!.variables).toMatchObject({ attendeeName: 'Asha', bookingReference: expect.any(String) })
    // Enqueue does NOT send. That is the drain's job, and conflating them is
    // what would put a Meta call back on a user-facing path.
    expect(provider.sent).toHaveLength(0)
  })

  it('is idempotent — running it twice enqueues once', async () => {
    await confirmedBooking(seed.attendeeId)

    const first = await enqueueOwedMessages()
    const second = await enqueueOwedMessages()

    expect(first.enqueued).toBeGreaterThanOrEqual(1)
    expect(second.enqueued).toBe(0)

    const { count } = await db
      .from('message_log')
      .select('*', { count: 'exact', head: true })
      .eq('template', 'booking_confirmed')
    expect(count).toBe(1)
  })

  it('respects the cutoff', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    // Backdate the booking to before the launch timestamp.
    await db
      .from('bookings')
      .update({ created_at: new Date('2000-01-01T00:00:00Z').toISOString() })
      .eq('id', bookingId)

    await enqueueOwedMessages()

    const { count } = await db
      .from('message_log')
      .select('*', { count: 'exact', head: true })
      .eq('booking_id', bookingId)
    expect(count).toBe(0)
  })
})

describe('drainOutbox', () => {
  it('sends a queued row and marks it sent with the provider id', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    await enqueueOwedMessages()

    const result = await drainOutbox()
    expect(result.sent).toBeGreaterThanOrEqual(1)

    expect(provider.sent[0]).toMatchObject({
      template: 'booking_confirmed',
      dedupeKey: `booking:${bookingId}:confirmed`,
    })
    // The variables came back out of the row, not out of a re-derivation.
    expect(provider.sent[0].variables.attendeeName).toBe('Asha')

    const { data } = await db
      .from('message_log')
      .select('status, attempts, provider_message_id, provider')
      .eq('dedupe_key', `booking:${bookingId}:confirmed`)
      .single()
    expect(data).toMatchObject({
      status: 'sent',
      attempts: 1,
      provider_message_id: 'fake-1',
      provider: 'fake',
    })
  })

  it('does not re-send a row it already sent', async () => {
    await confirmedBooking(seed.attendeeId)
    await enqueueOwedMessages()
    await drainOutbox()
    const afterFirst = provider.sent.length

    await drainOutbox()
    expect(provider.sent).toHaveLength(afterFirst)
  })

  it('records a retryable failure and tries again on the next drain', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    await enqueueOwedMessages()

    provider.result = { status: 'failed', retryable: true, error: 'upstream' }
    await drainOutbox()

    const { data: first } = await db
      .from('message_log')
      .select('status, attempts, error')
      .eq('dedupe_key', `booking:${bookingId}:confirmed`)
      .single()
    expect(first).toMatchObject({ status: 'failed', attempts: 1, error: 'upstream' })

    provider.result = { status: 'sent', providerMessageId: 'fake-2' }
    await drainOutbox()

    const { data: second } = await db
      .from('message_log')
      .select('status, attempts')
      .eq('dedupe_key', `booking:${bookingId}:confirmed`)
      .single()
    expect(second).toMatchObject({ status: 'sent', attempts: 2 })
  })

  it('kills a non-retryable failure immediately rather than burning five ticks', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    await enqueueOwedMessages()

    provider.result = { status: 'failed', retryable: false, error: 'Template name does not exist' }
    await drainOutbox()

    const { data } = await db
      .from('message_log')
      .select('status, attempts')
      .eq('dedupe_key', `booking:${bookingId}:confirmed`)
      .single()
    // A bad template name never becomes good. One attempt, then dead.
    expect(data).toMatchObject({ status: 'dead', attempts: 1 })

    const before = provider.sent.length
    await drainOutbox()
    expect(provider.sent).toHaveLength(before)
  })

  it('gives up after MAX_ATTEMPTS and stops picking the row up', async () => {
    const bookingId = await confirmedBooking(seed.attendeeId)
    await enqueueOwedMessages()

    provider.result = { status: 'failed', retryable: true, error: 'still down' }
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await drainOutbox()

    const { data } = await db
      .from('message_log')
      .select('status, attempts')
      .eq('dedupe_key', `booking:${bookingId}:confirmed`)
      .single()
    expect(data).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS })

    const before = provider.sent.length
    await drainOutbox()
    expect(provider.sent).toHaveLength(before)
  })

  it('two concurrent drains send each message once', async () => {
    // The property the whole outbox rests on. Same shape as the 50-buyer
    // reservation test: fire both at once and count the sends, not the rows.
    const second = await createTestUser(db)
    await confirmedBooking(seed.attendeeId)
    await confirmedBooking(second)
    await enqueueOwedMessages()

    await Promise.all([drainOutbox(), drainOutbox()])

    const keys = provider.sent.map((m) => m.dedupeKey)
    expect(new Set(keys).size).toBe(keys.length)

    await db.auth.admin.deleteUser(second).catch(() => {})
  })
})
```

- [ ] **Step 3: Run to verify they fail**

```bash
npx vitest run lib/notifications/service.test.ts
```

- [ ] **Step 4: Write the service**

`lib/notifications/service.ts`. The claim-then-send shape in `drainOutbox` is what makes the concurrency test pass: a row is moved out of the pending set **before** it is sent, so a second drain running at the same time does not pick it up.

```ts
import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { notificationProvider } from '@/lib/notifications'
import { messagesOwed, type SweepBooking } from '@/lib/notifications/sweep'
import { serverEnv } from '@/lib/env'
// TemplateName lives in templates.ts — types.ts imports it but does not
// re-export it, so pulling it from there is a compile error.
import type { TemplateName } from '@/lib/notifications/templates'
import type { OutboundMessage } from '@/lib/notifications/types'

/**
 * The only module that holds the service role for notifications, and the only
 * writer of message_log.
 *
 * It is inside the ESLint admin-import fence for two reasons. message_log has
 * no RLS policy at all — service-role only, exactly like fee_rules and
 * provider_webhook_events — and the sweep reads across every attendee and
 * host on an event, which is not a scope any signed-in caller has.
 *
 * Two entry points, deliberately separate. enqueueOwedMessages decides and
 * records; drainOutbox sends what was recorded. Conflating them would put a
 * call to Meta back on whatever path triggered the decision, which is exactly
 * what the outbox exists to prevent.
 */

/** How many times a retryable failure is retried before the row is dead. */
export const MAX_ATTEMPTS = 5

/** Rows considered per tick. Bounded so one tick cannot run unboundedly long. */
const SWEEP_LIMIT = 500
const DRAIN_LIMIT = 100

/** The statuses the sweep can possibly owe a message for. */
const INTERESTING = ['confirmed', 'pending_approval', 'awaiting_payment', 'cancelled', 'refunded']

export async function enqueueOwedMessages(
  options: { now?: Date } = {},
): Promise<{ scanned: number; enqueued: number }> {
  const db = createAdminClient()
  const now = options.now ?? new Date()
  const launchAt = new Date(serverEnv().NOTIFICATIONS_LAUNCH_AT)

  // events!inner so the filter on the event's start time applies to the join
  // rather than nulling the embed and keeping the row — the same trap
  // lib/bookings/queries.ts documents at length for its host scoping.
  const { data, error } = await db
    .from('bookings')
    .select(
      `id, reference, status, cancellation_reason, approved_at,
       total_paise, attendee_name, created_at, hold_expires_at,
       profiles!inner(phone),
       events!inner(title, starts_at, venue_name, city, requires_approval,
                    has_waitlist, hosts!inner(display_name, profiles!inner(phone)))`,
    )
    .in('status', INTERESTING)
    .gte('created_at', launchAt.toISOString())
    .gt('events.starts_at', now.toISOString())
    .order('created_at', { ascending: true })
    .limit(SWEEP_LIMIT)

  if (error) throw new Error(`the notification sweep could not read bookings: ${error.message}`)

  const rows: SweepBooking[] = (data ?? []).map((row) => {
    const r = row as unknown as {
      id: string; reference: string; status: string; cancellation_reason: string | null
      approved_at: string | null; total_paise: number
      attendee_name: string | null; created_at: string; hold_expires_at: string | null
      profiles: { phone: string }
      events: {
        title: string; starts_at: string; venue_name: string | null; city: string
        requires_approval: boolean; has_waitlist: boolean
        hosts: { display_name: string; profiles: { phone: string } }
      }
    }
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      cancellation_reason: r.cancellation_reason,
      approved_at: r.approved_at,
      total_paise: r.total_paise,
      attendee_name: r.attendee_name,
      attendee_phone: r.profiles.phone,
      created_at: r.created_at,
      hold_expires_at: r.hold_expires_at,
      event: {
        title: r.events.title,
        starts_at: r.events.starts_at,
        venue_name: r.events.venue_name,
        city: r.events.city,
        requires_approval: r.events.requires_approval,
        has_waitlist: r.events.has_waitlist,
        host_phone: r.events.hosts.profiles.phone,
        host_display_name: r.events.hosts.display_name,
      },
    }
  })

  const owed = messagesOwed(rows, { now, launchAt })
  let enqueued = 0

  for (const message of owed) {
    const { error: insertError } = await db.from('message_log').insert({
      dedupe_key: message.dedupeKey,
      recipient_phone: message.to,
      template: message.template,
      variables: message.variables,
      booking_id: message.bookingId ?? null,
      status: 'queued',
    })

    if (!insertError) {
      enqueued += 1
      continue
    }
    // 23505 is the unique dedupe_key doing its job: this message was already
    // decided on an earlier tick. That is the expected case, not an error.
    if (insertError.code === '23505') continue
    throw new Error(`could not enqueue ${message.dedupeKey}: ${insertError.message}`)
  }

  return { scanned: rows.length, enqueued }
}

export async function drainOutbox(
  options: { limit?: number } = {},
): Promise<{ attempted: number; sent: number; failed: number; dead: number }> {
  const db = createAdminClient()
  const provider = notificationProvider()
  const counts = { attempted: 0, sent: 0, failed: 0, dead: 0 }

  const { data, error } = await db
    .from('message_log')
    .select('id, dedupe_key, recipient_phone, template, variables, booking_id, attempts')
    .in('status', ['queued', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('updated_at', { ascending: true })
    .limit(options.limit ?? DRAIN_LIMIT)

  if (error) throw new Error(`the outbox could not be read: ${error.message}`)

  for (const row of data ?? []) {
    // Claim it before sending. The UPDATE is conditional on the row still
    // being pending, so of two drains running at once exactly one gets a
    // matching row back and the other skips it — which is what stops the same
    // message going out twice. `sending` is not in the status vocabulary on
    // purpose: bumping attempts up-front is the claim, and it also means a
    // process that dies mid-send has spent an attempt rather than looping
    // forever.
    const { data: claimed, error: claimError } = await db
      .from('message_log')
      .update({ attempts: row.attempts + 1 })
      .eq('id', row.id)
      .eq('attempts', row.attempts)
      .in('status', ['queued', 'failed'])
      .select('id')
      .maybeSingle()

    if (claimError) {
      console.error('[notifications] could not claim a message', claimError)
      continue
    }
    if (!claimed) continue // another drain has it

    counts.attempted += 1

    const message: OutboundMessage = {
      to: row.recipient_phone,
      template: row.template as TemplateName,
      variables: (row.variables ?? {}) as Record<string, string>,
      dedupeKey: row.dedupe_key,
      bookingId: row.booking_id ?? undefined,
    }

    const result = await provider.send(message)
    const attempts = row.attempts + 1

    if (result.status === 'sent' || result.status === 'skipped_duplicate') {
      counts.sent += 1
      await db
        .from('message_log')
        .update({
          status: 'sent',
          provider: provider.name,
          provider_message_id: result.providerMessageId ?? null,
          error: null,
        })
        .eq('id', row.id)
      continue
    }

    // A permanent failure dies now rather than spending four more ticks
    // rediscovering that a template name is still wrong.
    const dead = result.retryable === false || attempts >= MAX_ATTEMPTS
    if (dead) counts.dead += 1
    else counts.failed += 1

    await db
      .from('message_log')
      .update({
        status: dead ? 'dead' : 'failed',
        provider: provider.name,
        error: result.error ?? 'unknown error',
      })
      .eq('id', row.id)
  }

  return counts
}
```

- [ ] **Step 5: Green, then prove it discriminates**

```bash
npx vitest run lib/notifications/service.test.ts
```

Then mutate, confirm red, revert:

| Mutation | Must fail |
|---|---|
| Drop the `.eq('attempts', row.attempts)` claim condition | the two-concurrent-drains test |
| Treat every failure as retryable | the non-retryable-dies-immediately test |
| Re-derive variables instead of reading the column | the drain's `attendeeName` assertion |
| Drop the `23505` branch and count every insert | the idempotency test |

- [ ] **Step 6: Commit**

```bash
npm test
npm run lint      # proves the fence still holds for every OTHER file
npm run typecheck
git add lib/notifications/service.ts lib/notifications/service.test.ts eslint.config.mjs
git commit -m "feat: the outbox writes and drains, and the fence grows by one"
```

---

### Task 6: The cron door

**Files:**
- Create: `app/api/cron/route.ts`
- Create: `app/api/cron/route.test.ts`
- Create: `vercel.json`
- Modify: `lib/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `enqueueOwedMessages`, `drainOutbox` (Task 5); `runReconciliationSweep` (`lib/payments/service.ts:662`, returns `{ reconciled, released, refundsRetried }`); `serverEnv()`.
- Produces: `GET /api/cron`, and the `vercel.json` schedule that calls it.

**Vercel Cron sends `GET` with `Authorization: Bearer $CRON_SECRET`.** That is the platform's convention and why this route is a `GET` while every other entry point in the app is a `POST`.

**This route also finally schedules Phase 3's reconciliation sweep.** `runReconciliationSweep` has been hand-run via `npm run reconcile` since it was written — its own doc comment says "No pg_cron and no deploy-target cron yet". This phase creates the deploy-target cron, so leaving it hand-run would be leaving a job undone for want of one line.

- [ ] **Step 1: Add the cron secret**

`NOTIFICATIONS_LAUNCH_AT` already exists — Task 5 added it, because that is where it is first read. This task adds only the secret.

`lib/env.ts`, in `serverSchema`:

```ts
  // Shared secret Vercel Cron presents as `Authorization: Bearer <secret>`.
  // Optional so local development and tests run without it; the route refuses
  // every request when it is absent, which is the safe direction.
  CRON_SECRET: z.string().optional(),
```

`.env.example`, beside `NOTIFICATIONS_LAUNCH_AT`:

```bash
# Vercel Cron presents this as `Authorization: Bearer <secret>`. Any request
# without it is refused, so an unset value means the route is closed.
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRON_SECRET=""
```

- [ ] **Step 2: Write the failing route tests**

`app/api/cron/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * serverEnv() caches its parse (lib/env.ts), so setting process.env.CRON_SECRET
 * after the first read would change nothing and the "no secret configured"
 * test would silently pass for the wrong reason. Mock the module instead.
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

  it('refuses the secret without the Bearer scheme', async () => {
    const response = await GET(request({ authorization: SECRET }))
    expect(response.status).toBe(401)
  })

  it('refuses everything when the server has no secret configured', async () => {
    // An unset secret must close the door, not open it. This is the assertion
    // that stops a misconfigured deploy exposing an unauthenticated job.
    env.CRON_SECRET = undefined
    const response = await GET(request({ authorization: 'Bearer anything' }))
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

    // Enqueue must precede drain, or a message decided this tick waits a full
    // interval for no reason.
    expect(enqueueOwedMessages.mock.invocationCallOrder[0]).toBeLessThan(
      drainOutbox.mock.invocationCallOrder[0],
    )
  })

  it('still runs the later arms when an earlier one throws', async () => {
    // One broken arm must not silently stop the other two. A failed sweep
    // should not also mean payments go unreconciled.
    enqueueOwedMessages.mockRejectedValue(new Error('database is down'))

    const response = await GET(request({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(200)
    expect(drainOutbox).toHaveBeenCalled()
    expect(runReconciliationSweep).toHaveBeenCalled()
    const body = await response.json()
    expect(body.sweep).toEqual({ error: 'database is down' })
    expect(body.drain).toMatchObject({ sent: 2 })
  })
})
```

- [ ] **Step 3: Run to verify they fail**

```bash
npx vitest run "app/api/cron/route.test.ts"
```

- [ ] **Step 4: Write the route**

`app/api/cron/route.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'
import { serverEnv } from '@/lib/env'
import { drainOutbox, enqueueOwedMessages } from '@/lib/notifications/service'
import { runReconciliationSweep } from '@/lib/payments/service'

/**
 * The scheduled door. Vercel Cron calls it with
 * `Authorization: Bearer $CRON_SECRET`, which is why this is the one GET
 * endpoint in an app whose other entry points are all POSTs.
 *
 * Three arms, in order:
 *   1. the notification sweep — decide what is owed and queue it
 *   2. the outbox drain — send what is queued
 *   3. the reconciliation sweep — Phase 3's, hand-run via `npm run reconcile`
 *      since it was written, because there was no deploy-target cron until
 *      this file existed
 *
 * Each arm is isolated: one throwing must not stop the others, or a database
 * hiccup in the sweep would also mean payments go unreconciled. Failures are
 * reported in the body rather than as a non-2xx, because the run as a whole
 * did happen and a red cron alert per transient error trains you to ignore it.
 */

/** Constant-time compare, so the secret cannot be recovered a byte at a time. */
function credentialMatches(header: string | null, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(secret)
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // length — but length is not the secret, and the guard is required.
  if (presented.length !== expected.length) return false
  return timingSafeEqual(presented, expected)
}

/** Runs one arm, turning a throw into a reportable result. */
async function arm<T>(name: string, run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run()
  } catch (error) {
    console.error(`[cron] ${name} failed`, error)
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = serverEnv().CRON_SECRET

  // An unset secret closes the door rather than opening it. A deploy that
  // forgot the variable should have a job that never runs, not a job anyone
  // on the internet can run.
  if (!secret || !credentialMatches(request.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Enqueue before draining, so a message decided on this tick goes out on
  // this tick rather than waiting a full interval for the next one.
  const sweep = await arm('sweep', () => enqueueOwedMessages())
  const drain = await arm('drain', () => drainOutbox())
  const reconcile = await arm('reconcile', () => runReconciliationSweep())

  return Response.json({ sweep, drain, reconcile })
}
```

- [ ] **Step 5: Declare the schedule**

`vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 * * * *"
    }
  ]
}
```

Hourly, which gives the reminder a tight 23–24 hour window. **Vercel's Hobby plan allows only one cron invocation per day** — on Hobby this must become `"0 3 * * *"` (08:30 IST), and the reminder then arrives somewhere between 0 and 24 hours ahead depending on where the event falls. `dedupe_key` guarantees it is still sent exactly once either way, so the failure mode is lateness, not duplication. Note whichever was chosen in the task report.

- [ ] **Step 6: Green, then commit**

```bash
npx vitest run "app/api/cron/route.test.ts"
npm test
npm run lint
npm run typecheck
npm run build
git add "app/api/cron/route.ts" "app/api/cron/route.test.ts" vercel.json lib/env.ts .env.example
git commit -m "feat: the scheduled door, and the reconcile sweep finally gets a schedule"
```

---

### Task 7: Finale — gauntlet, fresh database, rehearsal, merge

**Files:** none new.

- [ ] **Step 1: The full gauntlet**

```bash
npm test          # >= 665 + this phase's new tests
npm run lint
npm run typecheck
npm run build
```

- [ ] **Step 2: Prove the migration applies to a fresh database**

The committed migration must be what actually built the schema. A bare `create database` will not do — these migrations reference `auth.users` and `storage.buckets`, which the Supabase platform provides — so stub the platform baseline first. **Do not run `supabase db reset`.**

```bash
docker exec -i supabase_db_Event_Hoster psql -U postgres -q \
  -c 'drop database if exists phase4_check;' -c 'create database phase4_check;'

docker exec -i supabase_db_Event_Hoster psql -v ON_ERROR_STOP=1 -U postgres -q -d phase4_check <<'SQL'
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;
create extension if not exists "pgcrypto" schema extensions;
create table auth.users (id uuid primary key default extensions.gen_random_uuid(), phone text, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
create table storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default extensions.gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/') $$;
grant usage on schema public, extensions, storage to anon, authenticated, service_role;
SQL

for f in supabase/migrations/*.sql; do
  docker exec -i supabase_db_Event_Hoster psql -v ON_ERROR_STOP=1 -U postgres -q -d phase4_check < "$f" \
    || { echo "FAILED: $f"; break; }
done
```

Then verify this phase's objects landed, including the index no unit test could reach:

```bash
docker exec -i supabase_db_Event_Hoster psql -U postgres -d phase4_check -t <<'SQL'
select 'attempts+variables: ' || count(*) from information_schema.columns
  where table_name='message_log' and column_name in ('attempts','variables');
select 'status check: ' || count(*) from pg_constraint where conname='message_log_status_known';
select 'pending idx: ' || indexdef from pg_indexes where indexname='message_log_pending_idx';
SQL
docker exec -i supabase_db_Event_Hoster psql -U postgres -q -c 'drop database phase4_check;'
```

Expect both columns and the constraint. **Compare the index definition against the full expected string rather than reading it** — a wrong predicate (dropping `'failed'`, say) passes every test in Task 3 and would silently halve what the drain ever picks up:

```
CREATE INDEX message_log_pending_idx ON public.message_log
  USING btree (status, updated_at)
  WHERE (status = ANY (ARRAY['queued'::text, 'failed'::text]))
```

- [ ] **Step 3: Rehearse the cutoff against the real dev database**

The single most dangerous thing this phase can do is message real people about old events. Prove it will not, **before** the provider is ever pointed at Meta:

```bash
# With WHATSAPP_PROVIDER=log, so nothing can leave the machine.
npm run dev &
sleep 20
curl -s -H "Authorization: Bearer $(node -e "require('dotenv').config({path:'.env.local'});console.log(process.env.CRON_SECRET)")" \
  http://localhost:3100/api/cron | head -40
```

Read the response and the dev-server log. Expect the sweep to enqueue **nothing** for the walkthrough bookings (`VYRB4SHQ`, `9FEQ9S9Y`, `4E389S5G`, `Y9P1K9XY`), because their events have already started and they predate `NOTIFICATIONS_LAUNCH_AT`. If any message is enqueued for them, stop — the cutoff is wrong, and that is a merge blocker rather than a note.

Then clean up whatever the rehearsal wrote:

```bash
docker exec -i supabase_db_Event_Hoster psql -U postgres -d postgres \
  -c "select count(*) as enqueued from message_log;"
# If the rehearsal enqueued anything, inspect it before deleting.
```

- [ ] **Step 4: Cross-check the spec**

Open `docs/specs/2026-08-12-phase-4-notifications-design.md` and verify each, ticking them off:

- eight templates, all valid for submission, `auth_otp` documented as button-free (Task 2)
- the Meta adapter sends body parameters in template order and never throws (Task 1)
- `message_log` has `attempts`, `variables`, the status CHECK and the partial index (Task 3)
- every row of the derivation table, including the ones that must send nothing (Task 4)
- `booking_cancelled` matches `refunded` as well as `cancelled` (Task 4)
- `approval_granted` never fires for a cash or free approval (Task 4)
- the cutoff, proven by test and rehearsed against real data (Tasks 4, 5, 7)
- two concurrent drains send once (Task 5)
- the cron route refuses a wrong or absent secret before doing work (Task 6)
- **the OTP path is untouched** — `git diff master..HEAD -- app/api/hooks/send-sms/` is empty, and its tests pass unmodified
- **there are no send sites** — `git diff master..HEAD --stat -- lib/bookings/ lib/payments/ app/e/ app/bookings/ app/host/ supabase/migrations/2026081*` shows nothing but this phase's own migration
- **the fence grew by exactly one file** — `grep -rln "lib/supabase/admin" lib/ app/` returns four
- no new dependencies — `git diff master..HEAD -- package.json` is empty

- [ ] **Step 5: Merge**

```bash
git checkout master
git merge --no-ff phase-4-notifications -m "Merge Phase 4: notifications"
```

Keep the branch, matching the repo's convention. Push only when the user confirms. `npm run db:stop` if the session is ending — `C:` is tight.

- [ ] **Step 6: Hand over what only a human can do**

Report to the user, explicitly:

1. The eight template bodies to submit; that `auth_otp` must be created **with** a copy-code OTP button (`{"type":"otp","otp_type":"copy_code"}`) because zero-tap is the only buttonless variant and needs Android identifiers this product lacks; and that the other seven are utility templates created with **no** buttons.
2. That the authentication send path has never run against Meta, since no WABA existed while this was built — **send one OTP to a test number before pointing real traffic at `WHATSAPP_PROVIDER=meta`.** A failure there would be total rather than partial, and it would be on the login path.
3. That the WABA must be created with **India as Sold-To country and INR billing** — irreversible, and twenty times the cost if wrong.
4. That going live afterwards is `WHATSAPP_PROVIDER=meta` plus `WHATSAPP_API_KEY` and `WHATSAPP_PHONE_NUMBER_ID`, and that `NOTIFICATIONS_LAUNCH_AT` should be set to the moment of that switch rather than left at its default.
5. Which cron schedule shipped in `vercel.json`, and that Hobby allows only a daily run.

