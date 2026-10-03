import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLEET_ENVIRONMENT_SETTINGS_FEATURE } from '@maestrly/bot-fleet-protocol'
import { InstanceClient } from '../src/instance.js'
import { harness } from './harness.js'
const revision = '550e8400-e29b-41d4-a716-446655440000'
afterEach(() => vi.restoreAllMocks())
async function setup() {
  const h = await harness(Date.now, { environments: true })
  const eid = h.bot.environmentId!
  const environment = h.lifecycle.environment(eid)!
  vi.spyOn(h.lifecycle, 'environment').mockImplementation((id) =>
    id === eid ? { ...environment, capabilities: [FLEET_ENVIRONMENT_SETTINGS_FEATURE] } : null
  )
  return { h, eid, path: '/v1/environments/' + eid + '/settings' }
}
describe('environment settings routes', () => {
  it('requires paired device authentication; bot tokens cannot configure settings', async () => {
    const { h, path } = await setup()
    for (const headers of [{ 'X-Maestrly-Fleet-Protocol': '1' }, h.botHeaders()]) {
      const response = await h.request('GET', path + '/preferences', undefined, false, headers)
      expect(response.status).toBe(401)
    }
  })
  it('advertises the gateway feature and refuses missing and legacy targets', async () => {
    const { h, path } = await setup()
    expect(await (await h.request('GET', '/v1/meta')).json()).toMatchObject({
      features: expect.arrayContaining([FLEET_ENVIRONMENT_SETTINGS_FEATURE]),
    })
    expect((await h.request('GET', '/v1/environments/missing/settings/preferences')).status).toBe(404)
    const original = h.lifecycle.environment(h.bot.environmentId!)!
    vi.mocked(h.lifecycle.environment).mockReturnValue({ ...original, capabilities: [] })
    expect((await h.request('GET', path + '/preferences')).status).toBe(409)
  })
  it('targets the environment instance and validates its output', async () => {
    const { h, path } = await setup()
    vi.spyOn(h.store, 'botsOfEnvironment').mockReturnValue([])
    const read = vi
      .spyOn(InstanceClient.prototype, 'settingsPreferences')
      .mockResolvedValue({ revision, imageGenEnabled: true })
    const response = await h.request('GET', path + '/preferences')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision, imageGenEnabled: true })
    expect(read).toHaveBeenCalledWith({})
    read.mockResolvedValue(Object.assign({ revision, imageGenEnabled: true }, { secret: 'should-not-cross' }))
    const invalid = await h.request('GET', path + '/preferences')
    expect(invalid.status).not.toBe(200)
    expect(await invalid.text()).not.toContain('should-not-cross')
  })
  it('rejects stale-shaped and mismatched target input before invoking the instance', async () => {
    const { h, path } = await setup()
    const remove = vi.spyOn(InstanceClient.prototype, 'settingsRemoveAccount')
    expect((await h.request('DELETE', path + '/accounts/p', { providerId: 'p' })).status).toBe(400)
    expect(
      (await h.request('DELETE', path + '/accounts/p', { providerId: 'another', expectedRevision: revision })).status
    ).toBe(400)
    expect(remove).not.toHaveBeenCalled()
  })
})
