'use client'

import { useActionState, useState } from 'react'
import { CoverUpload } from './cover-upload'
import type { EventFormState } from './actions'
// Type-only, so nothing from the validation module (Zod included) is pulled
// into the client bundle. The echo's shape is declared there because that is
// where the form's field list lives.
import type { SubmittedEventValues } from '@/lib/events/validation'

type Action = (state: EventFormState, formData: FormData) => Promise<EventFormState>

export interface EventFormValues {
  eventId?: string
  title?: string
  description?: string | null
  city?: string
  venueName?: string | null
  venueAddress?: string | null
  coverImageUrl?: string | null
  startsAtLocal?: string
  endsAtLocal?: string
  seats?: number
  priceRupees?: number
  refundCutoffHours?: number
  /** The host's own name, from `hosts.display_name`. */
  hostDisplayName?: string | null
  requiresApproval?: boolean
  allowsCash?: boolean
  hasWaitlist?: boolean
  hideVenueUntilApproved?: boolean
}

/**
 * What the inputs are bound to.
 *
 * Seats and price are strings here even though they are numbers everywhere
 * else: a half-typed or momentarily cleared number field has no numeric value,
 * and coercing on every keystroke would fight the host as they type. Zod does
 * the conversion on the server, which is where the authoritative check lives.
 */
interface Draft {
  title: string
  description: string
  city: string
  venueName: string
  venueAddress: string
  startsAtLocal: string
  endsAtLocal: string
  seats: string
  priceRupees: string
  refundCutoffHours: string
  hostDisplayName: string
}

/**
 * The checkboxes are deliberately NOT in Draft — they are uncontrolled. See the
 * comment on `checkboxes` in the component for why controlling them does not
 * survive React's post-action form reset.
 */
interface CheckboxState {
  requiresApproval: boolean
  allowsCash: boolean
  hasWaitlist: boolean
  hideVenueUntilApproved: boolean
}

function draftFromValues(values: EventFormValues): Draft {
  return {
    title: values.title ?? '',
    description: values.description ?? '',
    city: values.city ?? '',
    venueName: values.venueName ?? '',
    venueAddress: values.venueAddress ?? '',
    startsAtLocal: values.startsAtLocal ?? '',
    endsAtLocal: values.endsAtLocal ?? '',
    seats: String(values.seats ?? 20),
    priceRupees: String(values.priceRupees ?? 0),
    refundCutoffHours: String(values.refundCutoffHours ?? 24),
    hostDisplayName: values.hostDisplayName ?? '',
  }
}

/** The echo already arrives as raw strings, so it maps across unchanged. */
function draftFromEcho(echo: SubmittedEventValues): Draft {
  return {
    title: echo.title,
    description: echo.description,
    city: echo.city,
    venueName: echo.venueName,
    venueAddress: echo.venueAddress,
    startsAtLocal: echo.startsAtLocal,
    endsAtLocal: echo.endsAtLocal,
    seats: echo.seats,
    priceRupees: echo.priceRupees,
    refundCutoffHours: echo.refundCutoffHours,
    hostDisplayName: echo.hostDisplayName,
  }
}

const field = 'border-line w-full rounded-lg border px-3 py-2 text-base'

/**
 * The two queue toggles, together, because they are exclusive: an approval
 * event's request queue already keeps unlimited demand, so a waitlist beside
 * it would put two lists on one attendees page. events_one_queue refuses the
 * combination in the database and the writers coerce it; this is where the
 * host simply never meets it.
 *
 * A component rather than a `useState` in the form body, because the
 * checkboxes here are uncontrolled on purpose (see the essay on `checkboxes`
 * below) and the visibility state has to reset exactly when they do. Giving
 * this one `key={generation}` remounts the state and the two inputs together;
 * a bare state in the parent would survive the remount and leave the waitlist
 * row hidden after an echo that unticked approval.
 *
 * Unmounting the waitlist input rather than disabling it is the point: an
 * absent checkbox is absent from FormData, which readSubmittedValues reads as
 * false — so ticking approval turns the waitlist off through the same path the
 * SQL coerces, and the two cannot disagree.
 */
