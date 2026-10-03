import { fleetInstanceStatusSchema, fleetRuntimeInfoSchema } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeAssetId, RuntimeAssetInfo } from '../../src/shared/runtime-assets'

const mocks = vi.hoisted(() => ({
  infos: new Map<string, unknown>(),
  cycle: vi.fn(async (_force: boolean) => {}),
  runtimeUpdates: vi.fn(),
  claudeInUse: [] as { version: string | null; source: 'image' | 'managed' }[],
  codexConnections: [] as ({ version: string | null; source: string } | null)[],
  antigravityConnections: [] as ({ version: string; source: string } | null)[],
}))

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  runtimeAssetProgressInfo: async (id: string) => mocks.infos.get(id),
  runtimeUpdates: mocks.runtimeUpdates,
}))

vi.mock('../../src/main/chat/claude-agent-sdk/runtime-selection', () => ({
  botClaudeRuntime: () => ({ inUse: () => mocks.claudeInUse }),
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  listCodexSubscriptionManagers: () => mocks.codexConnections.map((connectedRuntime) => ({ connectedRuntime })),
}))
vi.mock('../../src/main/chat/antigravity-subscription/manager', () => ({
  listAntigravitySubscriptionManagers: () =>
    mocks.antigravityConnections.map((connectedRuntime) => ({ connectedRuntime })),
}))

import { checkBotRuntimes, fleetRuntimeInfo, fleetRuntimeReport } from '../../src/main/fleet/instance/runtimes'

function info(id: RuntimeAssetId, patch: Partial<RuntimeAssetInfo>): RuntimeAssetInfo {
  return {
    id,
    displayName: id,
    requiredBy: 'test',
    availableVersion: '1.0.0',
    downloadBytes: 1,
    unpackedBytes: 1,
    status: { id, state: 'not-installed', diskUsageBytes: 0 },
    ...patch,
  }
}

beforeEach(() => {
  mocks.infos.clear()
  mocks.claudeInUse = []
  mocks.codexConnections = []
  mocks.antigravityConnections = []
  mocks.infos.set('antigravity-acp-runtime', info('antigravity-acp-runtime', {}))
  mocks.cycle.mockClear()
  mocks.runtimeUpdates.mockReset().mockImplementation((id: string) => ({ id, cycle: mocks.cycle }))
})

