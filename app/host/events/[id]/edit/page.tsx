import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { getOwnedEvent } from '@/lib/events/queries'
import { utcToIstLocal } from '@/lib/events/datetime'
import { publishEvent, unpublishEvent, updateEvent } from '../../actions'
import { EventForm } from '../../event-form'
import { PublishPanel } from './publish-panel'

export const metadata = { title: 'Edit event' }

export default async function EditEventPage(props: PageProps<'/host/events/[id]/edit'>) {
  await requireUser()
  const { id } = await props.params

  const event = await getOwnedEvent(id)
  if (!event) notFound()

  const ticket = event.ticket_types[0]

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">{event.title}</h1>
        <p className="text-sm text-zinc-500">
          {event.status === 'published' ? 'Published' : 'Draft'}
          {' · '}
          <Link href={`/e/${event.slug}`} className="underline">/e/{event.slug}</Link>
        </p>
      </div>

      <PublishPanel
        eventId={event.id}
        slug={event.slug}
        status={event.status}
        publishAction={publishEvent}
        unpublishAction={unpublishEvent}
      />

      <EventForm
        action={updateEvent}
        submitLabel="Save changes"
        values={{
          eventId: event.id,
          title: event.title,
          description: event.description,
          city: event.city,
          venueName: event.venue_name,
          venueAddress: event.venue_address,
          coverImageUrl: event.cover_image_url,
          startsAtLocal: utcToIstLocal(new Date(event.starts_at)),
          endsAtLocal: event.ends_at ? utcToIstLocal(new Date(event.ends_at)) : undefined,
          seats: ticket?.quantity,
          priceRupees: ticket ? ticket.price_paise / 100 : 0,
          requiresApproval: event.requires_approval,
          allowsCash: event.allows_cash,
          hideVenueUntilApproved: event.hide_venue_until_approved,
        }}
      />
    </main>
  )
}
