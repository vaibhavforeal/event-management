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

// Exactly what buildSlug emits and nothing else: runs of [a-z0-9] joined by
// single hyphens, no hyphen at either end. Written as an allowlist rather than
// as a check for './' and '%' because the danger is the character nobody
// thought of, and slugifyTitle has already decided which characters exist.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// The longest buildSlug can return: a title slice, the separator, the suffix.
// Derived rather than written as 67 so it cannot drift if either constant moves.
const MAX_SLUG_CHARS = MAX_TITLE_CHARS + 1 + SUFFIX_LENGTH

/**
 * Whether a string is shaped like a slug this app wrote.
 *
 * For values that arrive from outside and get interpolated into a path — the
 * hidden `slug` input on both cancel forms, which reaches `/e/${slug}` in a
 * revalidatePath call. A form field is whatever the request says it is, and
 * `../../host/events` is a perfectly truthy string, so a falsiness check let one
 * name any path in the app.
 *
 * Deliberately NOT an existence check and not an authorisation check. A slug
 * naming somebody else's real event passes this and should: it costs one wasted
 * cache drop, while what may actually be cancelled is settled by
 * lib/bookings/service.ts against the caller. This answers only "may this string
 * be pasted into a path", which is the one question the interpolation asks.
 */
export function isEventSlug(value: string): boolean {
  return value.length <= MAX_SLUG_CHARS && SLUG_PATTERN.test(value)
}
