# Attendee UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the five attendee surfaces (feed, event page, booking panels, bookings/ticket, login) into the approved "warm festival, editorial manners" direction — new tokens, one serif display font, class-level changes only.

**Architecture:** Token expansion in `globals.css` + one `next/font` addition ripple through existing components; each page then gets a class-only restyle applying shared recipes. One new pure helper (`coverFallbackClass`) picks category-tinted gradient fallbacks for cover-less events. No routes, components APIs, or copy change.

**Tech Stack:** Next 16 (app router), Tailwind v4 (`@theme` tokens), next/font (Fraunces), vitest.

**Spec:** `docs/specs/2026-08-15-attendee-ui-redesign-design.md`. Approved comp: `.superpowers/brainstorm/203366-1786787125/content/fusion.html` (open it in a browser to see the target).

## Global Constraints

- **Copy freeze:** every EXISTING user-facing string stays byte-identical — the 995-test suite asserts on sentences and must pass UNMODIFIED. The ONE permitted addition is the feed tagline (Task 3), which is new static text no test asserts on (Task 3 proves this by grep before adding it).
- **Light only:** do not touch `color-scheme: only light` or add dark variants.
- **Contrast:** every new text/background pair ≥ 4.5:1. Pre-verified: white on ember ≈ 5.2:1, ember on paper ≈ 5.0:1, ember-deep on cream ≈ 8.6:1. Marigold NEVER colors text.
- **One warm accent per component** — a card body never mixes ember, marigold and verdigris.
- **No new JS deps.** Only the Fraunces font file enters, via `next/font/google` like Geist. `package.json` gains nothing.
- **Image/perf rules untouched:** `CARD_SIZES`, single-`preload`, cover `sizes` attributes, and every `break-words`/`min-w-0` stay exactly as found.
- **Host/admin/scanner are OUT of scope.** Do not edit anything under `app/host/`, `app/admin/`, or the scan route.
- Repo rule: this Next version has breaking changes — check `node_modules/next/dist/docs/` before using unfamiliar Next APIs.

## Shared Recipes (the design vocabulary — used verbatim by Tasks 3–6)

| Recipe | Exact classes |
|---|---|
| Card surface | `rounded-xl bg-white shadow-[0_2px_12px_rgba(124,45,18,0.10)]` (replaces `border-line … border`) |
| Primary button (pill) | `bg-ember text-white rounded-full px-5 py-3 text-[15px] font-semibold hover:bg-ember-deep disabled:bg-raised disabled:text-muted` |
| Secondary button (pill) | `bg-white border border-cream-line text-ember-deep rounded-full px-4 py-3 text-[14px] font-medium disabled:opacity-60` |
| Chip, selected | `bg-ember text-white rounded-full px-3 py-1` |
| Chip, unselected | `bg-white border border-cream-line text-ember-deep rounded-full px-3 py-1` |
| Uppercase label | `text-[11px] tracking-[0.08em] uppercase text-muted` |
| Display type | add `font-display` to the existing heading classes |
| Info panel | `rounded-[10px] bg-white border border-cream-line` |

Rules: primary CTA = ember. Money amounts and positive/confirmed states = `text-accent` (verdigris) unless inside an ember button. Urgency ("4 seats left" style, cancel-consequence warnings) = `text-ember`.

---

### Task 1: Tokens and the display font

**Files:**
- Modify: `app/globals.css` (the `@theme inline` block, lines ~25-35)
- Modify: `app/layout.tsx` (font imports, lines 1-14 and the `<html>` className, line 45)

**Interfaces:**
- Produces: Tailwind utilities `bg-ember`, `text-ember`, `text-ember-deep`, `bg-cream`, `border-cream-line`, `from-marigold`/`to-marigold` (gradients only), and the `font-display` utility. Every later task consumes these.

- [ ] **Step 1: Add Fraunces to the root layout**

In `app/layout.tsx`, extend the font imports:

```tsx
import { Fraunces, Geist, Geist_Mono } from 'next/font/google'
```

after `geistMono`, add:

```tsx
/**
 * Display serif for page titles and event names only — the editorial half of
 * the redesign (spec 2026-08-15). Variable, latin subset, one file; body text
 * stays Geist so the reading surfaces don't change voice.
 */
const fraunces = Fraunces({
  variable: '--font-fraunces',
  subsets: ['latin'],
})
```

and add the variable to the `<html>` className:

```tsx
className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
```

- [ ] **Step 2: Add the tokens to globals.css**

Inside the existing `@theme inline` block, after `--color-raised`, add:

