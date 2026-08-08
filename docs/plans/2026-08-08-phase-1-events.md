# Phase 1 — Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host signs in, fills one form, and gets a shareable `/e/[slug]` link that unfurls properly in WhatsApp.

**Architecture:** Pure logic (slug, IST datetime, validation) lives in `lib/events/` with unit tests. All database writes go through the RLS-scoped user client in Server Actions — no service role, no new `SECURITY DEFINER` functions, because Phase 0 already granted `authenticated` scoped `insert/update/delete` on `events` and `ticket_types`. Cover images upload straight from the browser to a Supabase Storage bucket keyed by `auth.uid()`.

**Tech Stack:** Next.js 16.3 (App Router, Turbopack), React 19.2, TypeScript, Tailwind 4, Supabase (Postgres + Auth + Storage), Zod 4, Vitest 4.

**Spec:** [`docs/specs/2026-08-08-phase-1-events-design.md`](../specs/2026-08-08-phase-1-events-design.md)

## Global Constraints

- **Money is always integer paise.** Use `rupeesToPaise()` / `formatPaise()` from `lib/money.ts`. Never floats, never rupees in the database.
- **`params` and `searchParams` are Promises** in Next.js 16. Use the generated `PageProps<'/route'>` helper from `next typegen`; never hand-write page prop types.
- **`cookies()` is async.** `lib/supabase/server.ts#createClient` must be awaited.
- **Never use `lib/supabase/admin.ts` in Phase 1.** It bypasses RLS. Server Actions use `@/lib/supabase/server`.
- **The slug is written once at insert and never updated.** Editing a title must not touch the slug.
- **IST is UTC+05:30 year-round, no DST.** Never call `new Date(localString)` on a zoneless value.
- **Run `npm run db:types` after any migration.** `lib/supabase/types.ts` is committed.
- **Tests:** `npm test` (needs `npm run db:start`). Integration tests share one Postgres — `fileParallelism: false` is already set.
- Existing suite is 76 tests, all green. Never finish a task with a red suite.

---

### Task 1: Slug generation

**Files:**
- Create: `lib/events/slug.ts`
- Test: `lib/events/slug.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `slugifyTitle(title: string): string`, `buildSlug(title: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// lib/events/slug.test.ts
import { describe, expect, it } from 'vitest'
import { buildSlug, slugifyTitle } from '@/lib/events/slug'

describe('slugifyTitle', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyTitle('Diwali Supper Club')).toBe('diwali-supper-club')
  })

  it('strips accents rather than dropping the letter', () => {
    expect(slugifyTitle('Café Night')).toBe('cafe-night')
  })

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(slugifyTitle('Board Games!! (BYO snacks)')).toBe('board-games-byo-snacks')
  })

  it('trims leading and trailing separators', () => {
    expect(slugifyTitle('  ...Pop-Up...  ')).toBe('pop-up')
  })

  it('truncates to 60 characters without leaving a trailing hyphen', () => {
    const long = 'a'.repeat(58) + ' bbbb'
    const result = slugifyTitle(long)
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result.endsWith('-')).toBe(false)
  })

  it('returns empty string when nothing survives', () => {
    expect(slugifyTitle('दिवाली')).toBe('')
  })
})

