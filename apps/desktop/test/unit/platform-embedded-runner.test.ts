import { describe, it, expect, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  bindings: [
    {
      workspaceId: 'one',
      connectionId: 'connection',
      organizationId: 'org',
      projectId: 'project-a',
      boardId: 'a',
      repositoryBindingId: 'repo-a',
    },
    {
      workspaceId: 'two',
      connectionId: 'connection',
      organizationId: 'org',
      projectId: 'project-b',
      boardId: 'b',
      repositoryBindingId: 'repo-b',
    },
  ],
  mode: 'personal' as 'personal' | 'team',
  owner: 'user-a',
  claim: null as unknown,
  request: vi.fn(async (_method: string, url: string, _options?: unknown): Promise<any> => {
    if (url.endsWith('/me')) return { userId: fixture.owner }
    if (url.endsWith('/personal-devices'))
      return { runnerId: 'personal-runner', credential: 'fixture-credential', ownerUserId: fixture.owner }
    if (url.endsWith('/runner-enrollments')) return { token: 'enrollment' }
    if (url.endsWith('/runners/enroll')) return { runnerId: 'shared-runner', credential: 'shared-credential' }
    if (url.endsWith('/presence')) return { enabled: true }
    if (url.endsWith('/claim')) return fixture.claim
    return null
  }),
  options: null as null | { repositories: Array<{ bindingId: string; localPath: string }> },
  server: null as null | { claim(): Promise<unknown> },
  available: true,
}))
vi.mock('@maestrly/client-sdk', () => ({
  HttpTransport: class {
    request = fixture.request
  },
}))
vi.mock('@maestrly/runner-core', () => ({
  RuntimeCatalog: class {
    async read() {
      return { version: 1, models: [], maestro: false, subagents: false, preCommands: false, issues: [] }
    }
  },
  ContainerCommandRunner: class {
    async available() {
      return false
    }
  },
  WorkspaceManager: class {
    constructor(options: { repositories: Array<{ bindingId: string; localPath: string }> }) {
      fixture.options = options
    }
    async inventory() {
      return [{ available: fixture.available }]
    }
  },
  inspectRepositories: async (repositories: unknown) => repositories,
  RunnerEngine: class {
    constructor(server: { claim(): Promise<unknown> }) {
      fixture.server = server
    }
    async recover() {}
    async runOnce() {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return true
    }
    async stop() {}
  },
  RunnerJournal: class {},
  CodexExecutor: class {},
  ClaudeAgentExecutor: class {},
}))
vi.mock('../../src/main/platform/executor-settings', () => ({
  executorSettings: () => ({ mode: fixture.mode, providerIds: ['codex-subscription'] }),
  saveExecutorSettings: vi.fn(),
}))
vi.mock('../../src/main/platform/desktop-executor', () => ({
  DesktopChatExecutor: class {},
  DesktopModelCatalog: class {
    async read() {
      return {
        version: 1,
        models: [{ provider: 'maestrly', model: 'model', label: 'Codex' }],
        maestro: true,
        subagents: true,
        preCommands: false,
        issues: [],
      }
    }
  },
}))
vi.mock('../../src/main/platform/connection-service', () => ({
  platformConnections: {
    list: () => [{ id: 'connection', url: 'http://instance.test', instanceId: 'instance' }],
    authenticatedToken: async () => 'fixture-human-token',
  },
}))
vi.mock('../../src/main/platform/project-bindings', () => ({
  platformProjectBindings: { list: () => fixture.bindings },
}))
vi.mock('../../src/main/store', () => ({ getWorkspace: (id: string) => ({ path: '/fixture/' + id }) }))
vi.mock('../../src/main/secure-store', () => ({ secureGet: () => null, secureSet: () => false, secureRemove: vi.fn() }))