```css
  /*
    The warm half of the redesign (spec 2026-08-15). ember is THE warm accent:
    primary CTAs, date badges, urgency. marigold is gradient/decorative fill
    ONLY — its contrast on paper fails for text, so it must never color any.
    cream/cream-line are the quiet warm tint for chips and info panels.
    Verdigris (--color-accent) keeps money and positive states.
  */
  --color-ember: #c2410c;
  --color-ember-deep: #7c2d12;
  --color-marigold: #f5a623;
  --color-cream: #fdf3e0;
  --color-cream-line: #f0e2d0;
```

and after `--font-mono`:

```css
  --font-display: var(--font-fraunces);
```

- [ ] **Step 3: Verify the build sees all of it**

Run: `npm run build`
Expected: clean build. Then `grep -c "ember\|cream\|marigold\|font-display" app/globals.css` returns ≥ 6.

- [ ] **Step 4: Run the full gates**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 995 tests pass (nothing behavioral moved), 0 type errors, 0 lint errors.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css app/layout.tsx
git commit -m "feat: warm tokens (ember/marigold/cream) and Fraunces display font"
```

---

### Task 2: Cover-fallback gradients (the one testable unit — TDD)

**Files:**
- Create: `lib/events/cover-fallback.ts`
- Test: `lib/events/cover-fallback.test.ts`

**Interfaces:**
- Produces: `coverFallbackClass(category: string | null): string` — returns a COMPLETE static Tailwind class string (JIT must see whole literals; never build class names by concatenation). Tasks 3 and 4 consume it.

- [ ] **Step 1: Write the failing test**

Create `lib/events/cover-fallback.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { coverFallbackClass, DEFAULT_COVER_FALLBACK } from '@/lib/events/cover-fallback'

describe('coverFallbackClass', () => {
  it('warms food-shaped categories with ember-to-marigold', () => {
    for (const category of ['Supper club', 'supper', 'Pop-up dinner', 'Food tasting', 'Chai & chaat']) {
      expect(coverFallbackClass(category)).toBe('bg-gradient-to-br from-ember to-marigold')
    }
  })

  it('cools game-shaped categories with the verdigris pair', () => {
    for (const category of ['Board games', 'Game night', 'Quiz', 'Trivia evening']) {
      expect(coverFallbackClass(category)).toBe('bg-gradient-to-br from-accent to-[#2d9d85]')
    }
  })

  it('deepens craft-shaped categories with aubergine-to-verdigris', () => {
    for (const category of ['Workshop', 'Pottery workshop', 'Art & craft', 'Painting']) {
      expect(coverFallbackClass(category)).toBe('bg-gradient-to-br from-[#3b0764] to-accent')
    }
  })

  it('falls back for null, empty, whitespace and unknown categories', () => {
    for (const category of [null, '', '   ', 'Something else entirely']) {
      expect(coverFallbackClass(category)).toBe(DEFAULT_COVER_FALLBACK)
    }
  })

  it('default is the ember-to-verdigris house gradient', () => {
    expect(DEFAULT_COVER_FALLBACK).toBe('bg-gradient-to-br from-ember to-accent')
  })
})
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx vitest run cover-fallback`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/events/cover-fallback.ts`:

```ts
/**
 * Category-tinted gradient fallbacks for events without a cover image
 * (spec 2026-08-15). events.category is free text and usually null, so this
 * is a keyword sniff with an honest default, not a taxonomy.
 *
 * Every return value is a COMPLETE class literal: Tailwind's compiler only
 * generates what it can see, so these strings must never be assembled.
 */
export const DEFAULT_COVER_FALLBACK = 'bg-gradient-to-br from-ember to-accent'

const FOOD = ['supper', 'dinner', 'food', 'brunch', 'lunch', 'chai', 'chaat', 'tasting', 'pop-up', 'popup']
const GAMES = ['game', 'board', 'quiz', 'trivia']
const CRAFT = ['workshop', 'craft', 'art', 'pottery', 'paint']

export function coverFallbackClass(category: string | null): string {
  const folded = category?.trim().toLowerCase()
  if (!folded) return DEFAULT_COVER_FALLBACK
  if (FOOD.some((word) => folded.includes(word))) return 'bg-gradient-to-br from-ember to-marigold'
  if (GAMES.some((word) => folded.includes(word))) return 'bg-gradient-to-br from-accent to-[#2d9d85]'
  if (CRAFT.some((word) => folded.includes(word))) return 'bg-gradient-to-br from-[#3b0764] to-accent'
  return DEFAULT_COVER_FALLBACK
}
```

