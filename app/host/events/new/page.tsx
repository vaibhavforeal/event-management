import { requireUser } from '@/lib/auth/session'
import { createEvent } from '../actions'
import { EventForm } from '../event-form'

export const metadata = { title: 'New event' }

export default async function NewEventPage() {
  await requireUser()

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Create an event</h1>
      <EventForm action={createEvent} submitLabel="Save draft" />
    </main>
  )
}
