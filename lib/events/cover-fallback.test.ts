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