describe('buildSlug', () => {
  it('appends a six-character suffix', () => {
    const slug = buildSlug('Diwali Supper Club')
    expect(slug).toMatch(/^diwali-supper-club-[a-z0-9]{6}$/)
  })

  it('falls back to "event" when the title slugifies to nothing', () => {
    expect(buildSlug('दिवाली')).toMatch(/^event-[a-z0-9]{6}$/)
  })

  it('produces a different slug each call for the same title', () => {
    // A host running a monthly supper club must not collide with themselves.
    const slugs = new Set(Array.from({ length: 50 }, () => buildSlug('Supper Club')))
    expect(slugs.size).toBe(50)
  })

  it('only ever emits URL-safe characters', () => {
    for (const title of ['Café!! Night', '   ', 'दिवाली', 'A'.repeat(200)]) {
      expect(buildSlug(title)).toMatch(/^[a-z0-9-]+$/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/events/slug.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/slug`

- [ ] **Step 3: Write the implementation**

```ts
// lib/events/slug.ts
/**
 * Event slugs.
 *
 * A slug is written once, at insert, and never changes — not even when the host
 * edits the title. By then the link is already sitting in a WhatsApp group, and
 * silently breaking it is the worst bug available in this phase.
 */

const MAX_TITLE_CHARS = 60
const SUFFIX_LENGTH = 6

// Base32 without the look-alike characters (0/O, 1/l/I), so a slug read aloud
// down a phone line survives the trip.
const SUFFIX_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz'

/** Kebab-cases a title, dropping anything that is not URL-safe. May return ''. */
export function slugifyTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks left behind by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TITLE_CHARS)
    .replace(/-+$/g, '') // the slice may have cut mid-separator
}

/**
 * Random suffix. Not a secret — a slug is a public URL — so modulo bias across
 * a 30-character alphabet is irrelevant here. Ticket codes, which ARE secret,
 * are generated in lib/tickets/ instead.
 */
function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]
  return out
}

/**
 * The slug written at insert time. The random suffix — rather than a `-2`, `-3`
 * collision counter — means a monthly supper club never collides with itself,
 * and the URL leaks nothing about how many events exist.
 */
export function buildSlug(title: string): string {
  return `${slugifyTitle(title) || 'event'}-${randomSuffix()}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/events/slug.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add lib/events/slug.ts lib/events/slug.test.ts
git commit -m "Add event slug generation with immutable random suffix"
```

---

### Task 2: IST datetime conversion

**Files:**
- Create: `lib/events/datetime.ts`
- Test: `lib/events/datetime.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `istLocalToUtc(local: string): Date`, `utcToIstLocal(date: Date): string`, `formatIst(date: Date): string`, `formatIstDateOnly(date: Date): string`

- [ ] **Step 1: Write the failing test**

```ts
// lib/events/datetime.test.ts
import { describe, expect, it } from 'vitest'
import { formatIst, istLocalToUtc, utcToIstLocal } from '@/lib/events/datetime'

describe('istLocalToUtc', () => {
  it('subtracts the 5:30 offset', () => {
    expect(istLocalToUtc('2026-08-15T19:30').toISOString()).toBe('2026-08-15T14:00:00.000Z')
  })

  it('uses the same offset in January as in July', () => {
    // India observes no DST. If these differ, the implementation is reading the
    // host machine's zone instead of Asia/Kolkata — which is the exact bug that
    // makes every event 5.5 hours wrong once deployed to a UTC server.
    const jan = istLocalToUtc('2026-01-15T19:30')
    const jul = istLocalToUtc('2026-07-15T19:30')
    expect(jan.toISOString()).toBe('2026-01-15T14:00:00.000Z')
    expect(jul.toISOString()).toBe('2026-07-15T14:00:00.000Z')
  })

  it('rolls back across midnight', () => {
    expect(istLocalToUtc('2026-08-15T04:00').toISOString()).toBe('2026-08-14T22:30:00.000Z')
  })

  it('rejects a value that is not a datetime-local string', () => {
    expect(() => istLocalToUtc('2026-08-15')).toThrow(RangeError)
    expect(() => istLocalToUtc('')).toThrow(RangeError)
    expect(() => istLocalToUtc('2026-08-15T19:30:00Z')).toThrow(RangeError)
  })
})

describe('utcToIstLocal', () => {
  it('round-trips with istLocalToUtc', () => {
    const local = '2026-08-15T19:30'
    expect(utcToIstLocal(istLocalToUtc(local))).toBe(local)
  })

  it('produces a value a datetime-local input accepts', () => {
    expect(utcToIstLocal(new Date('2026-08-15T14:00:00.000Z'))).toBe('2026-08-15T19:30')
  })
})

describe('formatIst', () => {
  it('renders in IST regardless of the machine zone', () => {
    const text = formatIst(new Date('2026-08-15T14:00:00.000Z'))
    expect(text).toContain('7:30')
    expect(text).toContain('Aug')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/events/datetime.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/datetime`

- [ ] **Step 3: Write the implementation**

```ts
// lib/events/datetime.ts
/**
 * All event times are entered and displayed in IST.
 *
 * An <input type="datetime-local"> yields "2026-08-15T19:30" with no zone.
 * Passing that to new Date() resolves it against the *server's* zone: correct on
 * a developer machine in India, and 5.5 hours wrong on Vercel, which runs UTC.
 * Every conversion therefore goes through here, using arithmetic on a fixed
 * offset rather than anything that can consult the ambient zone.
 *
 * India has observed no daylight saving since 1945, so a fixed offset is exact,
 * not an approximation. If the product ever leaves IST, this file is the only
 * place that assumption lives.
 */

const IST_OFFSET_MINUTES = 330 // UTC+05:30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** Reads a zoneless datetime-local string as IST and returns the UTC instant. */
export function istLocalToUtc(local: string): Date {
  const match = LOCAL_PATTERN.exec(local)
  if (!match) {
    throw new RangeError(`Expected a datetime-local value like 2026-08-15T19:30, got "${local}"`)
  }
  const [, year, month, day, hour, minute] = match
  // Date.UTC never consults the ambient timezone, which is the whole point.
  const asIfUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  return new Date(asIfUtc - IST_OFFSET_MS)
}

/** Formats a UTC instant as the IST datetime-local string an input expects. */
export function utcToIstLocal(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16)
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
})

const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Kolkata',
})

/** e.g. "Sat, 15 Aug, 7:30 pm" */
export function formatIst(date: Date): string {
  return dateTimeFormatter.format(date)
}

/** e.g. "Sat, 15 Aug" */
export function formatIstDateOnly(date: Date): string {
  return dateFormatter.format(date)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/events/datetime.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add lib/events/datetime.ts lib/events/datetime.test.ts
git commit -m "Add explicit IST datetime conversion for zoneless form input"
```

---

### Task 3: Form parsing and publish validation

**Files:**
- Create: `lib/events/validation.ts`
- Test: `lib/events/validation.test.ts`

**Interfaces:**
- Consumes: `istLocalToUtc` (Task 2), `rupeesToPaise` from `lib/money.ts`
- Produces:
  - `eventDraftSchema` (Zod schema)
  - `type EventDraftInput = z.infer<typeof eventDraftSchema>`
  - `parseEventForm(formData: FormData): { success: true; data: EventDraftInput } | { success: false; fieldErrors: Record<string, string> }`
  - `type PublishCandidate = { title: string | null; city: string | null; venue_name: string | null; starts_at: string; ticketTypes: Array<{ quantity: number }> }`
  - `type PublishBlocker = { field: string; message: string }`
  - `validateForPublish(candidate: PublishCandidate, now?: Date): PublishBlocker[]`

- [ ] **Step 1: Write the failing test**

```ts
// lib/events/validation.test.ts
import { describe, expect, it } from 'vitest'
import { parseEventForm, validateForPublish } from '@/lib/events/validation'

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string> = {
    title: 'Diwali Supper Club',
    city: 'Indore',
    startsAtLocal: '2026-11-14T19:30',
    seats: '20',
    priceRupees: '500',
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== '') fd.set(key, value)
  }
  return fd
}

describe('parseEventForm', () => {
  it('accepts the minimum the database requires', () => {
    const result = parseEventForm(form())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.title).toBe('Diwali Supper Club')
      expect(result.data.seats).toBe(20)
      expect(result.data.priceRupees).toBe(500)
    }
  })

  it('rejects a title shorter than the schema CHECK allows', () => {
    const result = parseEventForm(form({ title: 'ab' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.title).toBeTruthy()
  })

  it('rejects a missing city, because the column is NOT NULL', () => {
    const result = parseEventForm(form({ city: '' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.city).toBeTruthy()
  })

  it('rejects a missing start time, because the column is NOT NULL', () => {
    const result = parseEventForm(form({ startsAtLocal: '' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.startsAtLocal).toBeTruthy()
  })

  it('rejects zero or negative seats', () => {
    expect(parseEventForm(form({ seats: '0' })).success).toBe(false)
    expect(parseEventForm(form({ seats: '-3' })).success).toBe(false)
  })

  it('accepts a free event at zero rupees', () => {
    expect(parseEventForm(form({ priceRupees: '0' })).success).toBe(true)
  })

  it('accepts a fractional price', () => {
    const result = parseEventForm(form({ priceRupees: '499.99' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.priceRupees).toBeCloseTo(499.99)
  })

  it('rejects an end time before the start time', () => {
    const result = parseEventForm(
      form({ startsAtLocal: '2026-11-14T19:30', endsAtLocal: '2026-11-14T18:00' }),
    )
    expect(result.success).toBe(false)
    if (!result.success) expect(result.fieldErrors.endsAtLocal).toBeTruthy()
  })

  it('reads unchecked toggles as false', () => {
    const result = parseEventForm(form())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requiresApproval).toBe(false)
      expect(result.data.allowsCash).toBe(false)
    }
  })

  it('reads a checked toggle as true', () => {
    const result = parseEventForm(form({ requiresApproval: 'on' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.requiresApproval).toBe(true)
  })
})

describe('validateForPublish', () => {
  const now = new Date('2026-08-08T00:00:00.000Z')
  const complete = {
    title: 'Diwali Supper Club',
    city: 'Indore',
    venue_name: 'The Terrace',
    starts_at: '2026-11-14T14:00:00.000Z',
    ticketTypes: [{ quantity: 20 }],
  }

  it('passes a complete event', () => {
    expect(validateForPublish(complete, now)).toEqual([])
  })

  it('blocks a missing venue', () => {
    const blockers = validateForPublish({ ...complete, venue_name: null }, now)
    expect(blockers.map((b) => b.field)).toContain('venue_name')
  })

  it('blocks a start time in the past', () => {
    const blockers = validateForPublish({ ...complete, starts_at: '2026-01-01T00:00:00.000Z' }, now)
    expect(blockers.map((b) => b.field)).toContain('starts_at')
  })

  it('blocks an event with no seats', () => {
    const blockers = validateForPublish({ ...complete, ticketTypes: [] }, now)
    expect(blockers.map((b) => b.field)).toContain('seats')
  })

  it('reports every blocker at once, not just the first', () => {
    // The edit page shows all of them together; one-per-attempt would make
    // publishing a guessing game.
    const blockers = validateForPublish(
      { title: null, city: null, venue_name: null, starts_at: '2020-01-01T00:00:00.000Z', ticketTypes: [] },
      now,
    )
    expect(blockers.length).toBeGreaterThanOrEqual(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/events/validation.test.ts`
Expected: FAIL — cannot resolve `@/lib/events/validation`

- [ ] **Step 3: Write the implementation**

```ts
// lib/events/validation.ts
import { z } from 'zod'

/**
 * Two different bars, deliberately.
 *
 * `eventDraftSchema` asks for exactly what Postgres declares NOT NULL — title,
 * city, start time — plus the seats and price that become the single implicit
 * ticket type. Anything else is optional, so a half-filled form is never lost.
 *
 * `validateForPublish` is the stricter gate: it is what makes an event fit to
 * show a stranger who arrived from a WhatsApp link.
 */

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick a date and time')

const optionalText = (max: number) => z.string().trim().max(max).optional()

export const eventDraftSchema = z
  .object({
    // 3..140 mirrors the CHECK on events.title. Failing here gives the host a
    // sentence; failing in Postgres gives them a constraint name.
    title: z
      .string()
      .trim()
      .min(3, 'Give your event a name of at least 3 characters')
      .max(140, 'Keep the name under 140 characters'),
    city: z.string().trim().min(1, 'Which city is this in?').max(80),
    startsAtLocal: localDateTime,
    endsAtLocal: localDateTime.optional(),
    description: optionalText(5000),
    venueName: optionalText(160),
    venueAddress: optionalText(500),
    coverImageUrl: z.url('That does not look like an image link').optional(),
    seats: z.coerce
      .number()
      .int('Seats must be a whole number')
      .positive('You need at least one seat')
      .max(100_000, 'That is more seats than this platform is for'),
    priceRupees: z.coerce
      .number()
      .min(0, 'Price cannot be negative')
      .max(1_000_000, 'That price looks like a mistake'),
    requiresApproval: z.boolean(),
    allowsCash: z.boolean(),
    hideVenueUntilApproved: z.boolean(),
  })
  .refine((v) => !v.endsAtLocal || v.endsAtLocal > v.startsAtLocal, {
    // Lexicographic comparison is correct here: both are fixed-width
    // YYYY-MM-DDTHH:mm strings in the same zone.
    message: 'The end time must be after the start time',
    path: ['endsAtLocal'],
  })

export type EventDraftInput = z.infer<typeof eventDraftSchema>

export type ParseResult =
  | { success: true; data: EventDraftInput }
  | { success: false; fieldErrors: Record<string, string> }

function text(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** An unchecked checkbox is absent from FormData entirely. */
function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) !== null
}

export function parseEventForm(formData: FormData): ParseResult {
  const parsed = eventDraftSchema.safeParse({
    title: text(formData.get('title')) ?? '',
    city: text(formData.get('city')) ?? '',
    startsAtLocal: text(formData.get('startsAtLocal')) ?? '',
    endsAtLocal: text(formData.get('endsAtLocal')),
    description: text(formData.get('description')),
    venueName: text(formData.get('venueName')),
    venueAddress: text(formData.get('venueAddress')),
    coverImageUrl: text(formData.get('coverImageUrl')),
    seats: text(formData.get('seats')) ?? '',
    priceRupees: text(formData.get('priceRupees')) ?? '0',
    requiresApproval: checkbox(formData, 'requiresApproval'),
    allowsCash: checkbox(formData, 'allowsCash'),
    hideVenueUntilApproved: checkbox(formData, 'hideVenueUntilApproved'),
  })

  if (parsed.success) return { success: true, data: parsed.data }

  const fieldErrors: Record<string, string> = {}
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? 'form')
    fieldErrors[key] ??= issue.message // first message per field wins
  }
  return { success: false, fieldErrors }
}

export interface PublishCandidate {
  title: string | null
  city: string | null
  venue_name: string | null
  starts_at: string
  ticketTypes: Array<{ quantity: number }>
}

export interface PublishBlocker {
  field: string
  message: string
}

/**
 * Everything standing between a draft and a public link, returned all at once.
 */
export function validateForPublish(
  candidate: PublishCandidate,
  now: Date = new Date(),
): PublishBlocker[] {
  const blockers: PublishBlocker[] = []

  if (!candidate.title || candidate.title.trim().length < 3) {
    blockers.push({ field: 'title', message: 'Give your event a name' })
  }
  if (!candidate.city || candidate.city.trim() === '') {
    blockers.push({ field: 'city', message: 'Add the city' })
  }
  if (!candidate.venue_name || candidate.venue_name.trim() === '') {
    blockers.push({ field: 'venue_name', message: 'Add where it is happening' })
  }
  if (new Date(candidate.starts_at).getTime() <= now.getTime()) {
    blockers.push({ field: 'starts_at', message: 'The start time is in the past' })
  }
  if (!candidate.ticketTypes.some((t) => t.quantity > 0)) {
    blockers.push({ field: 'seats', message: 'Add at least one seat' })
  }

  return blockers
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/events/validation.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add lib/events/validation.ts lib/events/validation.test.ts
git commit -m "Add event draft parsing and publish validation"
```

---

### Task 4: Cover image storage bucket

**Files:**
- Create: `supabase/migrations/20260808000004_event_covers_storage.sql`
- Create: `lib/events/storage.test.ts`
- Modify: `next.config.ts`
- Regenerate: `lib/supabase/types.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a public-read `event-covers` bucket; objects live at `{auth.uid()}/{filename}`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260808000004_event_covers_storage.sql
--
-- Cover images for events.
--
-- The path is keyed by the uploader's uid, NOT by event id:
--   event-covers/{auth.uid()}/{random}.jpg
-- That is what lets a host attach an image before the event row exists, which
-- keeps event creation to a single save. The cost is that abandoned drafts
-- leave orphaned objects; at pilot volume that is cheaper to tolerate than to
-- reap, and it is a known limitation rather than an oversight.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-covers',
  'event-covers',
  true,                                                  -- the event page is public, so the cover must be
  5242880,                                               -- 5 MiB; phone photos arrive large
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Anyone may look at a cover. There is nothing private in one, and the event
-- page must render for a visitor with no session.
create policy "event covers are publicly readable"
  on storage.objects for select
  using (bucket_id = 'event-covers');

-- Writes are confined to a folder named after the caller's own uid.
create policy "hosts upload into their own cover folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'event-covers'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "hosts replace their own covers"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'event-covers'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "hosts delete their own covers"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'event-covers'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
```

- [ ] **Step 2: Apply the migration and regenerate types**

```bash
npm run db:reset
npm run db:types
```

Expected: migrations apply cleanly; `lib/supabase/types.ts` is rewritten.

- [ ] **Step 3: Allow Supabase Storage URLs through next/image**

```ts
// next.config.ts
import type { NextConfig } from 'next'

const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname

const nextConfig: NextConfig = {
  images: {
    // Covers are served straight from Supabase Storage. Without this, next/image
    // refuses the URL at runtime with a vague "hostname not configured" error.
    remotePatterns: [
      { protocol: 'http', hostname: '127.0.0.1', port: '54321', pathname: '/storage/v1/object/public/**' },
      { protocol: 'https', hostname: supabaseHost, pathname: '/storage/v1/object/public/**' },
    ],
  },
}

export default nextConfig
```

- [ ] **Step 4: Write the storage RLS test**

```ts
// lib/events/storage.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, anonClient, createTestUser, userClient } from '@/tests/helpers/db'

/**
 * The cover bucket is world-readable by design, so the only thing standing
 * between hosts is the folder-name check in the insert policy.
 */

const db = adminClient()
const pixel = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })

let alice: string
let bob: string

beforeAll(async () => {
  alice = await createTestUser(db)
  bob = await createTestUser(db)
})

afterAll(async () => {
  await db.storage.from('event-covers').remove([`${alice}/cover.jpg`]).catch(() => {})
  await db.auth.admin.deleteUser(alice).catch(() => {})
  await db.auth.admin.deleteUser(bob).catch(() => {})
})

describe('event-covers bucket', () => {
  it('lets a host upload into their own folder', async () => {
    const { error } = await userClient(alice)
      .storage.from('event-covers')
      .upload(`${alice}/cover.jpg`, pixel, { contentType: 'image/jpeg', upsert: true })

    expect(error).toBeNull()
  })

  it('refuses an upload into another host\'s folder', async () => {
    const { error } = await userClient(bob)
      .storage.from('event-covers')
      .upload(`${alice}/hijack.jpg`, pixel, { contentType: 'image/jpeg' })

    expect(error).not.toBeNull()
  })

  it('refuses an anonymous upload', async () => {
    const { error } = await anonClient()
      .storage.from('event-covers')
      .upload(`${alice}/anon.jpg`, pixel, { contentType: 'image/jpeg' })

    expect(error).not.toBeNull()
  })

  it('serves an uploaded cover publicly', async () => {
    const { data } = userClient(alice).storage.from('event-covers').getPublicUrl(`${alice}/cover.jpg`)
    const response = await fetch(data.publicUrl)
    expect(response.status).toBe(200)
  })
})
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run lib/events/storage.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260808000004_event_covers_storage.sql lib/events/storage.test.ts next.config.ts lib/supabase/types.ts
git commit -m "Add event-covers storage bucket with per-user folder policies"
```

---

### Task 5: Session helper and event queries

**Files:**
- Create: `lib/auth/session.ts`
- Create: `lib/events/queries.ts`
- Create: `tests/helpers/session.ts`
- Modify: `vitest.config.mts`
- Test: `lib/events/queries.test.ts`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server`
- Produces:
  - `getCurrentUser(): Promise<User | null>`, `requireUser(): Promise<User>`
  - `getCurrentHostId(): Promise<string | null>`
  - `listCityFeed(city?: string): Promise<FeedEvent[]>`
  - `getPublishedEventBySlug(slug: string): Promise<PublicEvent | null>`
  - `listHostEvents(): Promise<HostEvent[]>`
  - `getOwnedEvent(id: string): Promise<OwnedEvent | null>`
  - `tests/helpers/session.ts`: `signInAs(userId: string | null)`. Importing this
    module installs the `@/lib/supabase/server` mock as a side effect, so the
    module under test must be brought in with a top-level `await import(...)`.

**Testing decision (settled before execution):** these tests call the real
exported functions. `queries.ts` reaches the database through
`@/lib/supabase/server#createClient`, so the test mocks that one module
boundary and lets everything below it hit the real local Postgres under real
RLS. Asserting against re-issued PostgREST queries instead would leave a
missing `.eq('host_id', ...)` in `queries.ts` completely undetected — which is
one of the two bugs this plan exists to prevent.

- [ ] **Step 1: Write the session helper**

```ts
// lib/auth/session.ts
import 'server-only'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * Always getUser(), never getSession(): getSession() trusts the cookie without
 * revalidating it, which makes it useless as an authorization check.
 */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user ?? null
}

/** Redirects to /login when signed out. Never returns null. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}
```

- [ ] **Step 2: Write the queries**

```ts
// lib/events/queries.ts
import 'server-only'
import { createClient } from '@/lib/supabase/server'

/**
 * Reads for the feed, the public event page and the host dashboard.
 *
 * RLS already hides other hosts' drafts, but it does NOT scope a host's own
 * list: `events_select_published` makes every published event readable by
 * everyone. So anything that means "mine" filters on host_id explicitly. Relying
 * on RLS alone here would show a host the entire platform's catalogue.
 */

const FEED_COLUMNS =
  'id, slug, title, cover_image_url, city, venue_name, starts_at, ticket_types(price_paise, quantity, reserved_count)'

export interface FeedEvent {
  id: string
  slug: string
  title: string
  cover_image_url: string | null
  city: string
  venue_name: string | null
  starts_at: string
  ticket_types: Array<{ price_paise: number; quantity: number; reserved_count: number }>
}

export async function getCurrentHostId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return null

  const { data } = await supabase
    .from('hosts')
    .select('id')
    .eq('profile_id', auth.user.id)
    .maybeSingle()

  return data?.id ?? null
}

/** Upcoming published events, soonest first. */
export async function listCityFeed(city?: string): Promise<FeedEvent[]> {
  const supabase = await createClient()

  let query = supabase
    .from('events')
    .select(FEED_COLUMNS)
    .eq('status', 'published')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(50)

  if (city) query = query.eq('city', city)

  const { data, error } = await query
  if (error) throw new Error(`Could not load the feed: ${error.message}`)
  return (data ?? []) as FeedEvent[]
}

export interface PublicEvent extends FeedEvent {
  description: string | null
  venue_address: string | null
  hide_venue_until_approved: boolean
  ends_at: string | null
  requires_approval: boolean
  allows_cash: boolean
  hosts: { display_name: string; bio: string | null; avatar_url: string | null } | null
}

/** The public event page. Returns null for drafts and unknown slugs alike. */
export async function getPublishedEventBySlug(slug: string): Promise<PublicEvent | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('events')
    .select(
      `${FEED_COLUMNS}, description, venue_address, hide_venue_until_approved, ends_at,
       requires_approval, allows_cash, hosts(display_name, bio, avatar_url)`,
    )
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle()

  if (error) throw new Error(`Could not load the event: ${error.message}`)
  return (data as PublicEvent | null) ?? null
}

export interface HostEvent {
  id: string
  slug: string
  title: string
  status: 'draft' | 'published' | 'cancelled' | 'completed'
  city: string
  starts_at: string
  cover_image_url: string | null
  published_at: string | null
  ticket_types: Array<{ price_paise: number; quantity: number; reserved_count: number }>
}

/** The host's own events, drafts included, newest first. */
export async function listHostEvents(): Promise<HostEvent[]> {
  const hostId = await getCurrentHostId()
  if (!hostId) return [] // signed in but has never created an event

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('events')
    .select(
      'id, slug, title, status, city, starts_at, cover_image_url, published_at, ticket_types(price_paise, quantity, reserved_count)',
    )
    .eq('host_id', hostId)
    .order('starts_at', { ascending: false })

  if (error) throw new Error(`Could not load your events: ${error.message}`)
  return (data ?? []) as HostEvent[]
}

export interface OwnedEvent extends HostEvent {
  description: string | null
  venue_name: string | null
  venue_address: string | null
  ends_at: string | null
  requires_approval: boolean
  allows_cash: boolean
  hide_venue_until_approved: boolean
}

/** One of the caller's own events, for the edit page. */
export async function getOwnedEvent(id: string): Promise<OwnedEvent | null> {
  const hostId = await getCurrentHostId()
  if (!hostId) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('events')
    .select(
      `id, slug, title, status, city, starts_at, cover_image_url, published_at,
       description, venue_name, venue_address, ends_at, requires_approval, allows_cash,
       hide_venue_until_approved, ticket_types(price_paise, quantity, reserved_count)`,
    )
    .eq('id', id)
    .eq('host_id', hostId) // not just RLS: a published event is readable by anyone
    .maybeSingle()

  if (error) throw new Error(`Could not load the event: ${error.message}`)
  return (data as OwnedEvent | null) ?? null
}
```

- [ ] **Step 3: Let Vitest import server-only modules**

`queries.ts` and `session.ts` start with `import 'server-only'`, which throws
outside a server bundle. Alias it to an empty module for tests.

```ts
// vitest.config.mts — add to the existing resolve.alias block
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` exists to break the build if a module is imported into a
      // client bundle. Vitest is neither, so it is stubbed rather than removed
      // from the source — the guard still protects the real build.
      'server-only': fileURLToPath(new URL('./tests/helpers/empty-module.ts', import.meta.url)),
    },
  },
```

```ts
// tests/helpers/empty-module.ts
// Stands in for `server-only` under Vitest. Intentionally empty.
export {}
```

- [ ] **Step 4: Write the session mock helper**

```ts
// tests/helpers/session.ts
import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { anonClient, userClient } from './db'

/**
 * Lets a test call the real functions in lib/events/queries.ts.
 *
 * Those functions reach the database through one seam —
 * `@/lib/supabase/server#createClient` — so that seam is the only thing mocked.
 * Everything below it is real: a real PostgREST client, carrying a real JWT for
 * the chosen user, hitting the real local Postgres under real RLS.
 *
 * The alternative — re-issuing equivalent queries in the test — would pass
 * happily while queries.ts was missing a filter, which is exactly the class of
 * bug this suite exists to catch.
 */

let currentUserId: string | null = null

/** Who subsequent createClient() calls act as. null means signed out. */
export function signInAs(userId: string | null): void {
  currentUserId = userId
}

// Registered at module top level, where vi.mock's hoisting actually applies.
// Wrapping this in an exported function would be a lie: the call would do
// nothing, because vi.mock is hoisted out of it either way.
//
// The factory must close over nothing but the mutable variable above.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async (): Promise<SupabaseClient> =>
    currentUserId ? userClient(currentUserId) : anonClient(),
}))
```

- [ ] **Step 5: Write the integration test**

```ts
// lib/events/queries.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupEvent, seedEvent, type SeededEvent } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

const {
  getCurrentHostId,
  getOwnedEvent,
  getPublishedEventBySlug,
  listCityFeed,
  listHostEvents,
} = await import('@/lib/events/queries')

const db = adminClient()

let published: SeededEvent
let draft: SeededEvent
let publishedSlug: string

beforeAll(async () => {
  published = await seedEvent(db, { status: 'published' })
  draft = await seedEvent(db, { status: 'draft' })

  const { data } = await db.from('events').select('slug').eq('id', published.eventId).single()
  publishedSlug = data!.slug
})

afterAll(async () => {
  await cleanupEvent(db, published)
  await cleanupEvent(db, draft)
})

describe('getPublishedEventBySlug', () => {
  it('returns a published event to a signed-out visitor, with its host', async () => {
    signInAs(null)
    const event = await getPublishedEventBySlug(publishedSlug)

    expect(event).not.toBeNull()
    expect(event!.title).toBe('Test Supper Club')
    expect(event!.ticket_types).toHaveLength(1)
    expect(event!.hosts).toMatchObject({ display_name: 'Test Host' })
  })

  it('returns null for an unknown slug', async () => {
    signInAs(null)
    expect(await getPublishedEventBySlug('no-such-event-aaaaaa')).toBeNull()
  })

  it('returns null for a draft, even to its own host', async () => {
    const { data } = await db.from('events').select('slug').eq('id', draft.eventId).single()
    signInAs(draft.hostProfileId)

    // The public page must never render a draft, session or not.
    expect(await getPublishedEventBySlug(data!.slug)).toBeNull()
  })
})

describe('listCityFeed', () => {
  it('lists upcoming published events and excludes drafts', async () => {
    signInAs(null)
    const ids = (await listCityFeed()).map((e) => e.id)

    expect(ids).toContain(published.eventId)
    expect(ids).not.toContain(draft.eventId)
  })

  it('filters by city', async () => {
    signInAs(null)
    expect((await listCityFeed('Indore')).map((e) => e.id)).toContain(published.eventId)
    expect(await listCityFeed('Nowhere-on-Sea')).toEqual([])
  })
})

describe('getCurrentHostId', () => {
  it('returns the host id for a signed-in host', async () => {
    signInAs(draft.hostProfileId)
    expect(await getCurrentHostId()).toBe(draft.hostId)
  })

  it('returns null when signed out', async () => {
    signInAs(null)
    expect(await getCurrentHostId()).toBeNull()
  })
})

describe('listHostEvents', () => {
  it('returns the calling host\'s own events, drafts included', async () => {
    signInAs(draft.hostProfileId)
    const ids = (await listHostEvents()).map((e) => e.id)

    expect(ids).toEqual([draft.eventId])
  })

  it('does not leak another host\'s published event', async () => {
    // The regression this guards: events_select_published makes EVERY published
    // event readable, so a listHostEvents() that trusts RLS alone would hand a
    // host the entire platform's catalogue as "your events".
    signInAs(draft.hostProfileId)
    const ids = (await listHostEvents()).map((e) => e.id)

    expect(ids).not.toContain(published.eventId)
  })

  it('returns an empty list for a signed-in user who is not a host', async () => {
    signInAs(published.attendeeId)
    expect(await listHostEvents()).toEqual([])
  })
})

describe('getOwnedEvent', () => {
  it('returns the host\'s own draft', async () => {
    signInAs(draft.hostProfileId)
    const event = await getOwnedEvent(draft.eventId)

    expect(event).not.toBeNull()
    expect(event!.id).toBe(draft.eventId)
  })

  it('refuses another host\'s event even though it is published', async () => {
    signInAs(draft.hostProfileId)
    expect(await getOwnedEvent(published.eventId)).toBeNull()
  })

  it('returns null when signed out', async () => {
    signInAs(null)
    expect(await getOwnedEvent(draft.eventId)).toBeNull()
  })
})
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run lib/events/queries.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add lib/auth/session.ts lib/events/queries.ts lib/events/queries.test.ts \
        tests/helpers/session.ts tests/helpers/empty-module.ts vitest.config.mts
git commit -m "Add session helper and event queries scoped to the calling host"
```

---

### Task 6: Server Actions for create, update and publish

**Files:**
- Create: `app/host/events/actions.ts`
- Test: `lib/events/actions.test.ts`

**Interfaces:**
- Consumes: `buildSlug` (T1), `istLocalToUtc` (T2), `parseEventForm` / `validateForPublish` (T3), `getCurrentHostId` (T5), `rupeesToPaise` from `lib/money.ts`
- Produces: `type EventFormState`, `createEvent`, `updateEvent`, `publishEvent`, `unpublishEvent` — all `(prev: EventFormState, formData: FormData) => Promise<EventFormState>`, for `useActionState`

- [ ] **Step 1: Write the actions**

```ts
// app/host/events/actions.ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { buildSlug } from '@/lib/events/slug'
import { istLocalToUtc } from '@/lib/events/datetime'
import { parseEventForm, validateForPublish } from '@/lib/events/validation'
import { getCurrentHostId } from '@/lib/events/queries'
import { rupeesToPaise } from '@/lib/money'

export interface EventFormState {
  error?: string
  fieldErrors?: Record<string, string>
  blockers?: string[]
  ok?: boolean
}

/**
 * Every write here goes through the RLS-scoped user client on purpose. Phase 0
 * granted `authenticated` insert/update/delete on events and ticket_types,
 * narrowed by current_host_id(). Reaching for the service role would bypass the
 * exact model those RLS tests prove.
 */

/**
 * A signed-in user has a profile but not necessarily a hosts row. Creating one
 * on first publish keeps host onboarding to zero extra screens.
 */
async function resolveOrCreateHost(supabase: SupabaseClient, user: User): Promise<string> {
  const { data: existing } = await supabase
    .from('hosts')
    .select('id')
    .eq('profile_id', user.id)
    .maybeSingle()

  if (existing) return existing.id

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, phone')
    .eq('id', user.id)
    .maybeSingle()

  const displayName = profile?.full_name?.trim() || profile?.phone || 'Host'

  const { data, error } = await supabase
    .from('hosts')
    .insert({ profile_id: user.id, display_name: displayName })
    .select('id')
    .single()

  if (error) throw new Error(`Could not set up your host profile: ${error.message}`)
  return data.id
}

export async function createEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) redirect('/login')

  const parsed = parseEventForm(formData)
  if (!parsed.success) return { fieldErrors: parsed.fieldErrors }
  const input = parsed.data

  const hostId = await resolveOrCreateHost(supabase, auth.user)

  const { data: event, error } = await supabase
    .from('events')
    .insert({
      host_id: hostId,
      slug: buildSlug(input.title), // written once, never updated
      title: input.title,
      description: input.description ?? null,
      city: input.city,
      venue_name: input.venueName ?? null,
      venue_address: input.venueAddress ?? null,
      cover_image_url: input.coverImageUrl ?? null,
      starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
      ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
      requires_approval: input.requiresApproval,
      allows_cash: input.allowsCash,
      hide_venue_until_approved: input.hideVenueUntilApproved,
      status: 'draft',
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  const { error: ticketError } = await supabase.from('ticket_types').insert({
    event_id: event.id,
    name: 'General',
    price_paise: rupeesToPaise(input.priceRupees),
    quantity: input.seats,
  })

  if (ticketError) {
    // Roll back rather than strand an event with no inventory: publish would
    // reject it forever and the UI offers no way to add a ticket type.
    await supabase.from('events').delete().eq('id', event.id)
    return { error: ticketError.message }
  }

  redirect(`/host/events/${event.id}/edit`)
}

export async function updateEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const hostId = await getCurrentHostId()
  if (!hostId) redirect('/login')

  const eventId = String(formData.get('eventId') ?? '')
  if (!eventId) return { error: 'Missing event id' }

  const parsed = parseEventForm(formData)
  if (!parsed.success) return { fieldErrors: parsed.fieldErrors }
  const input = parsed.data

  // Note the absence of `slug`. The link may already be in a WhatsApp group.
  const { data, error } = await supabase
    .from('events')
    .update({
      title: input.title,
      description: input.description ?? null,
      city: input.city,
      venue_name: input.venueName ?? null,
      venue_address: input.venueAddress ?? null,
      cover_image_url: input.coverImageUrl ?? null,
      starts_at: istLocalToUtc(input.startsAtLocal).toISOString(),
      ends_at: input.endsAtLocal ? istLocalToUtc(input.endsAtLocal).toISOString() : null,
      requires_approval: input.requiresApproval,
      allows_cash: input.allowsCash,
      hide_venue_until_approved: input.hideVenueUntilApproved,
    })
    .eq('id', eventId)
    .eq('host_id', hostId)
    .select('id, slug')
    .maybeSingle()

  if (error) return { error: error.message }
  if (!data) return { error: 'That event is not yours to edit' }

  const { error: ticketError } = await supabase
    .from('ticket_types')
    .update({ price_paise: rupeesToPaise(input.priceRupees), quantity: input.seats })
    .eq('event_id', eventId)

  if (ticketError) {
    // The no-oversell CHECK rejects a quantity below what is already reserved.
    return { error: `Could not update seats: ${ticketError.message}` }
  }

  revalidatePath(`/e/${data.slug}`)
  revalidatePath('/host')
  return { ok: true }
}

export async function publishEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const hostId = await getCurrentHostId()
  if (!hostId) redirect('/login')

  const eventId = String(formData.get('eventId') ?? '')

  const { data: event, error: readError } = await supabase
    .from('events')
    .select('id, slug, title, city, venue_name, starts_at, ticket_types(quantity)')
    .eq('id', eventId)
    .eq('host_id', hostId)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!event) return { error: 'That event is not yours to publish' }

  const blockers = validateForPublish({
    title: event.title,
    city: event.city,
    venue_name: event.venue_name,
    starts_at: event.starts_at,
    ticketTypes: event.ticket_types,
  })

  if (blockers.length > 0) return { blockers: blockers.map((b) => b.message) }

  const { error } = await supabase
    .from('events')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', eventId)
    .eq('host_id', hostId)

  if (error) return { error: error.message }

  revalidatePath('/')
  revalidatePath('/host')
  revalidatePath(`/e/${event.slug}`)
  return { ok: true }
}

export async function unpublishEvent(
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const supabase = await createClient()
  const hostId = await getCurrentHostId()
  if (!hostId) redirect('/login')

  const eventId = String(formData.get('eventId') ?? '')

  const { data, error } = await supabase
    .from('events')
    .update({ status: 'draft' })
    .eq('id', eventId)
    .eq('host_id', hostId)
    .select('slug')
    .maybeSingle()

  if (error) return { error: error.message }
  if (!data) return { error: 'That event is not yours' }

  revalidatePath('/')
  revalidatePath('/host')
  revalidatePath(`/e/${data.slug}`)
  return { ok: true }
}
```

- [ ] **Step 2: Write the integration test**

Calls the real exported actions, using the same `@/lib/supabase/server` mock
Task 5 introduced. `next/cache` and `next/navigation` are stubbed too: outside a
request, `revalidatePath` throws and `redirect` throws a control-flow signal.

```ts
// lib/events/actions.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminClient, createTestUser } from '@/tests/helpers/db'
import { signInAs } from '@/tests/helpers/session' // side effect: installs the mock

// revalidatePath needs a request store; there isn't one here.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))

// Next's redirect() signals by throwing. Reproduce that so the test can assert
// a redirect happened without depending on Next's internal error shape.
class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`)
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
  notFound: () => {
    throw new Error('notFound')
  },
}))

const { createEvent, publishEvent, unpublishEvent, updateEvent } = await import(
  '@/app/host/events/actions'
)

const db = adminClient()

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  const base: Record<string, string> = {
    title: 'Diwali Supper Club',
    city: 'Indore',
    venueName: 'The Terrace',
    startsAtLocal: '2026-11-14T19:30',
    seats: '20',
    priceRupees: '500',
  }
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== '') fd.set(key, value)
  }
  return fd
}

/** Runs an action that is expected to redirect, returning the target path. */
async function captureRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to
    throw error
  }
  throw new Error('Expected a redirect, but the action returned normally')
}

let aliceId: string
let bobId: string
let eventId: string
let slug: string

beforeAll(async () => {
  aliceId = await createTestUser(db)
  bobId = await createTestUser(db)
})

afterAll(async () => {
  if (eventId) await db.from('events').delete().eq('id', eventId)
  await db.from('hosts').delete().eq('profile_id', aliceId)
  await db.from('hosts').delete().eq('profile_id', bobId)
  await db.auth.admin.deleteUser(aliceId).catch(() => {})
  await db.auth.admin.deleteUser(bobId).catch(() => {})
})

describe('createEvent', () => {
  it('rejects a form missing the columns Postgres requires', async () => {
    signInAs(aliceId)
    const state = await createEvent({}, form({ title: '', city: '' }))

    expect(state.fieldErrors?.title).toBeTruthy()
    expect(state.fieldErrors?.city).toBeTruthy()
  })

  it('creates the host row implicitly on first event', async () => {
    signInAs(aliceId)
    const { data: before } = await db.from('hosts').select('id').eq('profile_id', aliceId)
    expect(before ?? []).toHaveLength(0)

    const target = await captureRedirect(() => createEvent({}, form()))
    expect(target).toMatch(/^\/host\/events\/[0-9a-f-]+\/edit$/)

    const { data: after } = await db.from('hosts').select('id').eq('profile_id', aliceId)
    expect(after).toHaveLength(1)

    eventId = target.split('/')[3]
  })

  it('stores the start time converted from IST to UTC', async () => {
    // 19:30 IST is 14:00 UTC. A 19:30Z here means the conversion was skipped.
    const { data } = await db.from('events').select('starts_at, status').eq('id', eventId).single()

    expect(data!.starts_at).toContain('14:00:00')
    expect(data!.status).toBe('draft')
  })

  it('creates one ticket type priced in integer paise', async () => {
    const { data } = await db
      .from('ticket_types')
      .select('name, price_paise, quantity')
      .eq('event_id', eventId)

    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ name: 'General', price_paise: 50_000, quantity: 20 })
  })
})

describe('publishEvent', () => {
  it('reports every blocker at once rather than publishing', async () => {
    signInAs(aliceId)
    await db.from('events').update({ venue_name: null }).eq('id', eventId)

    const state = await publishEvent({}, formWithId(eventId))

    expect(state.blockers ?? []).not.toHaveLength(0)
    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('draft')

    await db.from('events').update({ venue_name: 'The Terrace' }).eq('id', eventId)
  })

  it('refuses to publish an event belonging to another host', async () => {
    signInAs(bobId)
    await db.from('hosts').insert({ profile_id: bobId, display_name: 'Bob' })

    const state = await publishEvent({}, formWithId(eventId))

    expect(state.error).toBeTruthy()
    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('draft')
  })

  it('publishes the owner\'s complete event and stamps published_at', async () => {
    signInAs(aliceId)
    const state = await publishEvent({}, formWithId(eventId))

    expect(state.ok).toBe(true)
    const { data } = await db
      .from('events')
      .select('status, published_at, slug')
      .eq('id', eventId)
      .single()

    expect(data!.status).toBe('published')
    expect(data!.published_at).not.toBeNull()
    slug = data!.slug
  })
})

describe('updateEvent', () => {
  it('never changes the slug when the title changes', async () => {
    // The link is already sitting in a WhatsApp group by now.
    signInAs(aliceId)
    const fd = form({ title: 'Diwali Supper Club (fixed typo)' })
    fd.set('eventId', eventId)

    const state = await updateEvent({}, fd)
    expect(state.ok).toBe(true)

    const { data } = await db.from('events').select('slug, title').eq('id', eventId).single()
    expect(data!.slug).toBe(slug)
    expect(data!.title).toBe('Diwali Supper Club (fixed typo)')
  })

  it('refuses an edit from a different host', async () => {
    signInAs(bobId)
    const fd = form({ title: 'Defaced' })
    fd.set('eventId', eventId)

    const state = await updateEvent({}, fd)
    expect(state.error).toBeTruthy()

    const { data } = await db.from('events').select('title').eq('id', eventId).single()
    expect(data!.title).toBe('Diwali Supper Club (fixed typo)')
  })

  it('surfaces the oversell guard when seats are cut below what is reserved', async () => {
    await db.from('ticket_types').update({ reserved_count: 5 }).eq('event_id', eventId)
    signInAs(aliceId)

    const fd = form({ seats: '2' })
    fd.set('eventId', eventId)
    const state = await updateEvent({}, fd)

    // ticket_types_no_oversell is the backstop; the action must not swallow it.
    expect(state.error).toBeTruthy()

    await db.from('ticket_types').update({ reserved_count: 0 }).eq('event_id', eventId)
  })
})

describe('unpublishEvent', () => {
  it('returns a published event to draft', async () => {
    signInAs(aliceId)
    const state = await unpublishEvent({}, formWithId(eventId))

    expect(state.ok).toBe(true)
    const { data } = await db.from('events').select('status').eq('id', eventId).single()
    expect(data!.status).toBe('draft')
  })
})

function formWithId(id: string): FormData {
  const fd = new FormData()
  fd.set('eventId', id)
  return fd
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run lib/events/actions.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add app/host/events/actions.ts lib/events/actions.test.ts
git commit -m "Add server actions for event create, update and publish"
```

---

### Task 7: Create and edit forms

**Files:**
- Create: `app/host/events/new/page.tsx`
- Create: `app/host/events/event-form.tsx` (shared client component)
- Create: `app/host/events/cover-upload.tsx` (client component)
- Create: `app/host/events/[id]/edit/page.tsx`

**Interfaces:**
- Consumes: `createEvent`, `updateEvent`, `publishEvent`, `unpublishEvent` (T6); `getOwnedEvent` (T5); `utcToIstLocal` (T2)
- Produces: `EventForm` React component

- [ ] **Step 1: Write the cover upload control**

```tsx
// app/host/events/cover-upload.tsx
'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Uploads straight from the browser to Supabase Storage, then writes the public
 * URL into a hidden input the form submits.
 *
 * Going direct rather than through the Server Action avoids the body size limit
 * on actions, and the path is keyed by the user's own uid so this works before
 * the event row exists.
 */
export function CoverUpload({ initialUrl }: { initialUrl?: string | null }) {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    setBusy(true)
    setError(null)

    const supabase = createClient()
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) {
      setError('Your session expired. Sign in again.')
      setBusy(false)
      return
    }

    const extension = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    const path = `${auth.user.id}/${crypto.randomUUID()}.${extension}`

    const { error: uploadError } = await supabase.storage
      .from('event-covers')
      .upload(path, file, { contentType: file.type, upsert: false })

    if (uploadError) {
      setError(uploadError.message)
      setBusy(false)
      return
    }

    const { data } = supabase.storage.from('event-covers').getPublicUrl(path)
    setUrl(data.publicUrl)
    setBusy(false)
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">Cover image</label>

      {url ? (
        // Plain <img>: the URL is user-supplied at runtime, and next/image adds
        // nothing for a preview the host looks at once.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Event cover preview" className="h-40 w-full rounded-lg object-cover" />
      ) : (
        <div className="flex h-40 w-full items-center justify-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500">
          No cover yet
        </div>
      )}

      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void upload(file)
        }}
        className="block w-full text-sm"
      />

      <input type="hidden" name="coverImageUrl" value={url} />

      {busy && <p className="text-sm text-zinc-500">Uploading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Write the shared form**

```tsx
// app/host/events/event-form.tsx
'use client'

import { useActionState } from 'react'
import { CoverUpload } from './cover-upload'
import type { EventFormState } from './actions'

type Action = (state: EventFormState, formData: FormData) => Promise<EventFormState>

export interface EventFormValues {
  eventId?: string
  title?: string
  description?: string | null
  city?: string
  venueName?: string | null
  venueAddress?: string | null
  coverImageUrl?: string | null
  startsAtLocal?: string
  endsAtLocal?: string
  seats?: number
  priceRupees?: number
  requiresApproval?: boolean
  allowsCash?: boolean
  hideVenueUntilApproved?: boolean
}

const field = 'w-full rounded-lg border border-zinc-300 px-3 py-2 text-base'

export function EventForm({
  action,
  values = {},
  submitLabel,
}: {
  action: Action
  values?: EventFormValues
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as EventFormState)

  return (
    <form action={formAction} className="space-y-5">
      {values.eventId && <input type="hidden" name="eventId" value={values.eventId} />}

      <div>
        <label htmlFor="title" className="block text-sm font-medium">What is it called?</label>
        <input id="title" name="title" defaultValue={values.title} required className={field} />
        {state.fieldErrors?.title && <p className="text-sm text-red-600">{state.fieldErrors.title}</p>}
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium">Description</label>
        <textarea id="description" name="description" rows={5} defaultValue={values.description ?? ''} className={field} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="city" className="block text-sm font-medium">City</label>
          <input id="city" name="city" defaultValue={values.city} required className={field} />
          {state.fieldErrors?.city && <p className="text-sm text-red-600">{state.fieldErrors.city}</p>}
        </div>
        <div>
          <label htmlFor="venueName" className="block text-sm font-medium">Venue</label>
          <input id="venueName" name="venueName" defaultValue={values.venueName ?? ''} className={field} />
        </div>
      </div>

      <div>
        <label htmlFor="venueAddress" className="block text-sm font-medium">Address</label>
        <input id="venueAddress" name="venueAddress" defaultValue={values.venueAddress ?? ''} className={field} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="startsAtLocal" className="block text-sm font-medium">Starts (IST)</label>
          <input
            id="startsAtLocal"
            name="startsAtLocal"
            type="datetime-local"
            defaultValue={values.startsAtLocal}
            required
            className={field}
          />
          {state.fieldErrors?.startsAtLocal && (
            <p className="text-sm text-red-600">{state.fieldErrors.startsAtLocal}</p>
          )}
        </div>
        <div>
          <label htmlFor="endsAtLocal" className="block text-sm font-medium">Ends (optional)</label>
          <input
            id="endsAtLocal"
            name="endsAtLocal"
            type="datetime-local"
            defaultValue={values.endsAtLocal}
            className={field}
          />
          {state.fieldErrors?.endsAtLocal && (
            <p className="text-sm text-red-600">{state.fieldErrors.endsAtLocal}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="seats" className="block text-sm font-medium">Seats</label>
          <input id="seats" name="seats" type="number" min={1} defaultValue={values.seats ?? 20} required className={field} />
          {state.fieldErrors?.seats && <p className="text-sm text-red-600">{state.fieldErrors.seats}</p>}
        </div>
        <div>
          <label htmlFor="priceRupees" className="block text-sm font-medium">Price per seat (₹)</label>
          <input
            id="priceRupees"
            name="priceRupees"
            type="number"
            min={0}
            step="0.01"
            defaultValue={values.priceRupees ?? 0}
            required
            className={field}
          />
          {state.fieldErrors?.priceRupees && <p className="text-sm text-red-600">{state.fieldErrors.priceRupees}</p>}
        </div>
      </div>

      <CoverUpload initialUrl={values.coverImageUrl} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Options</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresApproval" defaultChecked={values.requiresApproval} />
          I approve each guest before they pay
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="allowsCash" defaultChecked={values.allowsCash} />
          Allow paying cash at the door
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="hideVenueUntilApproved" defaultChecked={values.hideVenueUntilApproved} />
          Hide the exact address until I approve a guest
        </label>
      </fieldset>

      {state.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
      {state.ok && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-700">Saved.</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-black px-4 py-3 text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : submitLabel}
      </button>
    </form>
  )
}
```

- [ ] **Step 3: Write the new-event page**

```tsx
// app/host/events/new/page.tsx
import { requireUser } from '@/lib/auth/session'
import { createEvent } from '../actions'
import { EventForm } from '../event-form'

export const metadata = { title: 'New event' }

export default async function NewEventPage() {
  await requireUser()

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Create an event</h1>
      <EventForm action={createEvent} submitLabel="Save draft" />
    </main>
  )
}
```

- [ ] **Step 4: Write the edit page**

```tsx
// app/host/events/[id]/edit/page.tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { getOwnedEvent } from '@/lib/events/queries'
import { utcToIstLocal } from '@/lib/events/datetime'
import { publishEvent, unpublishEvent, updateEvent } from '../../actions'
import { EventForm } from '../../event-form'
import { PublishPanel } from './publish-panel'

export const metadata = { title: 'Edit event' }

export default async function EditEventPage(props: PageProps<'/host/events/[id]/edit'>) {
  await requireUser()
  const { id } = await props.params

  const event = await getOwnedEvent(id)
  if (!event) notFound()

  const ticket = event.ticket_types[0]

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">{event.title}</h1>
        <p className="text-sm text-zinc-500">
          {event.status === 'published' ? 'Published' : 'Draft'}
          {' · '}
          <Link href={`/e/${event.slug}`} className="underline">/e/{event.slug}</Link>
        </p>
      </div>

      <PublishPanel
        eventId={event.id}
        slug={event.slug}
        status={event.status}
        publishAction={publishEvent}
        unpublishAction={unpublishEvent}
      />

      <EventForm
        action={updateEvent}
        submitLabel="Save changes"
        values={{
          eventId: event.id,
          title: event.title,
          description: event.description,
          city: event.city,
          venueName: event.venue_name,
          venueAddress: event.venue_address,
          coverImageUrl: event.cover_image_url,
          startsAtLocal: utcToIstLocal(new Date(event.starts_at)),
          endsAtLocal: event.ends_at ? utcToIstLocal(new Date(event.ends_at)) : undefined,
          seats: ticket?.quantity,
          priceRupees: ticket ? ticket.price_paise / 100 : 0,
          requiresApproval: event.requires_approval,
          allowsCash: event.allows_cash,
          hideVenueUntilApproved: event.hide_venue_until_approved,
        }}
      />
    </main>
  )
}
```

- [ ] **Step 5: Write the publish panel**

```tsx
// app/host/events/[id]/edit/publish-panel.tsx
'use client'

import { useActionState, useState } from 'react'
import type { EventFormState } from '../../actions'

type Action = (state: EventFormState, formData: FormData) => Promise<EventFormState>

export function PublishPanel({
  eventId,
  slug,
  status,
  publishAction,
  unpublishAction,
}: {
  eventId: string
  slug: string
  status: string
  publishAction: Action
  unpublishAction: Action
}) {
  const isPublished = status === 'published'
  const [state, formAction, pending] = useActionState(
    isPublished ? unpublishAction : publishAction,
    {} as EventFormState,
  )
  const [copied, setCopied] = useState(false)

  const shareUrl =
    typeof window === 'undefined' ? `/e/${slug}` : `${window.location.origin}/e/${slug}`

  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 p-4">
      {isPublished ? (
        <>
          <p className="text-sm font-medium">Your link is live. Send it to your group.</p>
          <div className="flex gap-2">
            <input readOnly value={shareUrl} className="flex-1 rounded-lg bg-zinc-100 px-3 py-2 text-sm" />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(shareUrl).then(() => setCopied(true))
              }}
              className="rounded-lg bg-black px-4 py-2 text-sm text-white"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-zinc-600">This event is a draft. Nobody can see it yet.</p>
      )}

      {state.blockers && state.blockers.length > 0 && (
        <ul className="list-inside list-disc rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {state.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}

      <form action={formAction}>
        <input type="hidden" name="eventId" value={eventId} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm disabled:opacity-50"
        >
          {isPublished ? 'Unpublish' : 'Publish'}
        </button>
      </form>
    </section>
  )
}
```

- [ ] **Step 6: Verify in the browser**

```bash
npm run dev
```

Open http://localhost:3100/host/events/new, sign in with `+919999900001` / `123456`, create an event, publish it, copy the link.

Expected: redirect to the edit page; publish succeeds once a venue is filled in; the blocker list appears if it is not.

- [ ] **Step 7: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add app/host
git commit -m "Add event create and edit forms with cover upload and publish panel"
```

---

### Task 8: Host dashboard

**Files:**
- Create: `app/host/page.tsx`

**Interfaces:**
- Consumes: `listHostEvents` (T5), `requireUser` (T5), `formatIst` (T2), `formatPaise` from `lib/money.ts`

- [ ] **Step 1: Write the page**

```tsx
// app/host/page.tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth/session'
import { listHostEvents } from '@/lib/events/queries'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'

export const metadata = { title: 'Your events' }

export default async function HostDashboard() {
  await requireUser()
  const events = await listHostEvents()

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your events</h1>
        <Link href="/host/events/new" className="rounded-lg bg-black px-4 py-2 text-sm text-white">
          New event
        </Link>
      </div>

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          No events yet. Create one and you will get a link to share.
        </p>
      ) : (
        <ul className="space-y-3">
          {events.map((event) => {
            const ticket = event.ticket_types[0]
            return (
              <li key={event.id} className="rounded-xl border border-zinc-200 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Link href={`/host/events/${event.id}/edit`} className="font-medium hover:underline">
                      {event.title}
                    </Link>
                    <p className="text-sm text-zinc-500">
                      {formatIst(new Date(event.starts_at))} · {event.city}
                    </p>
                    {ticket && (
                      <p className="text-sm text-zinc-500">
                        {formatPaise(ticket.price_paise)} · {ticket.reserved_count}/{ticket.quantity} taken
                      </p>
                    )}
                  </div>
                  <span
                    className={
                      event.status === 'published'
                        ? 'rounded-full bg-green-100 px-2 py-1 text-xs text-green-800'
                        : 'rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600'
                    }
                  >
                    {event.status}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 2: Verify in the browser**

Open http://localhost:3100/host. Expected: the event created in Task 7 is listed with its status and seat count.

- [ ] **Step 3: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add app/host/page.tsx
git commit -m "Add host dashboard listing the host's own events"
```

---

### Task 9: Public event page with OpenGraph tags

**Files:**
- Create: `app/e/[slug]/page.tsx`
- Create: `app/e/[slug]/not-found.tsx`

**Interfaces:**
- Consumes: `getPublishedEventBySlug` (T5), `formatIst` (T2), `formatPaise` from `lib/money.ts`, `clientEnv` from `lib/env.ts`

**Design note:** this is the surface the whole business rests on — it arrives via a forwarded WhatsApp link and opens on a mid-range Android phone. Build the markup below first so the data is proven, then invoke the `frontend-design` skill for a visual pass before committing. Mobile-first; the desktop view is secondary.

- [ ] **Step 1: Write the page**

```tsx
// app/e/[slug]/page.tsx
import Image from 'next/image'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getPublishedEventBySlug } from '@/lib/events/queries'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import { clientEnv } from '@/lib/env'

/**
 * The OpenGraph block is not decoration. This link's first impression is the
 * preview card WhatsApp renders from these tags; a link that unfurls as a bare
 * URL reads as spam in a group chat, which kills the only distribution channel
 * the product has.
 */
export async function generateMetadata(props: PageProps<'/e/[slug]'>): Promise<Metadata> {
  const { slug } = await props.params
  const event = await getPublishedEventBySlug(slug)
  if (!event) return { title: 'Event not found' }

  const when = formatIst(new Date(event.starts_at))
  const description = event.description?.slice(0, 200) ?? `${when} · ${event.city}`
  const url = `${clientEnv.NEXT_PUBLIC_SITE_URL}/e/${event.slug}`

  return {
    title: event.title,
    description,
    openGraph: {
      title: event.title,
      description,
      url,
      type: 'website',
      images: event.cover_image_url ? [{ url: event.cover_image_url }] : undefined,
    },
    twitter: {
      card: event.cover_image_url ? 'summary_large_image' : 'summary',
      title: event.title,
      description,
    },
  }
}

export default async function PublicEventPage(props: PageProps<'/e/[slug]'>) {
  const { slug } = await props.params
  const event = await getPublishedEventBySlug(slug)
  if (!event) notFound()

  const ticket = event.ticket_types[0]
  const remaining = ticket ? ticket.quantity - ticket.reserved_count : 0
  const soldOut = remaining <= 0

  return (
    <main className="mx-auto max-w-2xl pb-28">
      {event.cover_image_url && (
        <Image
          src={event.cover_image_url}
          alt=""
          width={1200}
          height={630}
          priority
          className="h-56 w-full object-cover sm:h-72 sm:rounded-b-2xl"
        />
      )}

      <div className="space-y-6 px-4 pt-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold leading-tight sm:text-3xl">{event.title}</h1>
          <p className="text-zinc-600">{formatIst(new Date(event.starts_at))}</p>
        </header>

        <section className="rounded-xl border border-zinc-200 p-4">
          <h2 className="text-sm font-medium text-zinc-500">Where</h2>
          <p className="font-medium">{event.venue_name ?? event.city}</p>
          {/* Luma-style: the exact address is withheld until the host approves. */}
          {event.hide_venue_until_approved ? (
            <p className="text-sm text-zinc-500">Full address shared once the host approves you.</p>
          ) : (
            event.venue_address && <p className="text-sm text-zinc-600">{event.venue_address}</p>
          )}
          <p className="text-sm text-zinc-500">{event.city}</p>
        </section>

        {event.description && (
          <section className="whitespace-pre-wrap leading-relaxed text-zinc-800">
            {event.description}
          </section>
        )}

        {event.hosts && (
          <section className="flex items-center gap-3 rounded-xl border border-zinc-200 p-4">
            {event.hosts.avatar_url && (
              <Image
                src={event.hosts.avatar_url}
                alt=""
                width={44}
                height={44}
                className="h-11 w-11 rounded-full object-cover"
              />
            )}
            <div>
              <p className="text-sm text-zinc-500">Hosted by</p>
              <p className="font-medium">{event.hosts.display_name}</p>
            </div>
          </section>
        )}
      </div>

      {/* Booking is Phase 2. The control is present but inert, so the page reads
          as finished rather than broken. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">
              {ticket ? (ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)) : '—'}
            </p>
            <p className="text-sm text-zinc-500">
              {soldOut ? 'Sold out' : `${remaining} of ${ticket?.quantity ?? 0} left`}
            </p>
          </div>
          <button
            type="button"
            disabled
            className="rounded-lg bg-zinc-200 px-5 py-3 font-medium text-zinc-500"
          >
            Booking opens soon
          </button>
        </div>
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Write the not-found page**

```tsx
// app/e/[slug]/not-found.tsx
import Link from 'next/link'

export default function EventNotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">This event is not available</h1>
      <p className="text-zinc-600">
        The link may be wrong, or the host may have taken it down.
      </p>
      <Link href="/" className="rounded-lg bg-black px-4 py-2 text-white">
        See what else is on
      </Link>
    </main>
  )
}
```

- [ ] **Step 3: Verify the page and its OG tags**

```bash
npm run dev
curl -s http://localhost:3100/e/<slug> | grep -i 'og:'
```

Expected: `og:title`, `og:description`, `og:url` present, plus `og:image` when a cover was uploaded. Open the URL in a private window and confirm it renders with no session.

- [ ] **Step 4: Visual pass**

Invoke the `frontend-design` skill against `app/e/[slug]/page.tsx`. Mobile-first, 360px viewport as the baseline.

- [ ] **Step 5: Typecheck, lint and commit**

```bash
npm run typecheck && npm run lint
git add app/e
git commit -m "Add public event page with OpenGraph tags for WhatsApp previews"
```

---

### Task 10: City feed

**Files:**
- Modify: `app/page.tsx` (replaces the Create-Next-App boilerplate entirely)
- Create: `app/_components/event-card.tsx`

**Interfaces:**
- Consumes: `listCityFeed` (T5), `formatIst` (T2), `formatPaise` from `lib/money.ts`

- [ ] **Step 1: Write the card**

```tsx
// app/_components/event-card.tsx
import Image from 'next/image'
import Link from 'next/link'
import { formatIst } from '@/lib/events/datetime'
import { formatPaise } from '@/lib/money'
import type { FeedEvent } from '@/lib/events/queries'

