import { z } from 'zod'
import { istLocalToUtc, utcToIstLocal } from './datetime'

/**
 * Two different bars, deliberately.
 *
 * `eventDraftSchema` asks for exactly what Postgres declares NOT NULL — title,
 * city, start time — plus the seats and price that become the single implicit
 * ticket type. Anything else is optional, so a half-filled form is never lost.
 *
 * `validateForPublish` is the stricter gate: it is what makes an event fit to
 * show a stranger who arrived from a WhatsApp link.
 */

/**
 * True only if the string names a calendar instant that actually exists.
 *
 * The regex below counts digits but not their range, so "2026-13-45T99:99"
 * matches it and `istLocalToUtc` then rolls it forward to 2027-02-17 rather
 * than complaining — fifteen months from where the host meant. A real
 * datetime-local input cannot emit that, but a hand-crafted POST can, and
 * lib/events/datetime.ts says in terms that the range check belongs here at
 * the request boundary.
 *
 * The round trip is the whole test: anything that rolls over comes back as a
 * different string. That catches out-of-range fields and dates that do not
 * exist (31 February) in one stroke, with no month-length table to maintain.
 *
 * Defensive rather than trusting the regex ran first: Zod 4 keeps running
 * checks after one fails, so this can be handed a malformed string, and
 * `istLocalToUtc` throws on those. A validator must return false, never throw.
 */
function isRealLocalDateTime(value: string): boolean {
  try {
    return utcToIstLocal(istLocalToUtc(value)) === value
  } catch {
    return false
  }
}

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick a date and time')
  .refine(isRealLocalDateTime, 'That date and time does not exist')

/**
 * The message is required, not optional, on purpose: without one Zod says
 * "Too big: expected string to have <=5000 characters", which is exactly the
 * machine string this module exists to keep away from the host. Making it a
 * parameter means a new optional field cannot be added without writing one.
 */
const optionalText = (max: number, tooLong: string) =>
  z.string().trim().max(max, tooLong).optional()

export const eventDraftSchema = z
  .object({
    // 3..140 mirrors the CHECK on events.title. Failing here gives the host a
    // sentence; failing in Postgres gives them a constraint name.
    title: z
      .string()
      .trim()
      .min(3, 'Give your event a name of at least 3 characters')
      .max(140, 'Keep the name under 140 characters'),
    city: z
      .string()
      .trim()
      .min(1, 'Which city is this in?')
      .max(80, 'Keep the city name under 80 characters'),
    startsAtLocal: localDateTime,
    endsAtLocal: localDateTime.optional(),
    description: optionalText(5000, 'Keep the description under 5000 characters'),
    venueName: optionalText(160, 'Keep the venue name under 160 characters'),
    venueAddress: optionalText(500, 'Keep the address under 500 characters'),
    // Scheme-restricted, not merely well-formed: a bare z.url() accepts
    // "javascript:alert(1)" and this value lands in an <img src> today and an
    // og:image tag in Task 9. /^https?$/ is what Zod matches its own
    // `httpProtocol` against, after stripping the trailing colon.
    coverImageUrl: z
      .url({ protocol: /^https?$/, error: 'That does not look like an image link' })
      .optional(),
    // The bare string is the type-level message, used when coercion yields NaN
    // — i.e. the host typed something that is not a number at all. Without it
    // Zod says "expected number, received NaN", which is the machine string
    // this module exists to avoid. Per-rule messages below still win for their
    // own rule; this is only the fallback.
    seats: z.coerce
      .number('Seats must be a whole number')
      .int('Seats must be a whole number')
      .positive('You need at least one seat')
      .max(100_000, 'That is more seats than this platform is for'),
    priceRupees: z.coerce
      .number('Price must be a number')
      .min(0, 'Price cannot be negative')
      .max(1_000_000, 'That price looks like a mistake'),
    requiresApproval: z.boolean(),
    allowsCash: z.boolean(),
    hideVenueUntilApproved: z.boolean(),
  })
  .refine((v) => !v.endsAtLocal || v.endsAtLocal > v.startsAtLocal, {
    // Lexicographic comparison is correct here: both are fixed-width
    // YYYY-MM-DDTHH:mm strings in the same zone.
    message: 'The end time must be after the start time',
    path: ['endsAtLocal'],
  })

