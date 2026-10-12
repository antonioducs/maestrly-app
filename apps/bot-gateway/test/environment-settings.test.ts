import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FLEET_ENVIRONMENT_PLUGINS_FEATURE,
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  FLEET_PROTOCOL_HEADER,
} from '@maestrly/bot-fleet-protocol'
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

  it('serves plugin operations only to environments that support them', async () => {
    const { h, path } = await setup()
    const forward = vi.spyOn(InstanceClient.prototype, 'settingsPluginOperation')
    expect(await (await h.request('GET', '/v1/meta')).json()).toMatchObject({
      features: expect.arrayContaining([FLEET_ENVIRONMENT_PLUGINS_FEATURE]),
    })
    const response = await h.request('GET', path + '/plugins')
    expect(response.status).toBe(409)
    expect(forward).not.toHaveBeenCalled()
  })
  it('forwards plugin operations with their identifiers and validates both ways', async () => {
    const { h, path } = await setup([FLEET_ENVIRONMENT_SETTINGS_FEATURE, FLEET_ENVIRONMENT_PLUGINS_FEATURE])
    vi.spyOn(h.store, 'botsOfEnvironment').mockReturnValue([])
    const state = { git: { available: true, version: '2.45' }, secureStorage: true, marketplaces: [], installed: [] }
    const forward = vi.spyOn(InstanceClient.prototype, 'settingsPluginOperation').mockResolvedValue(state as never)
    const read = await h.request('GET', path + '/plugins')
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(state)
    expect(forward).toHaveBeenLastCalledWith('plugins', {})

    forward.mockResolvedValue({ ok: true } as never)
    const patched = await h.request('PATCH', path + '/plugins/demo%40market', { key: 'demo@market', enabled: false })
    expect(patched.status).toBe(200)
    expect(forward).toHaveBeenLastCalledWith('patchPlugin', { key: 'demo@market', enabled: false })

    forward.mockClear()
    expect(
      (await h.request('PATCH', path + '/plugins/demo%40market', { key: 'other@market', enabled: false })).status
    ).toBe(400)
    expect((await h.request('PATCH', path + '/plugins/demo%40market', { key: 'demo@market' })).status).toBe(400)
    expect(forward).not.toHaveBeenCalled()

    forward.mockResolvedValue({ ok: true, tokens: 'should-not-cross' } as never)
    const invalid = await h.request('DELETE', path + '/plugins/demo%40market', {
      key: 'demo@market',
      deleteData: false,
    })
    expect(invalid.status).not.toBe(200)
    expect(await invalid.text()).not.toContain('should-not-cross')
  })
  it('forwards an own OAuth client and account changes, and records them as MCP settings', async () => {
    const { h, eid, path } = await setup([FLEET_ENVIRONMENT_SETTINGS_FEATURE, FLEET_ENVIRONMENT_PLUGINS_FEATURE])
    vi.spyOn(h.store, 'botsOfEnvironment').mockReturnValue([])
    const activity = vi.spyOn(h.lifecycle, 'recordEnvironmentActivity')
    const forward = vi
      .spyOn(InstanceClient.prototype, 'settingsPluginOperation')
      .mockResolvedValue({ ok: true } as never)
    const id = 'plg_' + '0'.repeat(20)
    const client = { clientId: 'own', clientSecret: 'synthetic' }
    const set = await h.request('PUT', `${path}/mcp-oauth/${id}/client`, { id, client })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ ok: true })
    expect(forward).toHaveBeenLastCalledWith('setMcpOAuthClient', { id, client })
    const accountId = 'acc_0123456789ab'
    const renamed = await h.request('PATCH', `${path}/mcp-oauth/${id}/accounts/${accountId}`, {
      id,
      accountId,
      label: 'Work',
    })
    expect(renamed.status).toBe(200)
    expect(forward).toHaveBeenLastCalledWith('patchMcpOAuthAccount', { id, accountId, label: 'Work' })
    expect(activity).toHaveBeenCalledWith(
      eid,
      'bot_configured',
      expect.objectContaining({ mcpServers: 1 }),
      expect.anything()
    )
    expect(activity.mock.calls.every(([, , counts]) => (counts as { plugins?: number }).plugins !== 1)).toBe(true)
  })

  it('calls the instance with path identifiers, a body for writes and none for reads', async () => {
    const seen: string[] = []
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      expect(req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()]).toBe('1')
      seen.push(`${req.method} ${req.url} ${body}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url?.endsWith('/logo') ? { dataUrl: null } : { ok: false, error: 'unknown-plugin' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const client = new InstanceClient(
        'work',
        'control',
        'http://127.0.0.1:' + (server.address() as net.AddressInfo).port
      )
      const marketplaceId = 'mkt_0123456789abcdef'
      expect(await client.settingsPluginOperation('pluginLogo', { marketplaceId, name: 'demo' })).toEqual({
        dataUrl: null,
      })
      expect(await client.settingsPluginOperation('uninstallPlugin', { key: 'demo@market', deleteData: true })).toEqual(
        {
          ok: false,
          error: 'unknown-plugin',
        }
      )
      expect(seen).toEqual([
        `GET /v1/settings/plugin-sources/${marketplaceId}/plugins/demo/logo `,
        'DELETE /v1/settings/plugins/demo%40market {"key":"demo@market","deleteData":true}',
      ])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