- [ ] **Step 4: Run the test, watch it pass — then mutation-check it**

Run: `npx vitest run cover-fallback`
Expected: PASS.
Mutation check (this repo's standing rule — a test that can't go red proves nothing): make `coverFallbackClass` return `DEFAULT_COVER_FALLBACK` unconditionally, re-run, expect the three category tests RED, then restore and re-run GREEN.

- [ ] **Step 5: Commit**

```bash
git add lib/events/cover-fallback.ts lib/events/cover-fallback.test.ts
git commit -m "feat: category-tinted cover fallback gradients"
```

---

### Task 3: The feed

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/_components/event-card.tsx`

**Interfaces:**
- Consumes: Task 1 utilities, Task 2 `coverFallbackClass` — `FeedEvent` already carries `category` IF the feed query selects it; Step 0 verifies and, if absent, adds `category` to `FEED_COLUMNS` in `lib/events/queries.ts` and to the `FeedEvent` type (a read-only column addition; RLS already exposes the row).

- [ ] **Step 0: Verify the copy-freeze exception and the category column**

Run: `grep -rn "What is on" --include="*.test.*" .` — expected: no hits (no test asserts the feed heading; if one exists, STOP and leave the tagline out).
Run: `grep -n "category" lib/events/queries.ts` — if `FEED_COLUMNS` lacks `category`, add it to the select string and to the `FeedEvent` interface as `category: string | null`.

- [ ] **Step 1: Restyle the feed page (`app/page.tsx`)**

- h1 (line ~64): `className="text-2xl font-semibold"` → `className="font-display text-[26px] font-semibold"`
- Directly under the h1 row's closing `</div>` (after line ~82), add the one permitted new line:

```tsx
      <p className="text-[11px] tracking-[0.08em] uppercase text-muted mb-4 -mt-3">
        Supper clubs · game nights · workshops · pop-ups
      </p>
```

- City chips (line ~107): selected stays `bg-ink text-paper` → becomes `bg-ember text-white`; unselected `border-line border` → `bg-white border border-cream-line text-ember-deep`. Keep `min-w-0 rounded-full px-3 py-1 break-words` exactly.
- The unknown-city chip (line ~123): `bg-ink text-paper` → `bg-ember text-white`.
- Empty state `<p>` (line ~137): add `bg-white` and swap `border border-dashed` for the Card surface recipe minus rounding change: `className="text-muted rounded-xl bg-white p-8 text-center shadow-[0_2px_12px_rgba(124,45,18,0.10)]"`.

- [ ] **Step 2: Restyle the event card (`app/_components/event-card.tsx`)**

- Import `coverFallbackClass` from `@/lib/events/cover-fallback`.
- Root `<Link>` (line ~26): `border-line hover:border-muted block overflow-hidden rounded-xl border transition` → `block overflow-hidden rounded-xl bg-white shadow-[0_2px_12px_rgba(124,45,18,0.10)] transition hover:shadow-[0_4px_16px_rgba(124,45,18,0.16)]`.
- Cover-less fallback div (line ~45): `from-line to-raised h-40 w-full bg-gradient-to-br` → `` className={`h-40 w-full ${coverFallbackClass(event.category)}`} ``.
- Date line (line ~48): `text-muted text-sm` → `text-[11px] tracking-[0.08em] uppercase text-ember font-semibold`.
- Title (line ~61): add `font-display` and bump: `font-display text-[16px] font-semibold leading-snug break-words`.
- Venue line (line ~62): `text-muted text-sm break-words` → `text-[11px] tracking-[0.08em] uppercase text-muted break-words`.
- Price (line ~64): `text-sm font-medium` → `text-sm font-bold text-accent`.
- Do NOT touch `CARD_SIZES`, `preload`, `sizes`, or any comment.

- [ ] **Step 3: Gates and eyeball**

Run: `npx vitest run events && npm run typecheck && npm run lint`
Expected: green. Then `npm run build` clean.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx app/_components/event-card.tsx lib/events/queries.ts
git commit -m "feat: the feed wears the warm festival look"
```

---

### Task 4: The event page and its booking panels

**Files:**
- Modify: `app/e/[slug]/page.tsx`
- Modify: `app/e/[slug]/book-panel.tsx`
- Modify: `app/e/[slug]/request-panel.tsx`
- Modify: `app/e/[slug]/join-waitlist-panel.tsx`

**Interfaces:**
- Consumes: Task 1 utilities, Task 2 `coverFallbackClass` (the page's query result already carries `category` via `PublicEvent extends FeedEvent` once Task 3's Step 0 added it — verify with `grep -n "category" lib/events/queries.ts` before starting).

