# Phase 1 — Event creation, publishing, and the public link

Follows [`2026-08-08-event-platform-v1-design.md`](2026-08-08-event-platform-v1-design.md).
Phase 0 (schema, RLS, WhatsApp OTP login) is on `phase-0-foundations`; this work
branches from it as `phase-1-events`.

## Goal

> A host signs in, fills one form, and gets a link they can paste into a WhatsApp
> group. Someone who taps that link sees a page worth showing up for.

Phase 1 proves the shareable link. No money moves and no inventory is consumed —
that is Phase 2 onwards — so this phase can be built entirely on the RLS grants
Phase 0 already established.

## Scope

**In:**

- Host creates and edits an event (implicitly becoming a host on first create)
- Draft → published transition, with publish validated more strictly than draft
- Public event page at `/e/[slug]`, with OpenGraph tags for WhatsApp previews
- Host dashboard at `/host` listing their own events
- City feed at `/`, replacing the Create-Next-App boilerplate
- Cover image upload to Supabase Storage

**Out:** bookings, payments, tickets, approval queues, waitlists, multi-tier
ticket types, recurring events. The public page shows price and seats remaining
with a disabled "Booking opens soon" control.

## Architecture

`lib/events/` splits pure logic from IO so the parts that can be wrong quietly
are unit-testable:

| File | Responsibility | Tested by |
|---|---|---|
| `slug.ts` | `buildSlug(title)` — kebab plus random suffix | unit |
| `datetime.ts` | IST-local ↔ UTC conversion | unit |
| `validation.ts` | Zod draft schema, `validateForPublish()` | unit |
| `queries.ts` | Server-only reads: feed, by-slug, host's list | integration |

Server Actions live in `app/host/events/actions.ts`, following where Phase 0 put
`app/login/actions.ts`. Session helpers go in `lib/auth/session.ts`.

### Routes

| Route | Access | Purpose |
|---|---|---|
| `/` | public | City feed of upcoming published events, optional `?city=` |
| `/e/[slug]` | public | The shareable event page |
| `/host` | signed in | The host's own events, drafts included |
| `/host/events/new` | signed in | Create form |
| `/host/events/[id]/edit` | owner | Edit, publish, cover image |

`params` is a Promise in Next.js 16. Pages use the generated `PageProps<'/e/[slug]'>`
helper from `next typegen` rather than hand-written prop types.

## Key decisions

### Writes use the RLS-scoped user client, not the service role

Phase 0 granted `authenticated` `insert, update, delete` on `events` and
`ticket_types`, narrowed by `current_host_id()` and `owns_event()`. Phase 1
touches no money and no inventory, so those grants are sufficient and no new
`SECURITY DEFINER` function is needed.

Reaching for `lib/supabase/admin.ts` here would bypass the exact permission model
Phase 0 built and tested. Keeping writes on the user client means the existing RLS
tests double as authorization tests for this feature — a cross-tenant write is
rejected by Postgres, not by an `if` statement someone can forget.

### The slug is generated once and never changes

Format: kebab-cased title truncated to 60 characters, plus six random base32
characters — `diwali-supper-club-k7m2xq`.

Rejected, and why:

- **Bare kebab with collision retry.** A host running a monthly supper club
  collides with themselves every month, and sequential fallbacks (`-2`, `-3`)
  leak how many events exist.
- **Regenerating the slug when the title is edited.** This is the dangerous one.
  The link is already sitting in a WhatsApp group by the time a host fixes a typo
  in their title. Breaking it silently would be the worst bug available in this
  phase, so the slug is written on insert and never touched again.

### `datetime-local` is zoneless, and that is a trap

The input yields `"2026-08-15T19:30"` with no offset. `new Date()` on that string
resolves against the *server's* zone: correct-looking on a developer machine in
IST, and 5½ hours wrong on Vercel, which runs UTC. Every event would shift.

Conversion is therefore an explicit pure function pinned to `Asia/Kolkata`, with
unit tests covering both directions. The app is IST-only today; the function is
the single place that assumption lives, so widening it later is one change.

