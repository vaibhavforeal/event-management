/**
 * All event times are entered and displayed in IST.
 *
 * An <input type="datetime-local"> yields "2026-08-15T19:30" with no zone.
 * Passing that to new Date() resolves it against the *server's* zone: correct on
 * a developer machine in India, and 5.5 hours wrong on Vercel, which runs UTC.
 * Every conversion therefore goes through here, using arithmetic on a fixed
 * offset rather than anything that can consult the ambient zone.
 *
 * India has observed no daylight saving since 1945, so a fixed offset is exact,
 * not an approximation. If the product ever leaves IST, this file is the only
 * place that assumption lives.
 */

const IST_OFFSET_MINUTES = 330 // UTC+05:30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000
// A shape check, not input validation: it counts digits but not their range, so
// "2026-13-45T99:99" matches here and rolls over rather than throwing. A real
// datetime-local input cannot emit that; a hand-crafted POST can. Validate at
// the request boundary with Zod — do not mistake this for that.
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** Reads a zoneless datetime-local string as IST and returns the UTC instant. */
export function istLocalToUtc(local: string): Date {
  const match = LOCAL_PATTERN.exec(local)
  if (!match) {
    throw new RangeError(`Expected a datetime-local value like 2026-08-15T19:30, got "${local}"`)
  }
  const [, year, month, day, hour, minute] = match
  // Date.UTC never consults the ambient timezone, which is the whole point.
  const asIfUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  return new Date(asIfUtc - IST_OFFSET_MS)
}

/** Formats a UTC instant as the IST datetime-local string an input expects. */
export function utcToIstLocal(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16)
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
})

const dateFormatter = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Kolkata',
})

/** e.g. "Sat, 15 Aug, 7:30 pm" */
export function formatIst(date: Date): string {
  return dateTimeFormatter.format(date)
}

/** e.g. "Sat, 15 Aug" */
export function formatIstDateOnly(date: Date): string {
  return dateFormatter.format(date)
}

/**
 * Whether an event's start time is behind us. Mirrors the EH013 guard in
 * `book_free_tickets`, which is the authority; this only decides whether the
 * page offers a control the database would refuse.
 *
 * A function rather than an inline `Date.now()` at the one call site, for two
 * reasons. The clock is injectable, so the boundary is testable without
 * freezing time globally — the same shape `validateForPublish` uses. And
 * `react-hooks/purity` rejects a `Date.now()` in a component body, correctly in
 * general: a re-render would silently change the answer. The public event page
 * is an async Server Component that renders once per request, so reading the
 * clock there is exactly right, but the rule cannot see the difference and this
 * is a better answer to it than a suppression comment.
 *
 * Fails closed. `new Date('nonsense').getTime()` is NaN and every comparison
 * against NaN is false, so a naive `<=` would call an unreadable start time
 * "not started" and offer a Book button for it. `starts_at` is a NOT NULL
 * timestamptz today, so this is unreachable — but the parameter is a plain
 * string, and the safe direction is a missing button rather than a booking
 * against an event whose date nobody can read.
 */
export function hasStarted(startsAt: string, now: Date = new Date()): boolean {
  const time = new Date(startsAt).getTime()
  return Number.isNaN(time) || time <= now.getTime()
}
