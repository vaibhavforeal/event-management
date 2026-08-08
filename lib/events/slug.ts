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