This page already has an editorial identity — mono `SectionLabel` ticks, the
`SeatMarks` signature, the fixed bottom bar. PRESERVE all three; the redesign
warms it, it does not replace it.

- [ ] **Step 1: Restyle `app/e/[slug]/page.tsx`**

- Cover fallback: the page renders `<Image>` only when `cover_image_url` exists (line ~245). Add an `else` branch so cover-less events get the gradient:

```tsx
      {event.cover_image_url ? (
        <Image /* …unchanged props, keep priority/sizes/className exactly… */ />
      ) : (
        <div aria-hidden className={`aspect-[1200/630] w-full sm:rounded-b-2xl ${coverFallbackClass(event.category)}`} />
      )}
```

- Header date line (line ~267): `text-accent font-mono text-[11px] tracking-[0.18em] uppercase` → `text-ember font-mono text-[11px] tracking-[0.18em] uppercase`.
- h1 (line ~275): add `font-display` in front of the existing classes.
- `SectionLabel` (line ~117) and `SeatMarks` (line ~143): UNCHANGED — verdigris structure ticks and seat fills are the page's own signature (one warm accent per component: the header owns ember, sections own verdigris).
- The inert fallback button in the bottom bar (line ~436): `border-line bg-raised text-muted shrink-0 rounded-lg border px-5 py-3 text-[15px] font-medium` → `bg-raised text-muted shrink-0 rounded-full px-5 py-3 text-[15px] font-medium`. Its three sentences stay byte-identical.

- [ ] **Step 2: Restyle the three panels (class-only, same recipe)**

In each of `book-panel.tsx`, `request-panel.tsx`, `join-waitlist-panel.tsx`:

- Every primary submit button — in book-panel.tsx (line ~101) that is `bg-ink text-paper rounded-lg px-5 py-3 text-[15px] font-medium disabled:opacity-60` — becomes `bg-ember text-white rounded-full px-5 py-3 text-[15px] font-semibold hover:bg-ember-deep disabled:opacity-60`.
- Every secondary button (book-panel.tsx line ~111 "Cash at the door": `border-line text-ink rounded-lg border px-4 py-3 text-[14px] font-medium disabled:opacity-60`) becomes the Secondary recipe: `bg-white border border-cream-line text-ember-deep rounded-full px-4 py-3 text-[14px] font-medium disabled:opacity-60`.
- Inputs/selects: `border-line … rounded-lg border` → `border-cream-line bg-white … rounded-lg border` (inputs stay rounded-lg — pills are for buttons).
- Button LABELS, error strings, aria labels: byte-identical. If a panel file's buttons differ structurally from book-panel's, apply the same recipe by role (primary submit vs secondary), never invent new colors.

- [ ] **Step 3: Gates**

