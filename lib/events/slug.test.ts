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
