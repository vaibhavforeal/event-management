import { z } from 'zod'

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

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick a date and time')

const optionalText = (max: number) => z.string().trim().max(max).optional()

export const eventDraftSchema = z
  .object({
    // 3..140 mirrors the CHECK on events.title. Failing here gives the host a
    // sentence; failing in Postgres gives them a constraint name.
    title: z
      .string()
      .trim()
      .min(3, 'Give your event a name of at least 3 characters')
      .max(140, 'Keep the name under 140 characters'),
    city: z.string().trim().min(1, 'Which city is this in?').max(80),
    startsAtLocal: localDateTime,
    endsAtLocal: localDateTime.optional(),
    description: optionalText(5000),
    venueName: optionalText(160),
    venueAddress: optionalText(500),
    coverImageUrl: z.url('That does not look like an image link').optional(),
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
  ticketTypes: Array<{ quantity: number }>
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
  if (!candidate.ticketTypes.some((t) => t.quantity > 0)) {
    blockers.push({ field: 'seats', message: 'Add at least one seat' })
  }

  return blockers
}
