/**
 * Event slugs.
 *
 * A slug is written once, at insert, and never changes — not even when the host
 * edits the title. By then the link is already sitting in a WhatsApp group, and
 * silently breaking it is the worst bug available in this phase.
 */

const MAX_TITLE_CHARS = 60
const SUFFIX_LENGTH = 6

// Crockford base32 minus '0' and '1', so a slug read aloud down a phone line
// survives the trip. Crockford already omits i/l/o (they are misheard and
// misread as 1/1/0) and u (dropping it is the conventional way to avoid
// accidentally spelling something obscene). Dropping the digits 0 and 1 as
// well leaves nothing that can be confused with the letters that remain.
// Do not "restore" any of 0, 1, i, l, o or u: each is excluded on purpose.
const SUFFIX_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz'

/** Kebab-cases a title, dropping anything that is not URL-safe. May return ''. */
export function slugifyTitle(title: string): string {
  return title
    .normalize('NFKD')
    // Combining marks (U+0300-U+036F) left behind by NFKD. Written as escapes
    // deliberately: the literal characters are invisible in an editor, and if
    // a paste or an NFC round-trip ever dropped them nothing would fail loudly
    // — 'Ménage' would just start slugifying to 'me-nage'. Slugs are
    // write-once, so such a slug could never be corrected in place afterwards.
    .replace(/[\u0300-\u036f]/g, '')
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
