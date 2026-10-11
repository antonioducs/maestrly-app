import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentRuntime } from '../../src/main/fleet/instance/environment'
import { type InstanceEnvironment, InstanceEvents, InstanceHttpError } from '../../src/main/fleet/instance/server'
import { HostEnvironment } from '../../src/main/remote-host/server/host-environment'

function setup(busy = false) {
  const runtime = {
    events: new InstanceEvents(),
    health: vi.fn(() => ({
      ok: true as const,
      appVersion: '1.2.3',
      protocol: 1 as const,
      ready: true,
      capabilities: ['provisioning', 'environments'],
    })),
    environmentStatus: vi.fn(async () => ({
      environmentId: 'workspaces',
      capabilities: ['provisioning', 'environments'],
      appVersion: '1.2.3',
      protocol: 1 as const,
      ready: true,
      bots: [],
    })),
    selections: vi.fn(async () => ({ options: [], current: null })),
    accounts: vi.fn(() => ({ accounts: 'list' })),
    startLogin: vi.fn(async (request: unknown) => ({ started: request })),
    login: vi.fn((id: string) => ({ id })),
    loginCallback: vi.fn(async () => ({ ok: true })),
    submitLoginCode: vi.fn(async () => ({ submitted: true })),
    cancelLogin: vi.fn(async () => undefined),
    importAccounts: vi.fn(async () => ({ results: [] })),
    removeSubscription: vi.fn(async () => undefined),
    skills: vi.fn(async () => ({ skills: [] })),
    installSkill: vi.fn(async () => ({ name: 'skill' })),
    removeSkill: vi.fn(async () => undefined),
    mcpServers: vi.fn(() => ({ servers: [] })),
    importMcpServers: vi.fn(async () => ({ results: [] })),
    removeMcpServer: vi.fn(async () => undefined),
    addApiKeyAccount: vi.fn(async () => ({ providerId: 'p1' })),
    removeAccount: vi.fn(async () => undefined),
    checkRuntimes: vi.fn(),
    settings: { accounts: vi.fn() },
  }
  const state = { busy }
  // Used as the control server uses it: through the interface of any environment.
  const environment: InstanceEnvironment = new HostEnvironment(
    runtime as unknown as EnvironmentRuntime,
    () => state.busy
  )
  return { runtime, environment, state }
}
const statusOf = async (run: () => unknown) => {
  try {
    await run()
    return null
  } catch (error) {
    return error instanceof InstanceHttpError ? error.status : error
  }
}

describe('workspaces host environment', () => {
  it('tells the gateway it hosts workspaces and whether chats are running', () => {
    const { environment, state } = setup()
    expect(environment.health()).toEqual({
      ok: true,
      appVersion: '1.2.3',
      protocol: 1,
      ready: true,
      capabilities: ['provisioning', 'environments', 'workspaces-host', 'host-files', 'host-editor'],
      busy: false,
    })
    state.busy = true
    expect(environment.health().busy).toBe(true)
  })

  it('reports no bots', async () => {
    const { environment } = setup()
    expect(await environment.environmentStatus()).toMatchObject({
      environmentId: 'workspaces',
      capabilities: ['provisioning', 'environments', 'workspaces-host', 'host-files', 'host-editor'],
      bots: [],
    })
  })

  it('refuses bots, screens and the settings window: it has none', async () => {
    const { environment } = setup()
    expect(await statusOf(() => environment.bot('dev'))).toBe(409)
    expect(await statusOf(() => environment.installBot({} as never))).toBe(409)
    expect(await statusOf(() => environment.uninstallBot('dev', { purge: false }))).toBe(409)
    expect(await statusOf(() => environment.acquireScreen({ kind: 'environment' }, 'view'))).toBe(409)
    expect(await statusOf(() => environment.open('accounts'))).toBe(409)
  })

  it("provisions accounts, skills and MCP servers with the environment runtime's code", async () => {
    const { environment, runtime } = setup()
    expect(environment.events).toBe(runtime.events)
    expect(environment.accounts()).toEqual({ accounts: 'list' })
    const login = { kind: 'codex' } as never
    expect(await environment.startLogin(login)).toEqual({ started: login })
    expect(runtime.startLogin).toHaveBeenCalledWith(login)
    expect(environment.login('l1')).toEqual({ id: 'l1' })
    await environment.loginCallback('l1', { url: 'u' } as never)
    expect(runtime.loginCallback).toHaveBeenCalledWith('l1', { url: 'u' })
    await environment.submitLoginCode('l1', 'code')
    expect(runtime.submitLoginCode).toHaveBeenCalledWith('l1', 'code')
    await environment.cancelLogin('l1')
    expect(runtime.cancelLogin).toHaveBeenCalledWith('l1')
    const key = { kind: 'openai', name: 'K', key: 'sk' } as never
    expect(await environment.addApiKeyAccount(key)).toEqual({ providerId: 'p1' })
    expect(runtime.addApiKeyAccount).toHaveBeenCalledWith(key)
    await environment.removeAccount('p1')
    expect(runtime.removeAccount).toHaveBeenCalledWith('p1')
    await environment.importAccounts({ items: [] } as never)
    await environment.removeSubscription('codex', 'default')
    expect(runtime.removeSubscription).toHaveBeenCalledWith('codex', 'default')
    await environment.skills()
    await environment.installSkill({ name: 's' } as never)
    await environment.removeSkill('s')
    expect(runtime.removeSkill).toHaveBeenCalledWith('s')
    environment.mcpServers()
    await environment.importMcpServers({ servers: [] } as never)
    await environment.removeMcpServer('m1')
    expect(runtime.removeMcpServer).toHaveBeenCalledWith('m1')
    expect(await environment.selections()).toEqual({ options: [], current: null })
  })

  it('serves the environment settings of the profile its chats use, and checks the runtimes it runs', () => {
    const { environment, runtime } = setup()
    // Without them, the settings routes it advertises answer that the environment must restart to update.
    expect(environment.settings).toBe(runtime.settings)
    environment.checkRuntimes()
    expect(runtime.checkRuntimes).toHaveBeenCalledOnce()
  })
})