export function EventCard({ event }: { event: FeedEvent }) {
  const ticket = event.ticket_types[0]

  return (
    <Link
      href={`/e/${event.slug}`}
      className="block overflow-hidden rounded-xl border border-zinc-200 transition hover:border-zinc-400"
    >
      {event.cover_image_url ? (
        <Image
          src={event.cover_image_url}
          alt=""
          width={800}
          height={400}
          className="h-40 w-full object-cover"
        />
      ) : (
        <div className="h-40 w-full bg-gradient-to-br from-zinc-200 to-zinc-100" />
      )}
      <div className="space-y-1 p-4">
        <p className="text-sm text-zinc-500">{formatIst(new Date(event.starts_at))}</p>
        <h2 className="font-medium leading-snug">{event.title}</h2>
        <p className="text-sm text-zinc-500">{event.venue_name ?? event.city}</p>
        {ticket && (
          <p className="text-sm font-medium">
            {ticket.price_paise === 0 ? 'Free' : formatPaise(ticket.price_paise)}
          </p>
        )}
      </div>
    </Link>
  )
}
```

- [ ] **Step 2: Replace the home page**

```tsx
// app/page.tsx
import Link from 'next/link'
import { EventCard } from '@/app/_components/event-card'
import { listCityFeed } from '@/lib/events/queries'