Run: `npx vitest run "e/\[slug\]" && npm run typecheck && npm run lint && npm run build`
(If the bracket filter misses on this shell, `npx vitest run slug` also matches the route's tests.)
Expected: all green — these suites assert sentences and action wiring, neither of which moved.

- [ ] **Step 4: Commit**

```bash
git add "app/e/[slug]/page.tsx" "app/e/[slug]/book-panel.tsx" "app/e/[slug]/request-panel.tsx" "app/e/[slug]/join-waitlist-panel.tsx"
git commit -m "feat: the event page warms up — ember header and CTAs, gradient covers"
```

---

### Task 5: Bookings list and the ticket page

**Files:**
- Modify: `app/bookings/page.tsx`
- Modify: `app/bookings/cancel-button.tsx`
- Modify: `app/bookings/[reference]/page.tsx`
- Modify: `app/bookings/[reference]/checkout-panel.tsx`
- Modify: `app/bookings/[reference]/approved-pay-panel.tsx`
- Modify: `app/bookings/[reference]/claim-seat-panel.tsx`

**Interfaces:**
- Consumes: Task 1 utilities only.

- [ ] **Step 1: Restyle `app/bookings/page.tsx`**

- h1 (line ~37): add `font-display`.
- Booking card `<li>` (line ~50): `border-line rounded-xl border p-4` → `rounded-xl bg-white p-4 shadow-[0_2px_12px_rgba(124,45,18,0.10)]`.
- The status word inside the mono line (line ~62 `… · {booking.status}`) gets color WITHOUT changing text — wrap only the interpolation:

```tsx
<span className={
  booking.status === 'confirmed' ? 'text-accent'
  : booking.status === 'cancelled' || booking.status === 'refunded' ? 'text-muted'
  : 'text-ember'
}>{booking.status}</span>
```

- [ ] **Step 2: Restyle the ticket page and its panels**

`app/bookings/[reference]/page.tsx` (347 lines — read it first):

- Page/event headings: add `font-display` to the existing h1/h2 classes.
- Card-shaped containers (`border-line … border` boxes): Card surface recipe.
- **THE QR BLOCK IS UNTOUCHABLE.** Locate the QR/ticket-code render; its container, quiet zone, and black-on-white contrast keep exactly the classes they have — scannability beats style (spec rule). Add a plan-visible comment only if one already exists to anchor on; otherwise change nothing inside it.
- Amount lines: money values get `text-accent` per the recipe if they don't already carry it.

In `checkout-panel.tsx`, `approved-pay-panel.tsx`, `claim-seat-panel.tsx`, `cancel-button.tsx`:

- Primary submit buttons → Primary recipe (as Task 4 Step 2, byte-identical labels).
- Secondary/destructive: cancel-button's control keeps its current quiet shape but its consequence/warning line, if it has a color, becomes `text-ember` (urgency per recipe rules). Labels byte-identical.

- [ ] **Step 3: Gates**

Run: `npx vitest run bookings && npm run typecheck && npm run lint && npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add app/bookings
git commit -m "feat: bookings and the ticket page join the palette — QR stays black-on-white"
```

---

### Task 6: Login

**Files:**
- Modify: `app/login/page.tsx`
- Modify: `app/login/login-form.tsx`

**Interfaces:**
- Consumes: Task 1 utilities only.

- [ ] **Step 1: Restyle**

- `page.tsx` h1 (line ~29): `text-2xl font-semibold tracking-tight` → `font-display text-2xl font-semibold tracking-tight`.
- `login-form.tsx` (read it first): primary submit → Primary recipe; inputs → `border-cream-line bg-white` borders as in Task 4; every sentence and label byte-identical.

- [ ] **Step 2: Gates**

Run: `npx vitest run login && npm run typecheck && npm run lint`
Expected: green (or "no test files found" for login — then run `npm run test`).

- [ ] **Step 3: Commit**

```bash
git add app/login
git commit -m "feat: login joins the palette"
```

---

### Task 7: Full gates and the visual pass

**Files:** none created — verification only.

- [ ] **Step 1: The whole suite, unmodified**

Run: `npm run test`
Expected: **995 passed**, zero test-file changes in `git status` beyond `cover-fallback.test.ts` (Task 2's addition). Any other test edit means a copy freeze violation — find it and fix the SOURCE, not the test.

- [ ] **Step 2: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: The eyeball against the comp**

Run: `npm run start` (build from Step 2). On a 390px viewport open `/`, `/e/walk-future-supper`, `/login`, `/bookings` (login `919999900001`, OTP `123456` — dev stack must be up: `npm run db:start`). Compare against `.superpowers/brainstorm/203366-1786787125/content/fusion.html`. The checklist: serif titles rendering (Fraunces, not a fallback serif); ember CTAs; white cards with warm shadows; chips restyled; gradient fallback on the cover-less walk events; QR page black-on-white.

- [ ] **Step 4: Hand to the user for the visual verdict**

The user eyeballs the same four pages. Only after their approval: merge and push.

```bash
git checkout master
git merge --no-ff attendee-ui-redesign -m "Merge: attendee UI redesign — warm festival, editorial manners"
git push origin master
```

---

## Mock-vs-spec reconciliations (decided here, do not re-litigate)

- The fusion mock's title reads "What's on *in Indore*". The real h1 is the
  static "What is on" and the copy freeze keeps it; the city already lives in
  the chip row. The serif + the tagline carry the mock's warmth instead.
- The mock's event page shows a price/seats/host stat strip. The real page
  already answers those in its sections and fixed bottom bar; "no layout
  re-architecture" wins, so the strip is realized by warming what exists, not
  by adding a panel.

## Execution notes

- Branch: `attendee-ui-redesign` off master, created before Task 1.
- Implementers run NO git except the commits their task prescribes (or, under
  subagent-driven execution, the controller commits — follow the sub-skill).
- Tasks 3–6 are class-level edits to files an implementer MUST read first;
  line numbers are anchors, not gospel — match on the quoted class strings.
- The themeColor (`#0f5e52` in `app/layout.tsx` viewport + `app/manifest.ts`)
  is deliberately NOT touched: the spec defers it to an eyes-on follow-up.
  `app/manifest.test.ts` asserts the current colors; leave both alone.

