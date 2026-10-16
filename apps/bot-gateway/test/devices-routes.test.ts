import { describe, expect, it } from 'vitest'
import { FLEET_DEVICES_FEATURE, fleetDevicesResponseSchema, fleetMetaFeatures } from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { harness } from './harness.js'

const json = (response: Response) => response.json() as Promise<Record<string, any>>

/** Pairs another device through the route, as a phone or computer does. */
async function pair(h: Awaited<ReturnType<typeof harness>>, deviceName: string, client?: unknown) {
  const { code } = new Auth(h.store).createPairing()
  const response = await fetch(h.origin + '/v1/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.replace('-', ''), deviceName, ...(client ? { client } : {}) }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { deviceId: string; token: string }
}

describe('paired devices', () => {
  it('lists every device still paired, what it is, and which one is asking', async () => {
    const h = await harness()
    expect(fleetMetaFeatures(await json(await fetch(h.origin + '/v1/meta')))).toContain(FLEET_DEVICES_FEATURE)
    const phone = await pair(h, 'iPhone', { kind: 'phone', platform: 'ios' })
    const old = await pair(h, 'Old laptop')
    await h.request(
      'PUT',
      '/v1/devices/self/push',
      {
        provider: 'expo',
        token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
        platform: 'ios',
        locale: 'en',
        preferences: { waiting: true, replies: true, routines: true, errors: true },
      },
      false,
      { 'X-Maestrly-Fleet-Protocol': '1', Authorization: 'Bearer ' + phone.token, 'Content-Type': 'application/json' }
    )
    h.store.revokeDevice(old.deviceId)

    const listed = fleetDevicesResponseSchema.parse(await json(await h.request('GET', '/v1/devices')))
    expect(
      listed.devices.map((device) => [device.name, device.kind, device.platform, device.current, device.notifications])
    ).toEqual([
      ['Mac', null, null, true, false],
      ['iPhone', 'phone', 'ios', false, true],
    ])
    expect(listed.devices[0].lastSeenAt).not.toBeNull()
  })

  it('removes another device, which can no longer reach the server', async () => {
    const h = await harness()
    const phone = await pair(h, 'iPhone', { kind: 'phone', platform: 'android' })
    const asPhone = { 'X-Maestrly-Fleet-Protocol': '1', Authorization: 'Bearer ' + phone.token }
    expect((await fetch(h.origin + '/v1/devices', { headers: asPhone })).status).toBe(200)

    expect((await h.request('POST', '/v1/devices/' + phone.deviceId + '/revoke')).status).toBe(204)
    expect((await fetch(h.origin + '/v1/devices', { headers: asPhone })).status).toBe(401)
    // Removed already, or never paired.
    expect((await h.request('POST', '/v1/devices/' + phone.deviceId + '/revoke')).status).toBe(404)
    expect((await h.request('POST', '/v1/devices/no-such-device/revoke')).status).toBe(404)
  })

  it('does not remove the device that asks, which unpairs itself instead', async () => {
    const h = await harness()
    const { devices } = await json(await h.request('GET', '/v1/devices'))
    const self = await h.request('POST', '/v1/devices/' + devices[0].id + '/revoke')
    expect(self.status).toBe(400)
    expect(await json(self)).toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('needs a device token', async () => {
    const h = await harness()
    const headers = { 'X-Maestrly-Fleet-Protocol': '1' }
    expect((await fetch(h.origin + '/v1/devices', { headers })).status).toBe(401)
    expect((await fetch(h.origin + '/v1/devices/x/revoke', { method: 'POST', headers })).status).toBe(401)
  })
})
