import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLEET_ACCOUNT_FAILOVER_FEATURE, FLEET_ENVIRONMENT_SETTINGS_FEATURE } from '@maestrly/bot-fleet-protocol'
import { InstanceClient } from '../src/instance.js'
import { harness } from './harness.js'
const revision = '550e8400-e29b-41d4-a716-446655440000'
afterEach(() => vi.restoreAllMocks())
async function setup(capabilities: string[] = [FLEET_ENVIRONMENT_SETTINGS_FEATURE]) {
  const h = await harness(Date.now, { environments: true })
  const eid = h.bot.environmentId!
  const environment = h.lifecycle.environment(eid)!
  vi.spyOn(h.lifecycle, 'environment').mockImplementation((id) =>
    id === eid ? { ...environment, capabilities } : null
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
  it('offers account failover only for an environment whose image has it', async () => {
    const { h, path } = await setup()
    expect(await (await h.request('GET', '/v1/meta')).json()).toMatchObject({
      features: expect.arrayContaining([FLEET_ACCOUNT_FAILOVER_FEATURE]),
    })
    const read = vi.spyOn(InstanceClient.prototype, 'settingsFailover')
    const response = await h.request('GET', path + '/failover')
    expect(response.status).toBe(409)
    expect(read).not.toHaveBeenCalled()
  })
  it('reads and sets failover routes through the environment instance', async () => {
    const { h, path } = await setup([FLEET_ENVIRONMENT_SETTINGS_FEATURE, FLEET_ACCOUNT_FAILOVER_FEATURE])
    vi.spyOn(h.store, 'botsOfEnvironment').mockReturnValue([])
    const routes = [{ kind: 'claude' as const, slot: null, enabled: true, fallbacks: ['acc_two'] }]
    const read = vi.spyOn(InstanceClient.prototype, 'settingsFailover').mockResolvedValue({ revision, routes: [] })
    const set = vi.spyOn(InstanceClient.prototype, 'settingsSetFailoverRoute').mockResolvedValue({ revision, routes })
    const loaded = await h.request('GET', path + '/failover')
    expect(loaded.status).toBe(200)
    expect(await loaded.json()).toEqual({ revision, routes: [] })
    expect(read).toHaveBeenCalledWith({})

    const body = { kind: 'claude', slot: null, expectedRevision: revision, enabled: true, fallbacks: ['acc_two'] }
    const saved = await h.request('PUT', path + '/failover/claude/default', body)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ revision, routes })
    expect(set).toHaveBeenCalledWith(body)
    // The path and the body name the same primary account.
    expect((await h.request('PUT', path + '/failover/claude/acc_one', body)).status).toBe(400)
    expect(set).toHaveBeenCalledTimes(1)
  })
})
