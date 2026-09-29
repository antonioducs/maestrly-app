import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeAssetId, RuntimeAssetInfo } from '../../src/shared/runtime-assets'

const mocks = vi.hoisted(() => ({
  infos: new Map<string, unknown>(),
  cycle: vi.fn(async (_force: boolean) => {}),
  runtimeUpdates: vi.fn(),
}))

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  runtimeAssetProgressInfo: async (id: string) => mocks.infos.get(id),
  runtimeUpdates: mocks.runtimeUpdates,
}))

import { checkBotRuntimes, fleetRuntimeInfo } from '../../src/main/fleet/instance/runtimes'

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
        automatic: false,
        state: 'failed',
        availableVersion: null,
        lastCheckedAt: null,
        error: 'check-failed',
      },
    ])
  })

  it('reports no version for a runtime neither shipped nor installed', async () => {
    mocks.infos.set('claude-code-runtime', info('claude-code-runtime', {}))
    mocks.infos.set('codex-runtime', info('codex-runtime', {}))
    expect((await fleetRuntimeInfo()).map((runtime) => runtime.version)).toEqual([null, null])
  })
})

describe('checkBotRuntimes', () => {
  it('runs a forced check cycle of both runtimes', async () => {
    checkBotRuntimes()
    await vi.waitFor(() => expect(mocks.cycle).toHaveBeenCalledTimes(2))
    expect(mocks.runtimeUpdates.mock.calls.map(([id]) => id)).toEqual(['claude-code-runtime', 'codex-runtime'])
    expect(mocks.cycle.mock.calls).toEqual([[true], [true]])
  })
})