### Cover image paths are keyed by user, not by event

`event-covers/{auth.uid()}/{random}.ext`, in a public-read bucket, with insert,
update and delete restricted to a folder matching the caller's own uid.

Keying by `auth.uid()` rather than `event_id` is what lets a host attach an image
*before* the event row exists — an event-keyed path would force the create form
into a two-step save. Abandoned drafts leave orphaned objects; at pilot volume
that is cheaper to tolerate than to reap, and it is noted rather than solved.

### `/e/[slug]` needs OpenGraph tags

Not polish. The link's first impression is the preview card WhatsApp renders from
`og:title`, `og:description` and `og:image`. A link that unfurls as a bare URL
reads as spam in a group chat, which defeats the one distribution channel the
product has. Implemented with `generateMetadata`.

### Host creation is implicit

A signed-in user has a `profiles` row but no `hosts` row. The create action
resolves-or-creates the host, defaulting `display_name` from the profile name,
falling back to the phone number. This protects the "publish in under three
minutes" goal; the host can correct their display name from the dashboard later.

### Draft saves cheaply, publish validates hard

The draft schema requires only what the Phase 0 schema declares `NOT NULL`:
`title` (3–140 characters, per the existing `CHECK`), `city`, and `starts_at`.
Everything else — description, venue, cover image, end time — is optional in a
draft, so a half-filled form is never lost.

`validateForPublish()` is a pure function returning a list of what is still
missing: a venue name, a `starts_at` in the future, and a ticket type with
`quantity > 0`. Returning a list rather than throwing on the first failure lets
the edit page show every blocker at once instead of one per attempt.

The create form must therefore collect title, city and start time before it can
save anything at all. That is the floor the database sets, not a product choice,
and it is worth knowing before designing the form: there is no "save an empty
draft and fill it in later" path without a schema change.

## Data flow

```
create form
  → Server Action
      → resolve-or-create hosts row
      → insert events   (status 'draft', slug generated here)
      → insert ticket_types ("General", seats, price)
  → redirect to /host/events/[id]/edit

publish action
  → validateForPublish()
      → on failure: return blockers, stay on page
      → on success: update status 'published', set published_at
  → the /e/[slug] link becomes live
```

Capacity and price are entered as a single "seats" and "price" pair and stored as
one `ticket_types` row. There is deliberately no `events.capacity` column — the
Phase 0 schema makes `ticket_types` the only inventory truth, so a single implicit
type keeps that invariant while matching how a 20-person board-game night is
actually run. Multi-tier editing is deferred until a host asks.

Price is entered in rupees and stored via `rupeesToPaise()` from `lib/money.ts`.
Integer paise, everywhere, as always.

## Migration

One new migration adds the `event-covers` storage bucket and its policies. Run
`npm run db:types` afterwards; the generated `lib/supabase/types.ts` is committed.

## Testing

**Unit (pure):** slug shape, stability and character set; IST↔UTC conversion in
both directions, asserting the fixed +05:30 offset holds in January and in July
(India observes no DST, so a seasonal difference would mean the implementation is
reading the host machine's zone rather than `Asia/Kolkata`); rupee→paise form
parsing including the fractional-input case; `validateForPublish()` across each
missing requirement and the all-present case.

**Integration**, extending `tests/helpers/db.ts`:

- Host B cannot read or update host A's draft
- Anon can read a published event; anon cannot read a draft
- Slug uniqueness is enforced by the database
- A storage write into another user's folder is denied
- Publishing sets `published_at` and makes the row visible to anon

## Verification

1. `npm run typecheck` and `npm run lint` clean
2. `npm test` green, including the Phase 0 suite
3. Sign in with a test number, create an event, publish it
4. Open `/e/[slug]` in a private window — the page renders without a session
5. Confirm the OG tags are present in the served HTML

## Known limitations

- Orphaned cover images from abandoned drafts are not reaped
- The feed shows all cities with an optional filter; there is no ranking, by design
- No pagination on the feed or dashboard — pilot volume does not need it
