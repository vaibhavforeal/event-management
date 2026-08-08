import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { clientEnv } from '@/lib/env'
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

  // Built here rather than in the client component so the absolute URL is in the
  // very first byte of HTML. NEXT_PUBLIC_SITE_URL is the canonical origin the
  // rest of the app uses, so the copied link matches the og:url Task 9 emits.
  // `new URL` rather than string concatenation so a configured trailing slash
  // cannot produce "//e/slug".
  const shareUrl = new URL(`/e/${event.slug}`, clientEnv.NEXT_PUBLIC_SITE_URL).toString()

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 px-4 py-8">
      <div>
        {/* break-words on both, because these are the two host-entered strings
            on this page and neither is guaranteed to contain a space. A title
            may be 140 characters (the schema CHECK allows it) and the slug is
            derived from it, so a one-word title yields a ~67-character unbroken
            slug. This is the load-bearing half of the fix: measured at 390px,
            removing just these two classes takes the page from 0 back to 1489px
            of horizontal overflow. Sizing main correctly cannot make an
            unbreakable word wrap. */}
        <h1 className="text-2xl font-semibold break-words">{event.title}</h1>
        <p className="text-sm break-words text-zinc-500">
          {event.status === 'published' ? 'Published' : 'Draft'}
          {' · '}
          <Link href={`/e/${event.slug}`} className="underline">/e/{event.slug}</Link>
        </p>
      </div>

      {/* Keyed on updated_at so a successful save remounts the panel with clean
          state. Without this its useActionState is independent of the form's, so
          a stale "Add where it is happening" blocker sat next to "Saved." — two
          contradictory messages, and the host acts on the wrong one. */}
      <PublishPanel
        key={event.updated_at}
        eventId={event.id}
        shareUrl={shareUrl}
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
          hostDisplayName: event.hosts?.display_name,
          requiresApproval: event.requires_approval,
          allowsCash: event.allows_cash,
          hideVenueUntilApproved: event.hide_venue_until_approved,
        }}
      />
    </main>
  )
}