export type EventDraftInput = z.infer<typeof eventDraftSchema>

export type ParseResult =
  | { success: true; data: EventDraftInput }
  | { success: false; fieldErrors: Record<string, string> }

function text(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** An unchecked checkbox is absent from FormData entirely. */
function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) !== null
}

export function parseEventForm(formData: FormData): ParseResult {
  const parsed = eventDraftSchema.safeParse({
    title: text(formData.get('title')) ?? '',
    city: text(formData.get('city')) ?? '',
    startsAtLocal: text(formData.get('startsAtLocal')) ?? '',
    endsAtLocal: text(formData.get('endsAtLocal')),
    description: text(formData.get('description')),
    venueName: text(formData.get('venueName')),
    venueAddress: text(formData.get('venueAddress')),
    coverImageUrl: text(formData.get('coverImageUrl')),
    seats: text(formData.get('seats')) ?? '',
    priceRupees: text(formData.get('priceRupees')) ?? '0',
    requiresApproval: checkbox(formData, 'requiresApproval'),
    allowsCash: checkbox(formData, 'allowsCash'),
    hideVenueUntilApproved: checkbox(formData, 'hideVenueUntilApproved'),
  })

  if (parsed.success) return { success: true, data: parsed.data }

  const fieldErrors: Record<string, string> = {}
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? 'form')
    fieldErrors[key] ??= issue.message // first message per field wins
  }
  return { success: false, fieldErrors }
}

export interface PublishCandidate {
  title: string | null
  city: string | null
  venue_name: string | null
  starts_at: string
  // Nullable on purpose. A join that matched no rows hands back null, and this
  // function is pure and exported, so the type should say what it tolerates
  // rather than leave the next caller to discover a TypeError.
  ticketTypes: Array<{ quantity: number }> | null
}

export interface PublishBlocker {
  field: string
  message: string
}

/**
 * Everything standing between a draft and a public link, returned all at once.
 */
export function validateForPublish(
  candidate: PublishCandidate,
  now: Date = new Date(),
): PublishBlocker[] {
  const blockers: PublishBlocker[] = []

  if (!candidate.title || candidate.title.trim().length < 3) {
    blockers.push({ field: 'title', message: 'Give your event a name' })
  }
  if (!candidate.city || candidate.city.trim() === '') {
    blockers.push({ field: 'city', message: 'Add the city' })
  }
  if (!candidate.venue_name || candidate.venue_name.trim() === '') {
    blockers.push({ field: 'venue_name', message: 'Add where it is happening' })
  }
  // Fail closed. `new Date('nonsense').getTime()` is NaN, and every comparison
  // against NaN is false — so without this branch an unreadable start time
  // would sail through the one gate whose job is to stop an unfit event going
  // public. Today's caller reads a NOT NULL timestamptz, but the parameter is
  // a plain string and this function is pure and reusable.
  const startsAt = new Date(candidate.starts_at).getTime()
  if (Number.isNaN(startsAt)) {
    blockers.push({ field: 'starts_at', message: 'Pick a date and time' })
  } else if (startsAt <= now.getTime()) {
    blockers.push({ field: 'starts_at', message: 'The start time is in the past' })
  }
  // `> 0`, not `>= 0`: a ticket type holding zero seats is not sellable
  // capacity. `?.` so a missing list blocks exactly like an empty one.
  if (!candidate.ticketTypes?.some((t) => t.quantity > 0)) {
    blockers.push({ field: 'seats', message: 'Add at least one seat' })
  }

  return blockers
}
