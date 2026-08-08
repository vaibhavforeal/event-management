'use client'

import { useActionState } from 'react'
import { CoverUpload } from './cover-upload'
import type { EventFormState } from './actions'

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
  requiresApproval?: boolean
  allowsCash?: boolean
  hideVenueUntilApproved?: boolean
}

const field = 'w-full rounded-lg border border-zinc-300 px-3 py-2 text-base'

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

  return (
    <form action={formAction} className="space-y-5">
      {values.eventId && <input type="hidden" name="eventId" value={values.eventId} />}

      <div>
        <label htmlFor="title" className="block text-sm font-medium">What is it called?</label>
        <input id="title" name="title" defaultValue={values.title} required className={field} />
        {state.fieldErrors?.title && <p className="text-sm text-red-600">{state.fieldErrors.title}</p>}
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium">Description</label>
        <textarea id="description" name="description" rows={5} defaultValue={values.description ?? ''} className={field} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="city" className="block text-sm font-medium">City</label>
          <input id="city" name="city" defaultValue={values.city} required className={field} />
          {state.fieldErrors?.city && <p className="text-sm text-red-600">{state.fieldErrors.city}</p>}
        </div>
        <div>
          <label htmlFor="venueName" className="block text-sm font-medium">Venue</label>
          <input id="venueName" name="venueName" defaultValue={values.venueName ?? ''} className={field} />
        </div>
      </div>

      <div>
        <label htmlFor="venueAddress" className="block text-sm font-medium">Address</label>
        <input id="venueAddress" name="venueAddress" defaultValue={values.venueAddress ?? ''} className={field} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="startsAtLocal" className="block text-sm font-medium">Starts (IST)</label>
          <input
            id="startsAtLocal"
            name="startsAtLocal"
            type="datetime-local"
            defaultValue={values.startsAtLocal}
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
            defaultValue={values.endsAtLocal}
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
          <input id="seats" name="seats" type="number" min={1} defaultValue={values.seats ?? 20} required className={field} />
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
            defaultValue={values.priceRupees ?? 0}
            required
            className={field}
          />
          {state.fieldErrors?.priceRupees && <p className="text-sm text-red-600">{state.fieldErrors.priceRupees}</p>}
        </div>
      </div>

      <CoverUpload initialUrl={values.coverImageUrl} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Options</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresApproval" defaultChecked={values.requiresApproval} />
          I approve each guest before they pay
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="allowsCash" defaultChecked={values.allowsCash} />
          Allow paying cash at the door
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="hideVenueUntilApproved" defaultChecked={values.hideVenueUntilApproved} />
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
        className="w-full rounded-lg bg-black px-4 py-3 text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : submitLabel}
      </button>
    </form>
  )
}
