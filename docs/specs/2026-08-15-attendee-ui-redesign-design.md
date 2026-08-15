# Attendee UI redesign — warm festival, editorial manners

**Date:** 2026-08-15
**Status:** Approved (direction chosen via visual companion mockups; both
design sections approved in session)
**Scope:** attendee-facing surfaces only. Host, admin and scanner inherit the
new tokens but get no restyle pass — that is a later phase if wanted.

## Why

The v1 UI is one warm palette (paper/ink/muted/line/raised + verdigris) used
at minimum intensity: hairline borders, small muted type, a single accent.
Deliberate, but it reads as a skeleton — and the attendee surfaces are the
product's storefront on a WhatsApp-forwarded link. The user asked for
"colorful and better looking."

Direction was chosen from three mocked alternatives (warm festival / playful
sticker / rich editorial). The ruling: **A's warm festival color with C's
editorial restraint**, leaning quieter wherever in doubt. Playful sticker is
explicitly out: no black outlines, no emoji chips, no tilted elements.

## The visual system

### Tokens (globals.css `@theme`)

Every existing token stays, same values, same meanings. Additions:

| Token | Value | Role |
|---|---|---|
| `--color-ember` | `#c2410c` | THE warm accent: primary CTAs, date badges, urgency ("4 seats left") |
| `--color-ember-deep` | `#7c2d12` | text-on-cream chip text, hover states of ember |
| `--color-marigold` | `#f5a623` | cover-fallback gradients and small highlights ONLY — never text |
| `--color-cream` | `#fdf3e0` | quiet warm tint: chips, info panels |
| `--color-cream-line` | `#f0e2d0` | borders on cream/white panels |

Verdigris (`--color-accent`) keeps money and positive/confirmed states.
Ink/paper/muted/line/raised keep their roles everywhere the redesign does not
explicitly touch.

**Rules of restraint (the C+ ruling, enforceable in review):**

- One warm accent per component. A card body never carries ember, marigold
  and verdigris at once.
- Marigold never colors text (its contrast on paper/white fails); it lives in
  gradients and decorative fills only.
- Every text/background pair ≥ 4.5:1, measured on the actual pair, the same
  standard globals.css already documents. White on ember (#fff on #c2410c ≈
  4.9:1) passes; ember on paper passes for the bold/large uses it gets.
- Light-only stands. `color-scheme: only light` and the Chrome-on-Android
  auto-darkening opt-out are untouched.

### Typography

- **Fraunces** (variable, `next/font/google` like Geist, latin subset) joins
  as `--font-display`: page titles, event names, and nothing else.
- Geist stays for body, UI, buttons; Geist Mono keeps codes/references.
- Metadata lines (venue, stat labels) become small uppercase letter-spaced
  Geist — C's manner: `text-[11px] tracking-wide uppercase text-muted`.

### Depth and shape

- Cards: white surface on paper, `rounded-xl`, soft warm shadow
  (`shadow-[0_2px_12px_rgba(124,45,18,0.10)]`) instead of hairline border.
- Buttons: pills (`rounded-full`). Primary = ember bg, white text. Secondary
  = white bg, cream-line border, ember-deep text. Disabled keeps `raised`.
- Chips (city filter): selected = ember bg white text; unselected = white bg,
  cream-line border, ember-deep text.
- Cover-less events: category-tinted gradient fallback instead of today's
  grey (`from-line to-raised`). Ember→marigold for suppers/food, verdigris
  family for games, aubergine-ish `#3b0764`→verdigris for workshops/craft,
  ember→verdigris as the no-category default. Category is free text and
  usually null — match on a small keyword map, default gradient otherwise.

## Where it applies

| Surface | Treatment |
|---|---|
| Feed `/` | Serif "What's on" title with italic ember city; uppercase tagline; chip row restyled; EventCard gets white surface + shadow, date badge overlaid on the cover, serif title, uppercase venue line, verdigris price |
| Event page `/e/[slug]` | Cover (or gradient fallback); uppercase ember date line; serif title; stat panel (price / seats / host) as a white card with uppercase labels; ember pill CTA with "Your ticket arrives on WhatsApp" under it — copy that already exists on the page stays byte-identical |
| Booking flow (ticket picker → payment → confirmation) | Same components re-skinned: white cards, ember CTAs, verdigris confirmations. No step is added, removed or reordered |
| `/bookings` (list + ticket QR) | Booking cards white + shadow; the QR panel stays maximum-contrast pure black-on-white (scannability wins over style); status colors: confirmed = verdigris, awaiting = ember, cancelled/refunded = muted |
| `/login` | Same card treatment, serif heading, ember primary button |

Host `/host/**`, admin `/admin`, scanner: no restyle. They inherit token-level
changes only where they already use shared components; their layouts and
local styling are not touched in this phase.

## What does NOT change

- **No copy.** Every user-facing sentence stays byte-identical; the test
  suite asserts on sentences and must stay green unmodified.
- **No routes, no layout re-architecture, no component API changes.** This
  is a class-names-and-tokens pass plus the one font addition.
- **No new JS dependencies.** Fraunces arrives as a self-hosted font file via
  next/font, nothing else enters package.json.
- **Image/perf rules stand:** EventCard's `CARD_SIZES`, single-preload rule,
  and cover variant sizing are documented mid-Android/WhatsApp decisions and
  are kept exactly. `break-words` on host-supplied strings stands everywhere.

## Implementation shape

1. One commit: tokens + Fraunces + shared primitives (button/chip/card
   classes where shared).
2. One commit per page group: feed, event page, booking flow, bookings/QR,
   login.
3. Screenshot-check each page at 390px against the approved mockups
   (`.superpowers/brainstorm/203366-1786787125/content/fusion.html` holds the
   approved comp).
4. Full gates at the end: 995 tests, typecheck, lint, `next build`.

## Verification

- The suite passing UNMODIFIED is the behavioral proof (no sentence, route
  or flow moved).
- Visual proof: 390px screenshots of the five surfaces, eyeballed against the
  fusion mockup.
- Contrast: spot-check every new text/background pair against 4.5:1.
- The manifest/PWA theme color (`#0f5e52`) is revisited LAST: if the app bar
  reads wrong against the new feed, switching themeColor to ember is a
  one-line follow-up decided by eye, not in this spec.
