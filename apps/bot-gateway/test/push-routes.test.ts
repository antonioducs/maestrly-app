import { describe, expect, it } from 'vitest'
import { harness } from './harness.js'

const registration = {
  provider: 'expo',
  token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
  platform: 'android',
  locale: 'pt-BR',
  preferences: { waiting: true, replies: false, routines: true, errors: true },
}
const json = (response: Response) => response.json() as Promise<Record<string, any>>

describe('push registration routes', () => {
  it('lets a phone register, read, change and remove its push token', async () => {
    const h = await harness()
    expect((await json(await fetch(h.origin + '/v1/meta'))).features).toContain('phones')
    expect(await json(await h.request('GET', '/v1/devices/self/push'))).toEqual({ registration: null })

    const saved = await h.request('PUT', '/v1/devices/self/push', registration)
    expect(saved.status).toBe(200)
    expect(await json(saved)).toMatchObject({ ...registration, updatedAt: expect.any(String) })
    expect((await json(await h.request('GET', '/v1/devices/self/push'))).registration).toMatchObject(registration)
    const changed = await h.request('PUT', '/v1/devices/self/push', {
      ...registration,
      preferences: { ...registration.preferences, replies: true },
    })
    expect((await json(changed)).preferences.replies).toBe(true)

    expect((await h.request('PUT', '/v1/devices/self/push', { ...registration, token: 'not-a-token' })).status).toBe(
      400
    )
    expect((await h.request('DELETE', '/v1/devices/self/push')).status).toBe(204)
    expect(await json(await h.request('GET', '/v1/devices/self/push'))).toEqual({ registration: null })
    // A test needs a registration first; nothing is sent.
    const test = await h.request('POST', '/v1/devices/self/push/test', {})
    expect(test.status).toBe(404)
  })

  it('forgets the push token of a phone that unpairs', async () => {
    const h = await harness()
    await h.request('PUT', '/v1/devices/self/push', registration)
    expect(h.store.activePushRegistrations()).toHaveLength(1)
    expect((await h.request('DELETE', '/v1/devices/self')).status).toBe(204)
    expect(h.store.activePushRegistrations()).toEqual([])
  })

  it('needs a device token', async () => {
    const h = await harness()
    const anonymous = await fetch(h.origin + '/v1/devices/self/push', { headers: { 'X-Maestrly-Fleet-Protocol': '1' } })
    expect(anonymous.status).toBe(401)
  })

  it('tells a phone that a server with push off sends no notifications', async () => {
    const h = await harness(Date.now, { pushOff: true })
    expect((await json(await fetch(h.origin + '/v1/meta'))).features).toContain('phones')
    const refused = await h.request('PUT', '/v1/devices/self/push', registration)
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ code: 'CONFLICT' })
    expect(h.store.activePushRegistrations()).toEqual([])
    expect((await h.request('POST', '/v1/devices/self/push/test', {})).status).toBe(409)
  })
})
