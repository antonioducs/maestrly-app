import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Every collaborator is injected below; the production defaults are not exercised here.
vi.mock('../../src/main/runtime-assets/app-service', () => ({}))

import { isManagedCodexPath, resolveBotCodexRuntime } from '../../src/main/chat/codex-subscription/bot-runtime'
import type { CodexRuntimeResolution } from '../../src/main/chat/codex-subscription/runtime-resolver'
import type { RuntimeAssetStatus } from '../../src/shared/runtime-assets'

const ROOT = '/home/bot/.config/maestrly-app-dev/runtime-assets'
const target = {} as CodexRuntimeResolution['target']

function image(version: string | null): CodexRuntimeResolution {
  return {
    executablePath: '/opt/maestrly/apps/desktop/resources/codex/linux-arm64/bin/codex',
    source: 'materialized',
    target,
    version,
  }
}

function managed(state: RuntimeAssetStatus['state'], version = '0.160.0'): RuntimeAssetStatus {
  return {
    id: 'codex-runtime',
    state,
    version,
    path: path.join(ROOT, 'codex-runtime', 'versions', `${version}-linux-arm64`),
  }
}

function resolveManaged(assetPath: string): CodexRuntimeResolution {
  return { executablePath: path.join(assetPath, 'bin', 'codex'), source: 'managed', target, version: '0.160.0' }
}

describe('resolveBotCodexRuntime', () => {
  it('uses a ready managed installation newer than the image', async () => {
    const resolution = await resolveBotCodexRuntime({
      image: () => image('0.155.1'),
      managed: async () => managed('ready'),
      resolveManaged,
    })
    expect(resolution.source).toBe('managed')
    expect(resolution.executablePath).toBe(path.join(managed('ready').path!, 'bin', 'codex'))
  })

  it('keeps the image when the managed installation is not newer or not ready', async () => {
    for (const status of [managed('ready', '0.155.1'), managed('ready', '0.150.0'), managed('corrupt')]) {
      const resolution = await resolveBotCodexRuntime({
        image: () => image('0.155.1'),
        managed: async () => status,
        resolveManaged,
      })
      expect(resolution.source).toBe('materialized')
    }
    const failing = await resolveBotCodexRuntime({
      image: () => image('0.155.1'),
      managed: async () => {
        throw new Error('metadata unavailable')
      },
      resolveManaged,
    })
    expect(failing.source).toBe('materialized')
  })

  it('uses a ready managed installation when the image version is unknown', async () => {
    const resolution = await resolveBotCodexRuntime({
      image: () => image(null),
      managed: async () => managed('ready'),
      resolveManaged,
    })
    expect(resolution.source).toBe('managed')
  })
})

describe('isManagedCodexPath', () => {
  it('recognizes only executables inside the managed Codex installations', () => {
    expect(
      isManagedCodexPath(path.join(ROOT, 'codex-runtime', 'versions', '0.160.0-linux-arm64', 'bin', 'codex'), ROOT)
    ).toBe(true)
    expect(isManagedCodexPath('/opt/maestrly/apps/desktop/resources/codex/linux-arm64/bin/codex', ROOT)).toBe(false)
    expect(isManagedCodexPath(path.join(ROOT, 'claude-code-runtime', 'versions', 'x', 'claude'), ROOT)).toBe(false)
    expect(isManagedCodexPath(path.join(ROOT, 'codex-runtime', '..', '..', 'evil', 'codex'), ROOT)).toBe(false)
  })
})
