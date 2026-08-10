import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth/session'
import { getOwnedEvent } from '@/lib/events/queries'
import { deriveEventKeyHex } from '@/lib/tickets/signing'
import { serverEnv } from '@/lib/env'
import { Scanner } from './scanner'

export const metadata = { title: 'Scan tickets' }

export default async function ScanPage(props: PageProps<'/host/events/[id]/scan'>) {
  const { id } = await props.params
  await requireUser()

  // Ownership check, same as the guest list: a host who does not own this
  // event gets a 404, not a scanner.
  const event = await getOwnedEvent(id)
  if (!event) notFound()

  // The per-event key, derived on the server and handed to this host's
  // browser for this door only. That containment is the threat model in
  // lib/tickets/signing.ts: a compromised device at one door cannot forge
  // tickets for another event.
  const eventKeyHex = await deriveEventKeyHex(serverEnv().TICKET_SIGNING_SECRET, id)

  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl px-5 py-10">
      <Link href={`/host/events/${id}/attendees`} className="font-mono text-[13px] underline">
        ← Guest list
      </Link>
      <h1 className="mt-4 text-2xl font-semibold break-words">Scan tickets — {event.title}</h1>
      <Scanner eventId={id} eventKeyHex={eventKeyHex} />
    </main>
  )
}
