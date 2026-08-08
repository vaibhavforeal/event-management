import { describe, expect, it } from 'vitest'
import { buildSlug, slugifyTitle } from '@/lib/events/slug'

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
