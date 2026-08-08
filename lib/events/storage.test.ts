import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, anonClient, createTestUser, userClient } from '@/tests/helpers/db'

/**
 * The cover bucket is world-readable by design, so the only thing standing
 * between hosts is the folder-name check in the insert policy.
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
