import { requireUser } from '@/lib/auth/session'
import { getCurrentHost } from '@/lib/events/queries'
import { createEvent } from '../actions'
import { EventForm } from '../event-form'

export const metadata = { title: 'New event' }

export default async function NewEventPage() {
  await requireUser()

  // A returning host already has a name, and the field is `required` — so
  // without this they would be made to retype it, and any variation they typed
  // would silently rename them on every event they have already published.
  // Null for a first-time host, which leaves the field empty and asks for one.
  const host = await getCurrentHost()

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Create an event</h1>
      <EventForm
        action={createEvent}
        submitLabel="Save draft"
        values={{ hostDisplayName: host?.display_name }}
      />
    </main>
  )
}