function QueueOptions({
  defaultRequiresApproval,
  defaultHasWaitlist,
}: {
  defaultRequiresApproval: boolean
  defaultHasWaitlist: boolean
}) {
  const [approvalOn, setApprovalOn] = useState(defaultRequiresApproval)

  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="requiresApproval"
          defaultChecked={defaultRequiresApproval}
          onChange={(event) => setApprovalOn(event.currentTarget.checked)}
        />
        I approve each guest before they pay
      </label>
      {!approvalOn && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="hasWaitlist" defaultChecked={defaultHasWaitlist} />
          Keep a waitlist when it sells out
        </label>
      )}
    </>
  )
}

export function EventForm({
  action,
  values = {},
  submitLabel,
}: {
  action: Action
  values?: EventFormValues
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as EventFormState)
  const [draft, setDraft] = useState(() => draftFromValues(values))

  /**
   * Every field below is controlled, and that is what actually stops a rejected
   * save from emptying the form.
   *
   * React 19 resets the form once the action settles, and `defaultValue` is read
   * only when an input mounts — so an uncontrolled field came back blank, and
   * re-rendering it with a fresh `defaultValue` did nothing at all. Controlled
   * inputs are immune because their value is supplied on every render. The cover
   * URL was the one field that already survived, for exactly this reason.
   *
   * Remounting the fields under a per-submission key would also work, but it
   * would take CoverUpload's uploaded-image state and the caret position down
   * with it, so controlling them is both cheaper and less disruptive.
   */
  const [lastEcho, setLastEcho] = useState<SubmittedEventValues | undefined>(undefined)
  // `generation` exists only to remount the checkboxes; see below.
  const [generation, setGeneration] = useState(0)
  // Which response has already been folded in, tracked by identity. Seeded with
  // the first `state` so mounting does no work. Comparing during render is
  // React's documented way to adjust state in response to a change; an effect
  // would paint the stale values first.
  const [handled, setHandled] = useState(state)

  if (state !== handled) {
    setHandled(state)
    if (state.values) {
      // Rejected: adopt what the host sent so nothing they typed is lost.
      setLastEcho(state.values)
      setDraft(draftFromEcho(state.values))
      setGeneration((n) => n + 1)
    } else if (state.ok) {
      /**
       * Saved: the echo is now obsolete and must go, or it pins `defaultChecked`
       * to the last *rejected* submission forever.
       *
       * Keeping it caused a genuinely dangerous bug. Submit while "hide venue
       * until approved" is ticked and get rejected; untick it; save; the save
       * succeeds and Postgres correctly stores false — and then the box springs
       * back to ticked from the stale echo, so the next save writes true again.
       * A host is told their address is public, watches the setting turn itself
       * back on, and silently re-hides it. That control decides whether a guest
       * ever sees the address, so being wrong in either direction is unsafe.
       *
       * Dropping the echo returns the checkboxes to the server-supplied props,
       * which the action's revalidation has already refreshed by this point.
       */
      setLastEcho(undefined)
      setGeneration((n) => n + 1)
    }
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  /**
   * Checkboxes are uncontrolled, unlike every other field here, and that
   * inconsistency is load-bearing.
   *
   * React's post-action reset restores each control from its DOM *attributes*.
   * For a text input React keeps the `value` attribute in step with the `value`
   * prop, so a controlled one is restored to the value it already had and
   * nothing appears to happen. A checkbox's `checked` attribute comes only from
   * `defaultChecked`, and React never sets it for a controlled box — so the
   * reset finds no attribute and clears the box, and since React's own state
   * still says "true" there is no re-render to put it back. Verified in a
   * browser: with all thirteen fields controlled, the text survived a rejected
   * save and all three checkboxes silently reverted.
   *
   * So drive them from `defaultChecked` and let the reset restore the echoed
   * value, which is the behaviour we want anyway. The key forces a remount when
   * a new response lands, so the fresh default is definitely applied whichever
   * side of the reset the render falls on — the correctness does not depend on
   * that ordering. Remounting costs nothing here: these inputs hold no other
   * state, and after a submit the focus is on the submit button, not on them.
   * CoverUpload is deliberately outside this, so its uploaded image is untouched.
   *
   * Keying the whole form on the event's `updated_at` — as PublishPanel does —
   * would also clear the echo, and would make the two components consistent. It
   * is not used here because remounting EventForm also remounts its
   * `useActionState`, which throws away `state.ok`: the "Saved." confirmation
   * would appear and then vanish the moment the refreshed row arrived.
   * PublishPanel can afford that because it signals success through the `status`
   * prop rather than a message.
   */
  const checkboxes: CheckboxState = lastEcho
    ? {
        requiresApproval: lastEcho.requiresApproval,
        allowsCash: lastEcho.allowsCash,
        hasWaitlist: lastEcho.hasWaitlist,
        hideVenueUntilApproved: lastEcho.hideVenueUntilApproved,
      }
    : {
        requiresApproval: values.requiresApproval ?? false,
        allowsCash: values.allowsCash ?? false,
        hasWaitlist: values.hasWaitlist ?? false,
        hideVenueUntilApproved: values.hideVenueUntilApproved ?? false,
      }

  return (
    <form action={formAction} className="space-y-5">
      {values.eventId && <input type="hidden" name="eventId" value={values.eventId} />}

      <div>
        <label htmlFor="title" className="block text-sm font-medium">What is it called?</label>
        <input
          id="title"
          name="title"
          value={draft.title}
          onChange={(event) => set('title', event.target.value)}
          maxLength={140}
          required
          className={field}
        />
        {state.fieldErrors?.title && <p className="text-sm text-red-600">{state.fieldErrors.title}</p>}
      </div>

      {/* Second field on the form, not tucked away in a settings screen that
          does not exist. `hosts.display_name` is printed under "Host" on the
          public page, and until this input existed it was filled in from
          `profiles.phone` — so every host published their WhatsApp number to
          the group chat they forwarded the link into. The helper line says out
          loud both that guests see this and that it is not per-event, because
          changing it here changes it on every event the host has. */}
      <div>
        <label htmlFor="hostDisplayName" className="block text-sm font-medium">
          Your name
        </label>
        <input
          id="hostDisplayName"
          name="hostDisplayName"
          value={draft.hostDisplayName}
          onChange={(event) => set('hostDisplayName', event.target.value)}
          maxLength={80}
          required
          autoComplete="name"
          placeholder="Priya from Indore"
          className={field}
        />
        <p className="text-muted text-sm">
          Guests see this under “Host”, on all of your events.
        </p>
        {state.fieldErrors?.hostDisplayName && (
          <p className="text-sm text-red-600">{state.fieldErrors.hostDisplayName}</p>
        )}
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium">Description</label>
        <textarea
          id="description"
          name="description"
          rows={5}
          value={draft.description}
          onChange={(event) => set('description', event.target.value)}
          maxLength={5000}
          className={field}
        />
        {state.fieldErrors?.description && (
          <p className="text-sm text-red-600">{state.fieldErrors.description}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="city" className="block text-sm font-medium">City</label>
          <input
            id="city"
            name="city"
            value={draft.city}
            onChange={(event) => set('city', event.target.value)}
            maxLength={80}
            required
            className={field}
          />
          {state.fieldErrors?.city && <p className="text-sm text-red-600">{state.fieldErrors.city}</p>}
        </div>
        <div>
          <label htmlFor="venueName" className="block text-sm font-medium">Venue</label>
          <input
            id="venueName"
            name="venueName"
            value={draft.venueName}
            onChange={(event) => set('venueName', event.target.value)}
            maxLength={160}
            className={field}
          />
          {state.fieldErrors?.venueName && (
            <p className="text-sm text-red-600">{state.fieldErrors.venueName}</p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="venueAddress" className="block text-sm font-medium">Address</label>
        <input
          id="venueAddress"
          name="venueAddress"
          value={draft.venueAddress}
          onChange={(event) => set('venueAddress', event.target.value)}
          maxLength={500}
          className={field}
        />
        {state.fieldErrors?.venueAddress && (
          <p className="text-sm text-red-600">{state.fieldErrors.venueAddress}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="startsAtLocal" className="block text-sm font-medium">Starts (IST)</label>
          <input
            id="startsAtLocal"
            name="startsAtLocal"
            type="datetime-local"
            value={draft.startsAtLocal}
            onChange={(event) => set('startsAtLocal', event.target.value)}
            required
            className={field}
          />
          {state.fieldErrors?.startsAtLocal && (
            <p className="text-sm text-red-600">{state.fieldErrors.startsAtLocal}</p>
          )}
        </div>
        <div>
          <label htmlFor="endsAtLocal" className="block text-sm font-medium">Ends (optional)</label>
          <input
            id="endsAtLocal"
            name="endsAtLocal"
            type="datetime-local"
            value={draft.endsAtLocal}
            onChange={(event) => set('endsAtLocal', event.target.value)}
            className={field}
          />
          {state.fieldErrors?.endsAtLocal && (
            <p className="text-sm text-red-600">{state.fieldErrors.endsAtLocal}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="seats" className="block text-sm font-medium">Seats</label>
          <input
            id="seats"
            name="seats"
            type="number"
            min={1}
            value={draft.seats}
            onChange={(event) => set('seats', event.target.value)}
            required
            className={field}
          />
          {state.fieldErrors?.seats && <p className="text-sm text-red-600">{state.fieldErrors.seats}</p>}
        </div>
        <div>
          <label htmlFor="priceRupees" className="block text-sm font-medium">Price per seat (₹)</label>
          <input
            id="priceRupees"
            name="priceRupees"
            type="number"
            min={0}
            step="0.01"
            value={draft.priceRupees}
            onChange={(event) => set('priceRupees', event.target.value)}
            required
            className={field}
          />
          {state.fieldErrors?.priceRupees && <p className="text-sm text-red-600">{state.fieldErrors.priceRupees}</p>}
        </div>
      </div>

      <div>
        <label htmlFor="refundCutoffHours" className="block text-sm font-medium">
          Refund cutoff (hours before start)
        </label>
        <input
          id="refundCutoffHours"
          name="refundCutoffHours"
          type="number"
          min={0}
          max={720}
          value={draft.refundCutoffHours}
          onChange={(event) => set('refundCutoffHours', event.target.value)}
          required
          className={field}
        />
        <p className="text-muted mt-1 text-xs">
          Guests who cancel earlier than this get a full refund. 0 means refundable until start.
        </p>
        {state.fieldErrors?.refundCutoffHours && (
          <p className="text-sm text-red-600">{state.fieldErrors.refundCutoffHours}</p>
        )}
      </div>

      <CoverUpload initialUrl={values.coverImageUrl} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Options</legend>
        <QueueOptions
          key={generation}
          defaultRequiresApproval={checkboxes.requiresApproval}
          defaultHasWaitlist={checkboxes.hasWaitlist}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            key={`allowsCash-${generation}`}
            type="checkbox"
            name="allowsCash"
            defaultChecked={checkboxes.allowsCash}
          />
          Allow paying cash at the door
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            key={`hideVenueUntilApproved-${generation}`}
            type="checkbox"
            name="hideVenueUntilApproved"
            defaultChecked={checkboxes.hideVenueUntilApproved}
          />
          Hide the exact address until I approve a guest
        </label>
      </fieldset>

      {/* updateEvent returns blockers when a seat change is refused, e.g. cutting
          capacity below what is already reserved. Without this the host sees a
          form that simply does nothing. */}
      {state.blockers && state.blockers.length > 0 && (
        <ul className="list-inside list-disc rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {state.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      {state.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
      {state.ok && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-700">Saved.</p>}

      <button
        type="submit"
        disabled={pending}
        className="bg-ink text-paper w-full rounded-lg px-4 py-3 disabled:opacity-50"
      >
        {pending ? 'Saving…' : submitLabel}
      </button>
    </form>
  )
}
