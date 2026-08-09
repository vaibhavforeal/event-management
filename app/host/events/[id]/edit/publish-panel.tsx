'use client'

import { useActionState, useState } from 'react'
import type { EventFormState } from '../../actions'

type Action = (state: EventFormState, formData: FormData) => Promise<EventFormState>

export function PublishPanel({
  eventId,
  shareUrl,
  status,
  publishAction,
  unpublishAction,
}: {
  eventId: string
  /**
   * Absolute, and built on the server from NEXT_PUBLIC_SITE_URL.
   *
   * It used to be derived here from `window.location.origin`, which meant the
   * server rendered a relative "/e/slug" and hydration swapped in the absolute
   * one. React does not warn on `value` mismatches for form elements, so that
   * divergence was silent — and a host who tapped Copy before hydration pasted
   * a relative path into WhatsApp, which is a dead link. Sharing that link is
   * the single thing this panel exists to do, so the first byte has to be right.
   */
  shareUrl: string
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

  return (
    <section className="border-line space-y-3 rounded-xl border p-4">
      {isPublished ? (
        <>
          <p className="text-sm font-medium">Your link is live. Send it to your group.</p>
          <div className="flex gap-2">
            <input readOnly value={shareUrl} className="bg-raised flex-1 rounded-lg px-3 py-2 text-sm" />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(shareUrl).then(() => setCopied(true))
              }}
              className="bg-ink text-paper rounded-lg px-4 py-2 text-sm"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </>
      ) : (
        <p className="text-muted text-sm">This event is a draft. Nobody can see it yet.</p>
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
          className="border-line rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
        >
          {isPublished ? 'Unpublish' : 'Publish'}
        </button>
      </form>
    </section>
  )
}
