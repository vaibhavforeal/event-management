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
