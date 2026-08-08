import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, anonClient, createTestUser, userClient } from '@/tests/helpers/db'

/**
 * The cover bucket is world-readable by exact URL, so the folder-name checks in
 * the policies are the only thing standing between one host and another.
 *
 * Which test guards what — established by mutation, because the names mislead:
 *
 * - `lets a host upload into their own folder` guards the *SELECT* policy, not
 *   the insert policy. It uploads with `upsert: true`, and storage-api's upsert
 *   is `insert … on conflict do update … returning`; Postgres applies SELECT
 *   policies to a `returning` clause, so removing the SELECT policy makes this
 *   upload fail with "new row violates row-level security policy". A plain
 *   non-upsert insert is unaffected.
 *   Removing the SELECT policy fails THREE of the five tests, so do not read a
 *   red suite here as three separate faults. Measured: this test directly; the
 *   enumeration test below, on its owner-side assertion (the owner cannot list
 *   either once the policy is gone); and `serves an uploaded cover publicly`
 *   consequentially — that test then fetches a path where nothing was ever
 *   written, so its 400 is "not found", not "not authorised". Do not read that
 *   last failure as evidence the public route consults RLS. It does not.
 * - `refuses an upload into another host's folder` guards the folder-name check
 *   in the insert policy. Deleting that clause fails this test and only this one.
 * - `does not let an anonymous visitor enumerate cover folders` guards the
 *   folder-name check in the SELECT policy. Loosening it back to
 *   `using (bucket_id = 'event-covers')` fails this test and only this one.
 *   It makes two assertions that fail for opposite reasons, so check which one
 *   broke: the anon assertion catches the policy being too WIDE, and the owner
 *   assertion above it catches it being too NARROW or absent. The owner one is
 *   there to stop the anon check passing vacuously against an empty bucket.
 * - `serves an uploaded cover publicly` guards `public: true` on the bucket, NOT
 *   the SELECT policy. storage-api serves /object/public/ off the bucket flag
 *   without consulting RLS at all — with the SELECT policy dropped and the
 *   object written by the service role, that URL still returns 200. Flipping the
 *   bucket to `public = false` is what fails this test, alone and cleanly.
 *
 * So `public: true` and the SELECT policy are not redundant: the flag drives the
 * public URL, the policy drives the RLS-checked routes (listing, and upsert).
 *
 * Nothing here guards `to authenticated` on the three write policies, and no
 * test should be written to. That clause is redundant defence-in-depth: an anon
 * caller's auth.uid() is NULL, so the folder equality is NULL and already denies
 * the write. Widening those policies to `to anon, authenticated` leaves every
 * test below green — which is correct, not a coverage hole. `refuses an
 * anonymous upload` passes because of the folder check, not the role clause.
 */

const db = adminClient()
const pixel = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })

let alice: string
let bob: string

beforeAll(async () => {
  alice = await createTestUser(db)
  bob = await createTestUser(db)
})

afterAll(async () => {
  await db.storage.from('event-covers').remove([`${alice}/cover.jpg`]).catch(() => {})
  await db.auth.admin.deleteUser(alice).catch(() => {})
  await db.auth.admin.deleteUser(bob).catch(() => {})
})

describe('event-covers bucket', () => {
  it('lets a host upload into their own folder', async () => {
    const { error } = await userClient(alice)
      .storage.from('event-covers')
      .upload(`${alice}/cover.jpg`, pixel, { contentType: 'image/jpeg', upsert: true })

    expect(error).toBeNull()
  })

  it('refuses an upload into another host\'s folder', async () => {
    const { error } = await userClient(bob)
      .storage.from('event-covers')
      .upload(`${alice}/hijack.jpg`, pixel, { contentType: 'image/jpeg' })

    expect(error).not.toBeNull()
  })

  it('refuses an anonymous upload', async () => {
    const { error } = await anonClient()
      .storage.from('event-covers')
      .upload(`${alice}/anon.jpg`, pixel, { contentType: 'image/jpeg' })

    expect(error).not.toBeNull()
  })

  it('does not let an anonymous visitor enumerate cover folders', async () => {
    // Must run after the upload above, or there is nothing to enumerate and this
    // would pass vacuously. The owner's listing is asserted first for exactly
    // that reason: it proves the folder is genuinely there to be found.
    const mine = await userClient(alice).storage.from('event-covers').list('')
    expect((mine.data ?? []).map((entry) => entry.name)).toContain(alice)

    // A stranger must not be able to discover that this host exists, let alone
    // walk into the folder and read the covers of their unpublished drafts.
    const { data } = await anonClient().storage.from('event-covers').list('')
    expect((data ?? []).map((entry) => entry.name)).not.toContain(alice)
  })

  it('serves an uploaded cover publicly', async () => {
    const { data } = userClient(alice).storage.from('event-covers').getPublicUrl(`${alice}/cover.jpg`)
    const response = await fetch(data.publicUrl)
    expect(response.status).toBe(200)
  })
})