import { EmbeddedRunnerHost } from '../../src/main/platform/runner-host'
describe('embedded runner Git mapping', () => {
  it('enrolls the configured projects, announces approved checkouts and reuses memory-only identity', async () => {
    fixture.request.mockClear()
    fixture.available = true
    const host = new EmbeddedRunnerHost()
    try {
      expect((await host.start('connection')).state).toBe('running')
      expect(fixture.request).toHaveBeenCalledWith(
        'POST',
        '/api/v1/personal-devices',
        expect.objectContaining({
          body: { organizationId: 'org', projectIds: ['project-a', 'project-b'], name: expect.any(String) },
          idempotencyKey: expect.any(String),
        })
      )
      expect(fixture.options?.repositories).toEqual([
        { bindingId: 'repo-a', localPath: '/fixture/one' },
        { bindingId: 'repo-b', localPath: '/fixture/two' },
      ])
      await fixture.server!.claim()
      expect(fixture.request).toHaveBeenCalledWith(
        'POST',
        '/api/v1/runners/claim',
        expect.objectContaining({ body: expect.objectContaining({ repositories: fixture.options?.repositories }) })
      )
      await host.stop()
      await host.start('connection')
      expect(fixture.request.mock.calls.filter(c => c[1] === '/api/v1/personal-devices').at(-1)).toEqual([
        'POST',
        '/api/v1/personal-devices',
        expect.objectContaining({ body: expect.objectContaining({ deviceId: 'personal-runner' }) })
      ])
      expect(fixture.request).toHaveBeenCalledWith('POST', '/api/v1/runners/chat/inventory', expect.objectContaining({body: expect.objectContaining({enabled:false})}))
      await host.stop()
      fixture.owner = 'user-b'
      await host.start('connection')
      const latest = fixture.request.mock.calls.filter((c) => c[1] === '/api/v1/personal-devices').at(-1)![2] as {
        body: { deviceId?: string }
      }
      expect(latest.body.deviceId).toBeUndefined()
      fixture.claim = {
        envelope: {
          organizationId: 'org',
          snapshot: { personalDevice: { deviceId: 'someone-else', ownerUserId: 'user-b' } },
        },
      }
      await expect(fixture.server!.claim()).rejects.toThrow(/only personal/)
      fixture.claim = null
      fixture.owner = 'user-a'
    } finally {
      await host.stop()
    }
  })
  it('enrolls team mode separately and rejects personal jobs', async () => {
    fixture.mode='team';fixture.request.mockClear()
    const host=new EmbeddedRunnerHost()
    try {
      expect(await host.start('connection')).toMatchObject({state:'running',mode:'team',deviceId:'shared-runner'})
      expect(fixture.request.mock.calls.some(c=>c[1]==='/api/v1/personal-devices')).toBe(false)
      fixture.claim={envelope:{organizationId:'org',snapshot:{personalDevice:{deviceId:'personal-runner',ownerUserId:'user-a'}}}}
      await expect(fixture.server!.claim()).rejects.toThrow(/shared jobs/)
      fixture.claim=null
      await host.stop()
      expect(fixture.request).toHaveBeenCalledWith('POST','/api/v1/runners/presence',expect.objectContaining({body:{online:false}}))
    } finally {fixture.mode='personal';fixture.claim=null;await host.stop()}
  })
  it('rejects unavailable local Git before creating a remote identity', async () => {
    fixture.request.mockClear()
    fixture.available = false
    const host = new EmbeddedRunnerHost()
    expect((await host.start('connection')).state).toBe('error')
    expect(fixture.request).not.toHaveBeenCalled()
    fixture.available = true
  })
  it('honors disabling while the account handshake is still starting', async () => {
    fixture.available = true
    let release!: (value: { userId: string }) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const host = new EmbeddedRunnerHost()
    const starting = host.start('connection')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await host.stop()
    release({ userId: 'user-a' })
    expect((await starting).state).toBe('stopped')
    expect(fixture.request).toHaveBeenCalledWith(
      'POST',
      '/api/v1/personal-devices/presence',
      expect.objectContaining({ body: { online: false } })
    )
  })
})
