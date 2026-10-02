import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatableRuntimeAssetId } from '../../src/shared/runtime-assets'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(id: UpdatableRuntimeAssetId) => void>(),
  refresh: vi.fn<() => Promise<boolean>>(),
  notifyClaudeRuntimeChanged: vi.fn(),
  selectedCodex: '/managed/codex-runtime/versions/0.160.0-linux-arm64/bin/codex',
  managers: [] as { connecting?: boolean; connectedRuntimePath: string | null }[],
  recycleCodexConnections:
    vi.fn<(stale: (runtimePath: string) => boolean, unusedSince?: unknown) => Promise<boolean>>(),
  uses: { handedOut: 0 },
  resolving: null as Promise<void> | null,
  antigravityManagers: [] as {
    runtimeUseCount: number
    runtimeConnecting: boolean
    connectedRuntime: { command: string } | null
    recycleRuntime: ReturnType<typeof vi.fn>
  }[],
  selectedAntigravity: '/managed/antigravity/1.2.2/agy_acp_server.par',
}))

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  onRuntimeUpdateChanged: (listener: (id: UpdatableRuntimeAssetId) => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  },
}))
vi.mock('../../src/main/chat/antigravity-subscription/manager', () => ({
  listAntigravitySubscriptionManagers: () => mocks.antigravityManagers,
}))
vi.mock('../../src/main/chat/antigravity-subscription/runtime', () => ({
  selectedAntigravityRuntimePath: async () => mocks.selectedAntigravity,
}))
vi.mock('../../src/main/chat/claude-agent-sdk/runtime-selection', () => ({
  botClaudeRuntime: () => ({ refresh: mocks.refresh }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  notifyClaudeRuntimeChanged: mocks.notifyClaudeRuntimeChanged,
}))
vi.mock('../../src/main/chat/codex-subscription/bot-runtime', () => ({
  resolveBotCodexRuntime: async () => {
    await mocks.resolving
    return { executablePath: mocks.selectedCodex }
  },
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  listCodexSubscriptionManagers: () => mocks.managers,
  recycleCodexConnections: mocks.recycleCodexConnections,
  codexConnectionUses: () => ({ ...mocks.uses }),
}))

import type { FleetInstanceStatus } from '@maestrly/bot-fleet-protocol'
import { startBotRuntimes } from '../../src/main/runtime-assets/bot-runtimes'

const idle = {
  turn: { state: 'idle', startedAt: null, inputId: null },
  queue: [],
  pending: [],
  compaction: null,
} as unknown as FleetInstanceStatus

function emit(id: UpdatableRuntimeAssetId) {
  for (const listener of mocks.listeners) listener(id)
}

beforeEach(() => {
  mocks.listeners.clear()
  mocks.refresh.mockReset().mockResolvedValue(false)
  mocks.notifyClaudeRuntimeChanged.mockReset()
  mocks.recycleCodexConnections.mockReset().mockResolvedValue(true)
  mocks.managers = []
  mocks.uses = { handedOut: 0 }
  mocks.resolving = null
  mocks.antigravityManagers = []
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('startBotRuntimes', () => {
  it('keeps an ACP update pending while a bot works, then recycles using its admission snapshot', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let working = true
    const manager = {
      runtimeUseCount: 7,
      runtimeConnecting: false,
      connectedRuntime: { command: '/managed/antigravity/1.2.1/agy_acp_server.par' },
      recycleRuntime: vi.fn(async () => true),
    }
    mocks.antigravityManagers = [manager]
    const statuses = vi.fn(async () => [working ? ({ ...idle, turn: { state: 'running' } } as typeof idle) : idle])
    const stop = startBotRuntimes({ botStatuses: statuses })
    try {
      emit('antigravity-acp-runtime')
      await vi.waitFor(() => expect(statuses).toHaveBeenCalled())
      expect(manager.recycleRuntime).not.toHaveBeenCalled()
      expect(mocks.recycleCodexConnections).not.toHaveBeenCalled()
      working = false
      await vi.advanceTimersByTimeAsync(30_000)
      expect(manager.recycleRuntime).toHaveBeenCalledWith(mocks.selectedAntigravity, 7)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(manager.recycleRuntime).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('keeps retrying an ACP handshake in progress and stops following updates when disposed', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const manager = {
      runtimeUseCount: 1,
      runtimeConnecting: true,
      connectedRuntime: null,
      recycleRuntime: vi.fn(async () => false),
    }
    mocks.antigravityManagers = [manager]
    const stop = startBotRuntimes({ botStatuses: async () => [idle] })
    emit('antigravity-acp-runtime')
    await vi.waitFor(() => expect(manager.recycleRuntime).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(manager.recycleRuntime).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(manager.recycleRuntime).toHaveBeenCalledTimes(2)
  })
  it('does nothing outside bots', () => {
    const stop = startBotRuntimes({ botStatuses: async () => [idle] })
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(mocks.listeners.size).toBe(0)
    stop()
  })

  it('selects Claude Code at start and after each update, and reloads models only when it changed', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const stop = startBotRuntimes({ botStatuses: async () => [idle] })
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
    expect(mocks.notifyClaudeRuntimeChanged).not.toHaveBeenCalled()

    mocks.refresh.mockResolvedValueOnce(true)
    emit('claude-code-runtime')
    await vi.waitFor(() => expect(mocks.notifyClaudeRuntimeChanged).toHaveBeenCalledTimes(1))
    stop()
    expect(mocks.listeners.size).toBe(0)
  })

  it('recycles Codex connections left on another runtime once the bots are idle', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    mocks.managers = [
      { connectedRuntimePath: '/opt/maestrly/resources/codex/bin/codex' },
      { connectedRuntimePath: null },
    ]
    const stop = startBotRuntimes({ botStatuses: async () => [idle] })
    emit('codex-runtime')
    await vi.waitFor(() => expect(mocks.recycleCodexConnections).toHaveBeenCalledTimes(1))
    const stale = mocks.recycleCodexConnections.mock.calls[0][0]
    expect(stale('/opt/maestrly/resources/codex/bin/codex')).toBe(true)
    expect(stale(mocks.selectedCodex)).toBe(false)
    stop()
  })

  it('asks for a recycle while a connection is still being established, whatever runtime it ends up on', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    mocks.managers = [{ connecting: true, connectedRuntimePath: null }]
    mocks.recycleCodexConnections.mockResolvedValue(false)
    const stop = startBotRuntimes({ botStatuses: async () => [idle] })
    emit('codex-runtime')
    await vi.waitFor(() => expect(mocks.recycleCodexConnections).toHaveBeenCalledTimes(1))
    stop()
  })

  it('keeps a connection a turn took after the idle check, while the runtime was still being resolved', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    mocks.managers = [{ connectedRuntimePath: '/opt/maestrly/resources/codex/bin/codex' }]
    mocks.recycleCodexConnections.mockImplementation(
      async (_stale, unusedSince) => (unusedSince as { handedOut: number }).handedOut === mocks.uses.handedOut
    )
    let resolve!: () => void
    const onRuntimesChanged = vi.fn()
    const stop = startBotRuntimes({
      botStatuses: async () => {
        // The bots are idle now; resolving the selected runtime takes a while.
        mocks.resolving = new Promise<void>((done) => {
          resolve = done
        })
        return [idle]
      },
      onRuntimesChanged,
    })
    emit('codex-runtime')
    onRuntimesChanged.mockClear()
    await vi.waitFor(() => expect(mocks.resolving).not.toBeNull())

    // A turn starts and takes the connection before the resolution ends.
    mocks.uses.handedOut += 1
    resolve()
    await vi.waitFor(() => expect(mocks.recycleCodexConnections).toHaveBeenCalledTimes(1))
    expect(mocks.recycleCodexConnections.mock.calls[0][1]).toEqual({ handedOut: 0 })
    await expect(mocks.recycleCodexConnections.mock.results[0].value).resolves.toBe(false)
    expect(onRuntimesChanged).not.toHaveBeenCalled()
    stop()
  })

  it('publishes new bot statuses whenever a runtime changes', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const onRuntimesChanged = vi.fn()
    const stop = startBotRuntimes({ botStatuses: async () => [idle], onRuntimesChanged })
    emit('claude-code-runtime')
    emit('codex-runtime')
    expect(onRuntimesChanged).toHaveBeenCalledTimes(2)
    stop()
  })

  it('leaves Codex connections alone when they already run the selected runtime', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    mocks.managers = [{ connectedRuntimePath: mocks.selectedCodex }]
    const stop = startBotRuntimes({ botStatuses: async () => [idle] })
    emit('codex-runtime')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.recycleCodexConnections).not.toHaveBeenCalled()
    stop()
  })
})
