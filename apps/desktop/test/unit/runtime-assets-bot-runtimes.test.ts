import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(id: 'codex-runtime' | 'claude-code-runtime') => void>(),
  refresh: vi.fn<() => Promise<boolean>>(),
  notifyClaudeRuntimeChanged: vi.fn(),
  selectedCodex: '/managed/codex-runtime/versions/0.160.0-linux-arm64/bin/codex',
  managers: [] as { connectedRuntimePath: string | null }[],
  recycleCodexConnections: vi.fn<(stale: (runtimePath: string) => boolean) => Promise<boolean>>(),
}))

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  onRuntimeUpdateChanged: (listener: (id: 'codex-runtime' | 'claude-code-runtime') => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  },
}))
vi.mock('../../src/main/chat/claude-agent-sdk/runtime-selection', () => ({
  botClaudeRuntime: () => ({ refresh: mocks.refresh }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  notifyClaudeRuntimeChanged: mocks.notifyClaudeRuntimeChanged,
}))
vi.mock('../../src/main/chat/codex-subscription/bot-runtime', () => ({
  resolveBotCodexRuntime: async () => ({ executablePath: mocks.selectedCodex }),
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  listCodexSubscriptionManagers: () => mocks.managers,
  recycleCodexConnections: mocks.recycleCodexConnections,
}))

import type { FleetInstanceStatus } from '@maestrly/bot-fleet-protocol'
import { startBotRuntimes } from '../../src/main/runtime-assets/bot-runtimes'

const idle = {
  turn: { state: 'idle', startedAt: null, inputId: null },
  queue: [],
  pending: [],
  compaction: null,
} as unknown as FleetInstanceStatus

function emit(id: 'codex-runtime' | 'claude-code-runtime') {
  for (const listener of mocks.listeners) listener(id)
}

beforeEach(() => {
  mocks.listeners.clear()
  mocks.refresh.mockReset().mockResolvedValue(false)
  mocks.notifyClaudeRuntimeChanged.mockReset()
  mocks.recycleCodexConnections.mockReset().mockResolvedValue(true)
  mocks.managers = []
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('startBotRuntimes', () => {
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