export const metadata = {
  title: 'What is on',
  description: 'Supper clubs, board-game nights, workshops and pop-ups near you.',
}

export default async function FeedPage(props: PageProps<'/'>) {
  const { city } = await props.searchParams
  const selectedCity = typeof city === 'string' ? city : undefined
  const events = await listCityFeed(selectedCity)

  // Cities present in the current result set, so the filter never offers a
  // choice that leads to an empty page.
  const cities = [...new Set(events.map((event) => event.city))].sort()

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">What is on</h1>
        <Link href="/host" className="text-sm underline">
          Host an event
        </Link>
      </div>

      {selectedCity && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="rounded-full bg-black px-3 py-1 text-white">{selectedCity}</span>
          <Link href="/" className="underline">
            Clear
          </Link>
        </div>
      )}

      {!selectedCity && cities.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {cities.map((name) => (
            <Link
              key={name}
              href={`/?city=${encodeURIComponent(name)}`}
              className="rounded-full border border-zinc-300 px-3 py-1 text-sm"
            >
              {name}
            </Link>
          ))}
        </div>
      )}

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          Nothing on right now. <Link href="/host/events/new" className="underline">Host something.</Link>
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </main>
  )
}
```

- [ ] **Step 3: Run the whole suite**

```bash
npm test
npm run typecheck && npm run lint
```

Expected: all tests pass — 76 from Phase 0 plus roughly 65 new ones.

- [ ] **Step 4: Verify end to end in the browser**

1. Open http://localhost:3100 — the published event appears
2. Click through to `/e/[slug]`
3. Open the same link in a private window — it renders with no session

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx app/_components/event-card.tsx
git commit -m "Replace boilerplate home page with the city feed"
```

---

## Self-Review Notes

**Spec coverage:** every section of the design maps to a task — slug (T1), IST datetime (T2), validation (T3), storage (T4), queries (T5), actions (T6), create/edit UI (T7), dashboard (T8), public page and OG (T9), feed (T10).

**Two things this plan discovered that the spec did not state:**

1. **`listHostEvents` must filter on `host_id` explicitly.** RLS alone is not enough: `events_select_published` makes every published event on the platform readable by everyone, so a query relying only on RLS would show a host the entire catalogue as "your events". Same for `getOwnedEvent`. Handled in T5.

2. **Reducing seats below `reserved_count` is rejected by the `ticket_types_no_oversell` CHECK.** Editing an event that already has bookings can therefore fail at the database. T6 surfaces the error rather than swallowing it; a friendlier message is a Phase 2 concern, once bookings exist at all.

**Deferred deliberately:** `/login` does not honour a `?next=` return path, so `requireUser()` sends the host to the feed after signing in rather than back to the page they wanted. Worth fixing when the flow is exercised for real.
