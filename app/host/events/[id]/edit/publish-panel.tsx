'use client'

import { useActionState, useState } from 'react'
import type { EventFormState } from '../../actions'

type Action = (state: EventFormState, formData: FormData) => Promise<EventFormState>

export function PublishPanel({
  eventId,
  slug,
  status,
  publishAction,
  unpublishAction,
}: {
  eventId: string
  slug: string
  status: string
  publishAction: Action
  unpublishAction: Action
}) {
  const isPublished = status === 'published'
  const [state, formAction, pending] = useActionState(
    isPublished ? unpublishAction : publishAction,
    {} as EventFormState,
  )
  const [copied, setCopied] = useState(false)

  const shareUrl =
    typeof window === 'undefined' ? `/e/${slug}` : `${window.location.origin}/e/${slug}`

  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 p-4">
      {isPublished ? (
        <>
          <p className="text-sm font-medium">Your link is live. Send it to your group.</p>
          <div className="flex gap-2">
            <input readOnly value={shareUrl} className="flex-1 rounded-lg bg-zinc-100 px-3 py-2 text-sm" />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(shareUrl).then(() => setCopied(true))
              }}
              className="rounded-lg bg-black px-4 py-2 text-sm text-white"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-zinc-600">This event is a draft. Nobody can see it yet.</p>
      )}

      {state.blockers && state.blockers.length > 0 && (
        <ul className="list-inside list-disc rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {state.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}

      <form action={formAction}>
        <input type="hidden" name="eventId" value={eventId} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm disabled:opacity-50"
        >
          {isPublished ? 'Unpublish' : 'Publish'}
        </button>
      </form>
    </section>
  )
}
