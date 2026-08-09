import { describe, expect, it } from 'vitest'
import { buildSlug, isEventSlug, slugifyTitle } from '@/lib/events/slug'

// Mirrors SUFFIX_ALPHABET in slug.ts: digits 2-9 plus a-z without i, l, o, u.
// Asserting [a-z0-9] instead would let a re-introduced look-alike through.
const SUFFIX = /[2-9a-hjkmnp-tv-z]{6}/

describe('slugifyTitle', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyTitle('Diwali Supper Club')).toBe('diwali-supper-club')
  })

  it('strips accents rather than dropping the letter', () => {
    expect(slugifyTitle('Café Night')).toBe('cafe-night')
  })

  it('strips a mid-word accent without splitting the word', () => {
    // This is the case that actually guards the combining-mark strip. A
    // word-FINAL accent (Café) survives without it, because NFKD leaves the
    // mark next to the following space and [^a-z0-9]+ swallows both as one
    // run. Mid-word there is no space to hide in: drop the strip and this
    // becomes 'me-nage-supper'.
    expect(slugifyTitle('Ménage Supper')).toBe('menage-supper')
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
    expect(slug).toMatch(new RegExp(`^diwali-supper-club-${SUFFIX.source}$`))
  })

  it('falls back to "event" when the title slugifies to nothing', () => {
    expect(buildSlug('दिवाली')).toMatch(new RegExp(`^event-${SUFFIX.source}$`))
  })

  it('never draws a look-alike character into the suffix', () => {
    // 200 slugs is 1200 drawn characters. A single look-alike put back into
    // SUFFIX_ALPHABET has a ~1-in-30 chance per character, so it shows up here
    // essentially every run; the two assertions above draw only 6 characters
    // each and would miss such a regression about two runs in three.
    const suffixes = Array.from({ length: 200 }, () => buildSlug('Supper Club').slice(-6))
    const offenders = suffixes.filter((suffix) => !new RegExp(`^${SUFFIX.source}$`).test(suffix))
    expect(offenders).toEqual([])
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

describe('isEventSlug', () => {
  it('accepts every slug buildSlug can produce', () => {
    // The property that matters most: the guard exists to be applied to real
    // slugs, so a false negative here is a stale seats-left count on a page
    // somebody is looking at. Titles chosen to reach each branch of
    // slugifyTitle — accents, punctuation runs, the empty fallback, the
    // 60-character truncation.
    const titles = ['Diwali Supper Club', 'Café!! Night', 'दिवाली', 'A'.repeat(200), '  ...Pop-Up...  ']
    const rejected = titles.map(buildSlug).filter((slug) => !isEventSlug(slug))
    expect(rejected).toEqual([])
  })

  it('rejects the empty string', () => {
    // `/e/${''}` is `/e/`, which is not this route and not nothing either.
    expect(isEventSlug('')).toBe(false)
  })

  it('rejects anything carrying a path separator', () => {
    // The reason the guard exists. A form field interpolated into
    // `/e/${slug}` otherwise names any path in the app, and revalidatePath
    // takes whatever it is handed.
    expect(isEventSlug('../../host/events')).toBe(false)
    expect(isEventSlug('a/b')).toBe(false)
    expect(isEventSlug('/')).toBe(false)
  })

  it('rejects an escape hatch spelled with percent-encoding', () => {
    // %2f is a slash to anything that decodes the path afterwards, and it is
    // made only of characters a naive [a-z0-9-] check would wave through if the
    // '%' were ever added to the class.
    expect(isEventSlug('a%2fb')).toBe(false)
    expect(isEventSlug('a%2Fb')).toBe(false)
  })

  it('rejects characters buildSlug cannot emit', () => {
    // Uppercase, spaces, dots and query syntax all die in slugifyTitle, so a
    // slug carrying one did not come from this app.
    for (const value of ['Diwali-Supper', 'diwali supper', 'diwali.supper', 'diwali?x=1', 'diwali#top']) {
      expect(isEventSlug(value)).toBe(false)
    }
  })

  it('rejects hyphens in positions buildSlug never puts them', () => {
    // slugifyTitle trims leading and trailing separators and collapses runs, so
    // none of these is a slug this app wrote. Refusing them keeps the guard an
    // allowlist of the real shape rather than a blocklist of known-bad strings.
    for (const value of ['-diwali-ab23cd', 'diwali-ab23cd-', 'diwali--ab23cd', '-', '--']) {
      expect(isEventSlug(value)).toBe(false)
    }
  })

  it('rejects a slug longer than buildSlug can produce', () => {
    // The bound is derived from the same two constants buildSlug uses, so it
    // cannot drift away from the real maximum the way a hardcoded 67 would.
    const longest = buildSlug('a'.repeat(200))
    expect(isEventSlug(longest)).toBe(true)
    expect(isEventSlug(`${longest}x`)).toBe(false)
  })
})
