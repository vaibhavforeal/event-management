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
