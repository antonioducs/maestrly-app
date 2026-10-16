import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostApi } from '../../src/preload'
import {
  environmentMcpAccounts,
  PLUGINS_CHANGED_EVENT,
  SKILLS_CHANGED_EVENT,
  hostPluginsSource,
} from '../../src/renderer/components/plugins/plugins-source'

const target = new EventTarget()
beforeEach(() => {
  vi.stubGlobal('window', target)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const fakeApi = () =>
  ({
    pluginsState: vi.fn(async () => ({
      git: { available: true, version: '2' },
      secureStorage: true,
      marketplaces: [],
      installed: [],
    })),
    listWorkspaces: vi.fn(async () => [{ id: 'w1', name: 'One', conversations: [] }]),
  }) as unknown as HostApi

describe('plugin center data source', () => {
  it('is one source per host API', () => {
    const api = fakeApi()
    expect(hostPluginsSource(api)).toBe(hostPluginsSource(api))
    expect(hostPluginsSource(api).remote).toBe(false)
  })

  it('announces plugin and skill changes and unsubscribes cleanly', () => {
    const source = hostPluginsSource(fakeApi())
    const plugins = vi.fn()
    const skills = vi.fn()
    target.addEventListener(SKILLS_CHANGED_EVENT, skills)
    const stop = source.subscribe(plugins)
    source.notifyChanged()
    expect(plugins).toHaveBeenCalledTimes(1)
    expect(skills).toHaveBeenCalledTimes(1)
    stop()
    source.notifyChanged()
    expect(plugins).toHaveBeenCalledTimes(1)
    expect(skills).toHaveBeenCalledTimes(2)
    target.removeEventListener(SKILLS_CHANGED_EVENT, skills)
    target.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT))
    expect(plugins).toHaveBeenCalledTimes(1)
  })

  it('lists the host projects for the scope picker', async () => {
    const api = fakeApi()
    expect(await hostPluginsSource(api).listProjects()).toEqual([{ id: 'w1', name: 'One' }])
    await hostPluginsSource(api).pluginsState()
    expect(api.pluginsState).toHaveBeenCalled()
  })

  it('manages a bot environment’s sign-in accounts through its settings, signing in on this computer', async () => {
    const settings = {
      removeMcpOAuth: vi.fn(async () => ({ removed: true })),
      patchMcpOAuthAccount: vi.fn(async () => ({ ok: true as const })),
      setMcpOAuthClient: vi.fn(async () => ({ ok: true as const })),
    }
    const actions = {
      mcpOAuthConnect: vi.fn(async () => ({ ok: true as const, accountId: 'acc_000000000001' })),
      mcpOAuthCancel: vi.fn(async () => {}),
    }
    const accounts = environmentMcpAccounts('env-1', settings, actions)
    // An environment's accounts serve all of its conversations: no projects to choose.
    expect(accounts.listProjects).toBeUndefined()
    await accounts.connect('mcp_1', { accountId: 'acc_000000000001', scope: { kind: 'global' } })
    expect(actions.mcpOAuthConnect).toHaveBeenLastCalledWith('env-1', 'mcp_1', { accountId: 'acc_000000000001' })
    await accounts.forget('mcp_1', 'acc_000000000001')
    expect(settings.removeMcpOAuth).toHaveBeenLastCalledWith({ id: 'mcp_1', accountId: 'acc_000000000001' })
    await accounts.forget('mcp_1')
    expect(settings.removeMcpOAuth).toHaveBeenLastCalledWith({ id: 'mcp_1' })
    await accounts.patchAccount('mcp_1', 'acc_000000000001', { label: 'Work' })
    expect(settings.patchMcpOAuthAccount).toHaveBeenLastCalledWith({
      id: 'mcp_1',
      accountId: 'acc_000000000001',
      label: 'Work',
    })
    expect(await accounts.patchAccount('mcp_1', 'acc_000000000001', { scope: { kind: 'global' } })).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    await accounts.setClient('mcp_1', { clientId: 'own', clientSecret: 'synthetic' })
    expect(settings.setMcpOAuthClient).toHaveBeenLastCalledWith({
      id: 'mcp_1',
      client: { clientId: 'own', clientSecret: 'synthetic' },
    })
  })
})