describe('fleetRuntimeInfo', () => {
  it('reports the image runtime while it is in use and a newer managed one once installed', async () => {
    mocks.infos.set(
      'claude-code-runtime',
      info('claude-code-runtime', {
        provided: { version: '2.1.285', active: true },
        update: {
          state: 'available',
          automatic: true,
          restartRequired: false,
          availableVersion: '2.1.290',
          lastCheckedAt: '2026-09-29T10:00:00.000Z',
        },
      })
    )
    mocks.infos.set(
      'codex-runtime',
      info('codex-runtime', {
        status: { id: 'codex-runtime', state: 'ready', version: '0.160.0', diskUsageBytes: 1 },
        provided: { version: '0.155.1', active: false },
        update: { state: 'failed', automatic: false, restartRequired: false, error: 'check-failed' },
      })
    )
    expect(await fleetRuntimeInfo()).toEqual([
      {
        id: 'claude-code',
        version: '2.1.285',
        source: 'image',
        pendingVersion: null,
        automatic: true,
        state: 'available',
        availableVersion: '2.1.290',
        lastCheckedAt: '2026-09-29T10:00:00.000Z',
        error: null,
      },
      {
        id: 'codex',
        version: '0.160.0',
        source: 'managed',
        pendingVersion: null,
        automatic: false,
        state: 'failed',
        availableVersion: null,
        lastCheckedAt: null,
        error: 'check-failed',
      },
      {
        id: 'antigravity-acp',
        version: null,
        source: 'managed',
        pendingVersion: null,
        automatic: false,
        state: 'idle',
        availableVersion: null,
        lastCheckedAt: null,
        error: null,
      },
    ])
  })

  it('reports the version work in progress still runs, and the one installed as pending', async () => {
    mocks.infos.set(
      'claude-code-runtime',
      info('claude-code-runtime', {
        status: { id: 'claude-code-runtime', state: 'ready', version: '2.1.290', diskUsageBytes: 1 },
        provided: { version: '2.1.285', active: false },
      })
    )
    // The update to 0.160.0 was installed, but a busy bot keeps its connection on the image's Codex.
    mocks.infos.set(
      'codex-runtime',
      info('codex-runtime', {
        status: { id: 'codex-runtime', state: 'ready', version: '0.160.0', diskUsageBytes: 1 },
        provided: { version: '0.155.1', active: false },
        update: { state: 'up-to-date', automatic: true, restartRequired: false },
      })
    )
    mocks.codexConnections = [
      null,
      { version: '0.160.0', source: 'managed' },
      { version: '0.155.1', source: 'materialized' },
    ]
    // A query that started before Claude Code switched still runs the image's version.
    mocks.claudeInUse = [
      { version: '2.1.290', source: 'managed' },
      { version: '2.1.285', source: 'image' },
    ]
    const [claude, codex] = await fleetRuntimeInfo()
    expect(codex).toMatchObject({ version: '0.155.1', source: 'image', pendingVersion: '0.160.0', state: 'up-to-date' })
    expect(claude).toMatchObject({ version: '2.1.285', source: 'image', pendingVersion: '2.1.290' })

    // Once the old connection and query are gone, the installed versions are the ones in use.
    mocks.codexConnections = [{ version: '0.160.0', source: 'managed' }]
    mocks.claudeInUse = [{ version: '2.1.290', source: 'managed' }]
    const [claudeAfter, codexAfter] = await fleetRuntimeInfo()
    expect(codexAfter).toMatchObject({ version: '0.160.0', source: 'managed', pendingVersion: null })
    expect(claudeAfter).toMatchObject({ version: '2.1.290', source: 'managed', pendingVersion: null })
  })

  it('never reports a runtime of unknown version as a pending switch', async () => {
    mocks.infos.set(
      'claude-code-runtime',
      info('claude-code-runtime', { provided: { version: '2.1.285', active: true } })
    )
    mocks.infos.set('codex-runtime', info('codex-runtime', {}))
    mocks.claudeInUse = [{ version: null, source: 'image' }]
    mocks.codexConnections = [{ version: '0.155.1', source: 'path' }]
    expect((await fleetRuntimeInfo()).map(({ version, pendingVersion }) => ({ version, pendingVersion }))).toEqual([
      { version: '2.1.285', pendingVersion: null },
      { version: null, pendingVersion: null },
      { version: null, pendingVersion: null },
    ])
  })

  it('reports no version for a runtime neither shipped nor installed', async () => {
    mocks.infos.set('claude-code-runtime', info('claude-code-runtime', {}))
    mocks.infos.set('codex-runtime', info('codex-runtime', {}))
    expect((await fleetRuntimeInfo()).map((runtime) => runtime.version)).toEqual([null, null, null])
  })

  it('reports the ACP process still in use until its idle switch completes', async () => {
    mocks.infos.set('claude-code-runtime', info('claude-code-runtime', {}))
    mocks.infos.set('codex-runtime', info('codex-runtime', {}))
    mocks.infos.set(
      'antigravity-acp-runtime',
      info('antigravity-acp-runtime', {
        status: { id: 'antigravity-acp-runtime', state: 'ready', version: '1.2.2', diskUsageBytes: 1 },
        update: { state: 'up-to-date', automatic: true, restartRequired: true },
      })
    )
    mocks.antigravityConnections = [{ version: '1.2.1', source: 'managed' }, null]
    expect((await fleetRuntimeInfo())[2]).toMatchObject({
      id: 'antigravity-acp',
      version: '1.2.1',
      pendingVersion: '1.2.2',
      automatic: true,
    })
    mocks.antigravityConnections = [{ version: '1.2.2', source: 'managed' }]
    expect((await fleetRuntimeInfo())[2]).toMatchObject({ version: '1.2.2', pendingVersion: null })
  })
})

describe('checkBotRuntimes', () => {
  it('runs a forced check cycle of every runtime', async () => {
    checkBotRuntimes()
    await vi.waitFor(() => expect(mocks.cycle).toHaveBeenCalledTimes(3))
    expect(mocks.runtimeUpdates.mock.calls.map(([id]) => id)).toEqual([
      'claude-code-runtime',
      'codex-runtime',
      'antigravity-acp-runtime',
    ])
    expect(mocks.cycle.mock.calls).toEqual([[true], [true], [true]])
  })
})

describe('fleet runtime wire report', () => {
  it.each([false, true])('preserves legacy parsing with Antigravity installed: %s', async (installed) => {
    mocks.infos.set('claude-code-runtime', info('claude-code-runtime', {}))
    mocks.infos.set('codex-runtime', info('codex-runtime', {}))
    mocks.infos.set(
      'antigravity-acp-runtime',
      info(
        'antigravity-acp-runtime',
        installed
          ? { status: { id: 'antigravity-acp-runtime', state: 'ready', version: '1.2.2', diskUsageBytes: 1 } }
          : {}
      )
    )
    const wire = await fleetRuntimeReport()
    const legacy = fleetInstanceStatusSchema.pick({ runtimes: true }).extend({
      runtimes: z.array(fleetRuntimeInfoSchema.extend({ id: z.enum(['claude-code', 'codex']) })).nullable(),
    })
    expect(legacy.parse(wire).runtimes?.map((runtime) => runtime.id)).toEqual(['claude-code', 'codex'])
    expect(legacy.parse(wire)).not.toHaveProperty('additionalRuntimes')
    expect(wire.additionalRuntimes).toMatchObject([{ id: 'antigravity-acp', version: installed ? '1.2.2' : null }])
    expect(fleetInstanceStatusSchema.pick({ runtimes: true, additionalRuntimes: true }).parse(wire)).toEqual(wire)
  })
})
