import { describe, expect, it } from 'vitest'
import { RUNTIME_ASSET_IDS, RUNTIME_ASSET_STATES } from '../../src/shared/runtime-assets'
import {
  RUNTIME_ASSET_REGISTRY,
  RUNTIME_TARGET_IDS,
  hostRuntimeTarget,
  type RuntimeAssetDefinition,
  type RuntimeTargetId,
} from '../../src/main/runtime-assets/registry'

describe('runtime asset registry', () => {
  it('exposes immutable known IDs and every lifecycle state', () => {
    expect(RUNTIME_ASSET_IDS).toEqual(['codex-runtime', 'github-copilot-runtime', 'tunnel-client', 'local-ml-runtime'])
    expect(RUNTIME_ASSET_STATES).toEqual([
      'not-installed',
      'downloading',
      'verifying',
      'installing',
      'ready',
      'failed',
      'corrupt',
      'removing',
    ])
  })

  it('pins all six targets for the three fetched runtimes', () => {
    for (const id of ['codex-runtime', 'github-copilot-runtime', 'tunnel-client'] as const) {
      expect(Object.keys(RUNTIME_ASSET_REGISTRY[id].targets).sort()).toEqual([...RUNTIME_TARGET_IDS].sort())
      for (const target of Object.values(RUNTIME_ASSET_REGISTRY[id].targets)) {
        expect(target?.url).toMatch(/^https:\/\//)
        expect(target?.hash.digest).toBeTruthy()
        expect(target?.criticalPaths.length).toBeGreaterThan(0)
        expect(target?.executablePath).toBeTruthy()
        expect(target?.criticalPaths).toContain(target?.executablePath)
      }
    }
    expect(Object.keys(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets).sort()).toEqual([
      'linux-x64',
      'mac-arm64',
      'win-x64',
    ])
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets['mac-arm64']).toMatchObject({
      hash: { algorithm: 'sha256', digest: '27f8780e28f728344c243f25030cfc4c7e3cd6c931bb5b96955f239cb8e8d757' },
      downloadBytes: 40_915_502,
      unpackedBytes: 141_329_591,
    })
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets['linux-x64']).toMatchObject({
      hash: { algorithm: 'sha256', digest: '69def4285a4999cd062a5188b412eae9ba40e4de9b28d7f84d228c1eebf1ada3' },
      downloadBytes: 42_650_909,
      unpackedBytes: 141_388_618,
    })
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime'].targets['win-x64']).toMatchObject({
      hash: { algorithm: 'sha256', digest: 'd5374108a43c62866e5cb350f0b72ea5f56491660da9e92efb11ed27001be183' },
      downloadBytes: 38_825_531,
      unpackedBytes: 130_427_312,
    })
  })

  it('matches the exact versions and representative script pins', () => {
    expect(RUNTIME_ASSET_REGISTRY['codex-runtime']).toMatchObject({ version: '0.153.4' })
    expect(RUNTIME_ASSET_REGISTRY['codex-runtime'].targets['mac-arm64']?.hash.digest).toBe(
      'B1qhN3fa1ay0R0wGziXqgwSkB5icpYChNKHhtBHff/0UtSTC7z+l8aTtvMlGjH3E8HEvY3+njIJelM9CAAoVWg=='
    )
    expect(RUNTIME_ASSET_REGISTRY['github-copilot-runtime']).toMatchObject({ version: '1.0.71' })
    expect(RUNTIME_ASSET_REGISTRY['tunnel-client']).toMatchObject({ version: '0.0.10' })
    expect(RUNTIME_ASSET_REGISTRY['local-ml-runtime']).toMatchObject({ version: '2.17.2-1' })
    expect(RUNTIME_ASSET_REGISTRY['tunnel-client'].targets['win-x64']?.hash.digest).toBe(
      '5e64a056f1d96786da0a6f8db1da5f5f4a03fd19a90d951a25cf2ca8d9093d00'
    )
  })

  it('accepts the real archive size of every fetched target', () => {
    // Measured sizes of the pinned (immutable) archives; a cap below these blocks the install.
    const measured: Record<string, Record<string, number>> = {
      'codex-runtime': {
        'mac-arm64': 115_669_249,
        'mac-x64': 123_497_670,
        'linux-arm64': 121_675_259,
        'linux-x64': 129_259_793,
        'win-arm64': 132_143_077,
        'win-x64': 141_510_231,
      },
      'github-copilot-runtime': {
        'mac-arm64': 130_336_069,
        'mac-x64': 146_101_321,
        'linux-arm64': 147_266_596,
        'linux-x64': 142_982_140,
        'win-arm64': 131_060_040,
        'win-x64': 130_154_451,
      },
      'tunnel-client': {
        'mac-arm64': 7_100_022,
        'mac-x64': 7_672_583,
        'linux-arm64': 6_789_903,
        'linux-x64': 7_508_561,
        'win-arm64': 6_839_760,
        'win-x64': 7_658_615,
      },
    }
    for (const [id, sizes] of Object.entries(measured))
      for (const [targetId, size] of Object.entries(sizes)) {
        const definition = RUNTIME_ASSET_REGISTRY[id as keyof typeof RUNTIME_ASSET_REGISTRY] as RuntimeAssetDefinition
        const target = definition.targets[targetId as RuntimeTargetId]
        expect(target?.maxDownloadBytes, `${id}/${targetId}`).toBeGreaterThanOrEqual(size)
        expect(target?.unpackedBytes, `${id}/${targetId}`).toBeGreaterThan(0)
      }
  })

  it('maps supported hosts and rejects unsupported targets', () => {
    expect(hostRuntimeTarget('darwin', 'arm64')).toBe('mac-arm64')
    expect(hostRuntimeTarget('win32', 'x64')).toBe('win-x64')
    expect(() => hostRuntimeTarget('freebsd', 'x64')).toThrow(/unsupported/i)
  })
})
