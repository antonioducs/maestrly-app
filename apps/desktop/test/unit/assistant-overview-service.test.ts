import { expect, it, vi } from 'vitest'
import {
  createOverviewService,
  type LocalPending,
  type OverviewServiceDeps,
} from '../../src/main/assistant/overview-service'
import { createHostInvoker, HostUnavailableError } from '../../src/main/remote-host/host-invoker'

const NOW = 1_800_000_000_000

function conversation(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    scope: 'project',
    workspaceId: 'ws',
    branch: 'main',
    name: id,
    status: 'idle',
    archived: 0,
    lastActivityAt: NOW - 1000,
    ...patch,
  } as never
}

function bot(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    role: 'Reviewer',
    lifecycle: 'running',
    status: 'idle',
    activity: null,
    runningRun: null,
    ...patch,
  } as never
}

const none: LocalPending = { permissions: [], questions: [] }

function deps(patch: Partial<OverviewServiceDeps> = {}): OverviewServiceDeps {
  return {
    localWorkspaces: () => [],
    localStandalone: () => [],
    isRunning: () => false,
    pending: () => none,
    hasPendingPlan: () => false,
    hosts: () => [],
    invokeHost: async () => {
      throw new Error('no host')
    },
    fleetClients: () => [],
    now: () => NOW,
    ...patch,
  }
}

it('lists local workspaces and chats, with pending questions and approvals as items to answer', async () => {
  const service = createOverviewService(
    deps({
      localWorkspaces: () => [
        { id: 'ws', name: 'api', conversations: [conversation('fix-login'), conversation('old', { archived: 1 })] },
      ],
      localStandalone: () => [conversation('chat', { scope: 'standalone', workspaceId: null, branch: null })],
      isRunning: (id) => id === 'fix-login',
      pending: (id) =>
        id === 'chat'
          ? {
              permissions: [{ id: 'req-1', toolName: 'bash', title: 'Run a command', preview: 'npm install' }],
              questions: [{ toolCallId: 'call-9', questions: [{ question: 'Which branch?' }] }],
            }
          : none,
    })
  )
  const overview = await service.collect()
  expect(overview.workspaces).toEqual([
    { workspaceId: 'ws', name: 'api', place: { kind: 'local' }, conversations: 1, running: 1 },
  ])
  expect(overview.running.map((c) => c.ref)).toEqual(['local:fix-login'])
  expect(overview.needsYou).toHaveLength(1)
  expect(overview.needsYou[0].pending).toEqual([
    { itemId: 'question:call-9', need: 'question', summary: 'Which branch?' },
    { itemId: 'permission:req-1', need: 'approval', summary: 'Run a command: npm install' },
  ])
  expect(JSON.stringify(overview)).not.toContain('"old"')
})

it('leaves out the assistant conversation itself', async () => {
  const service = createOverviewService(
    deps({ localStandalone: () => [conversation('assistant', { scope: 'standalone' }), conversation('other')] })
  )
  const overview = await service.collect('assistant')
  expect(overview.recent.map((c) => c.ref)).toEqual(['local:other'])
})

it('marks a host that does not answer in time unavailable and still returns this computer', async () => {
  vi.useFakeTimers()
  try {
    const invoker = createHostInvoker({
      registry: () => ({
        list: () => [{ id: 'srv/ws', state: 'online' }],
        use: () => ({ invoke: () => new Promise(() => {}) }),
      }),
      mainWebContentsId: () => 1,
    })
    const service = createOverviewService(
      deps({
        localStandalone: () => [conversation('local-chat')],
        hosts: () => [{ id: 'srv/ws', label: 'Workspaces', state: 'online' }],
        invokeHost: invoker.invoke,
      })
    )
    const pending = service.collect()
    await vi.advanceTimersByTimeAsync(3_100)
    const overview = await pending
    expect(overview.recent.map((c) => c.ref)).toEqual(['local:local-chat'])
    expect(overview.hosts).toEqual([
      {
        place: { kind: 'host', hostId: 'srv/ws', hostName: 'Workspaces' },
        state: 'unavailable',
        error: 'The host did not answer in time.',
      },
    ])
  } finally {
    vi.useRealTimers()
  }
})

it('reads a remote host and maps its waiting statuses', async () => {
  const calls: string[] = []
  const service = createOverviewService(
    deps({
      hosts: () => [
        { id: 'srv/ws', label: 'Workspaces', state: 'online' },
        { id: 'srv/old', label: 'Old', state: 'offline' },
      ],
      invokeHost: async <T>(_host: string, channel: string) => {
        calls.push(channel)
        if (channel === 'workspace:list')
          return [{ id: 'w', name: 'web', conversations: [conversation('remote-ask', { status: 'asking' })] }] as T
        return [conversation('remote-run', { status: 'working', scope: 'standalone' })] as T
      },
    })
  )
  const overview = await service.collect()
  expect(calls.sort()).toEqual(['conversation:list-standalone', 'workspace:list'])
  expect(overview.needsYou.map((c) => [c.ref, c.pending[0]?.need])).toEqual([['host:srv/ws:remote-ask', 'question']])
  expect(overview.running.map((c) => c.ref)).toEqual(['host:srv/ws:remote-run'])
  expect(overview.hosts.map((h) => h.state)).toEqual(['online', 'offline'])
})

it('turns a bot inbox into items that need the person and shows offline bot servers', async () => {
  const service = createOverviewService(
    deps({
      fleetClients: () => [
        {
          serverId: 'vps',
          serverName: 'vps.example',
          connected: true,
          snapshot: () => ({
            bots: [
              bot('reviewer', { status: 'waiting', activity: { kind: 'permission', title: 'Run npm test' } }),
              bot('gone', { lifecycle: 'archived' }),
            ],
            inbox: [
              {
                botId: 'reviewer',
                interaction: {
                  kind: 'permission',
                  id: 'perm-1',
                  title: 'Run npm test',
                  detail: null,
                  tool: null,
                  itemId: 'x',
                  at: NOW,
                },
              } as never,
            ],
          }),
        },
        { serverId: 'home', serverName: 'home', connected: false, snapshot: () => ({ bots: [], inbox: [] }) },
      ],
    })
  )
  const overview = await service.collect()
  expect(overview.bots.map((b) => b.name)).toEqual(['reviewer'])
  expect(overview.needsYou).toEqual([
    expect.objectContaining({
      ref: 'bot:vps:reviewer',
      activity: 'waiting for approval: Run npm test',
      pending: [{ itemId: 'permission:perm-1', need: 'approval', summary: 'Run npm test' }],
    }),
  ])
  expect(overview.hosts).toEqual([
    { place: { kind: 'bot-server', serverId: 'vps', serverName: 'vps.example' }, state: 'online' },
    { place: { kind: 'bot-server', serverId: 'home', serverName: 'home' }, state: 'offline' },
  ])
})

it('refuses to reach a host without the main window', async () => {
  const invoker = createHostInvoker({
    registry: () => ({ list: () => [], use: () => ({ invoke: async () => null }) }),
    mainWebContentsId: () => null,
  })
  await expect(invoker.invoke('srv/ws', 'workspace:list', [])).rejects.toBeInstanceOf(HostUnavailableError)
  await expect(invoker.invoke('srv/ws', 'workspace:list', [])).rejects.toThrow('No window can reach the host.')
})
