'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/** Matches the `accept` list below, and used when the filename is no help. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * A storage-safe extension for the object key.
 *
 * Taking everything after the last dot trusts the filename too much: "shot.a?v=2"
 * yields "a?v=2", which Storage accepts as a key and RLS allows, but getPublicUrl
 * does not escape — so the object uploads fine and its public link is broken for
 * good. A short alphanumeric whitelist is the cheapest way to be sure, and the
 * declared MIME type is a real fallback rather than a guess. (The old `?? 'jpg'`
 * never ran: String.split always returns at least one element.)
 */
function safeExtension(file: File): string {
  const lastDot = file.name.lastIndexOf('.')
  const fromName = lastDot === -1 ? '' : file.name.slice(lastDot + 1).toLowerCase()
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName
  return EXTENSION_BY_TYPE[file.type] ?? 'jpg'
}

/**
 * Uploads straight from the browser to Supabase Storage, then writes the public
 * URL into a hidden input the form submits.
 *
 * Going direct rather than through the Server Action avoids the body size limit
 * on actions, and the path is keyed by the user's own uid so this works before
 * the event row exists.
 */
export function CoverUpload({ initialUrl }: { initialUrl?: string | null }) {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    setBusy(true)
    setError(null)

    const supabase = createClient()
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) {
      setError('Your session expired. Sign in again.')
      setBusy(false)
      return
    }

    const path = `${auth.user.id}/${crypto.randomUUID()}.${safeExtension(file)}`

    const { error: uploadError } = await supabase.storage
      .from('event-covers')
      .upload(path, file, { contentType: file.type, upsert: false })

    if (uploadError) {
      setError(uploadError.message)
      setBusy(false)
      return
    }

    const { data } = supabase.storage.from('event-covers').getPublicUrl(path)
    setUrl(data.publicUrl)
    setBusy(false)
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">Cover image</label>

      {url ? (
        // Plain <img>: the URL is user-supplied at runtime, and next/image adds
        // nothing for a preview the host looks at once.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="Event cover preview" className="h-40 w-full rounded-lg object-cover" />
      ) : (
        <div className="border-line text-muted flex h-40 w-full items-center justify-center rounded-lg border border-dashed text-sm">
          No cover yet
        </div>
      )}

      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void upload(file)
        }}
        className="block w-full text-sm"
      />

      <input type="hidden" name="coverImageUrl" value={url} />

      {busy && <p className="text-muted text-sm">Uploading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
