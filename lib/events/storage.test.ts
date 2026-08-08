import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, anonClient, createTestUser, userClient } from '@/tests/helpers/db'

/**
 * The cover bucket is world-readable by design, so the only thing standing
 * between hosts is the folder-name check in the insert policy.
 *
 * Which test guards what — verified by mutation, because the names mislead:
 *
 * - `lets a host upload into their own folder` guards the *SELECT* policy, not
 *   the insert policy. It uploads with `upsert: true`, and storage-api's upsert
 *   is `insert … on conflict do update … returning`; Postgres applies SELECT
 *   policies to a `returning` clause, so dropping the public-read policy makes
 *   this upload fail with "new row violates row-level security policy". A plain
 *   non-upsert insert is unaffected. This is the only test that fails if the
 *   SELECT policy is removed.
 * - `refuses an upload into another host's folder` guards the folder-name check
 *   in the insert policy. Deleting that clause fails this test and only this one.
 * - `serves an uploaded cover publicly` guards `public: true` on the bucket, NOT
 *   the public-read policy. storage-api serves /object/public/ off the bucket
 *   flag without consulting RLS at all — with the SELECT policy dropped and the
 *   object written by the service role, that URL still returns 200. Flipping the
 *   bucket to `public = false` is what fails this test.
 *
 * So `public: true` and the SELECT policy are not redundant: the flag drives the
 * public URL, the policy drives the RLS-checked routes (and upsert). Removing
 * either one breaks something, but not the thing its test name suggests.
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

  it('serves an uploaded cover publicly', async () => {
    const { data } = userClient(alice).storage.from('event-covers').getPublicUrl(`${alice}/cover.jpg`)
    const response = await fetch(data.publicUrl)
    expect(response.status).toBe(200)
  })
})
