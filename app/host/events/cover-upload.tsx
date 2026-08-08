'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

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

    const extension = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    const path = `${auth.user.id}/${crypto.randomUUID()}.${extension}`

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
        <div className="flex h-40 w-full items-center justify-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500">
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

      {busy && <p className="text-sm text-zinc-500">Uploading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
