import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userData: '',
  bundledClaude: null as string | null,
  settings: new Map<string, string>(),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => state.userData,
    getAppPath: () => path.join(state.userData, 'app'),
    getVersion: () => '0.11.0',
  },
}))
vi.mock('../../src/main/store/app-settings', () => ({
  getAppSetting: (key: string) => state.settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => {
    state.settings.set(key, value)
  },
}))
vi.mock('../../src/main/chat/claude-agent-sdk/resolve-claude', () => ({
  bundledClaudeCandidate: () => state.bundledClaude,
}))
vi.mock('../../src/main/chat/codex-subscription/runtime-resolver', () => ({
  resolveCodexRuntime: () => ({
    executablePath: '/opt/maestrly/apps/desktop/resources/codex/linux-arm64/bin/codex',
    source: 'materialized',
    target: {},
    version: '0.155.1',
  }),
}))

import {
  imageRuntimeBaseline,
  resetRuntimeAssetAppServiceForTests,
  runtimeAssetInfo,
  runtimeUpdates,
  startRuntimeAssetUpdates,
} from '../../src/main/runtime-assets/app-service'
import { RuntimeUpdateController } from '../../src/main/runtime-assets/runtime-updates'

beforeEach(async () => {
  state.userData = await mkdtemp(path.join(os.tmpdir(), 'runtime-app-service-bot-'))
  state.settings.clear()
  const claude = path.join(state.userData, 'claude')
  await writeFile(claude, '#!/bin/sh\n')
  await chmod(claude, 0o755)
  state.bundledClaude = claude
  vi.stubEnv('AGENTS_E2E', '')
  vi.stubEnv('MAESTRLY_BOT_RUNTIME_UPDATES', '')
})

afterEach(async () => {
  resetRuntimeAssetAppServiceForTests()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  await rm(state.userData, { recursive: true, force: true })
})

describe('runtime asset app service in a bot', () => {
  beforeEach(() => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
  })

  it('reports the runtimes the image ships as provided and in use', async () => {
    expect(await runtimeAssetInfo('claude-code-runtime')).toMatchObject({
      id: 'claude-code-runtime',
      status: { state: 'not-installed' },
      provided: { version: '2.1.285', active: true },
      update: { automatic: true, restartRequired: false },
    })
    expect(await runtimeAssetInfo('codex-runtime')).toMatchObject({
      provided: { version: '0.155.1', active: true },
      update: { automatic: true },
    })
    expect(await runtimeUpdates('claude-code-runtime').effectiveVersion()).toBe('2.1.285')
  })

  it('reports nothing provided when the image has no bundled Claude Code', async () => {
    state.bundledClaude = path.join(state.userData, 'missing-claude')
    expect(await imageRuntimeBaseline('claude-code-runtime')).toBeNull()
    expect(await runtimeAssetInfo('claude-code-runtime')).not.toHaveProperty('provided')
  })

  it('keeps a preference the bot owner stored over the bot default', async () => {
    await runtimeUpdates('claude-code-runtime').setAutomatic(false)
    resetRuntimeAssetAppServiceForTests()
    expect((await runtimeAssetInfo('claude-code-runtime')).update?.automatic).toBe(false)
  })

  it('schedules checks for both runtimes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const cycle = vi.spyOn(RuntimeUpdateController.prototype, 'cycle').mockResolvedValue()
    startRuntimeAssetUpdates()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(cycle).toHaveBeenCalledTimes(2)
  })

  it('does not schedule checks when the server turned bot runtime updates off', async () => {
    vi.stubEnv('MAESTRLY_BOT_RUNTIME_UPDATES', 'off')
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const cycle = vi.spyOn(RuntimeUpdateController.prototype, 'cycle').mockResolvedValue()
    startRuntimeAssetUpdates()
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000)
    expect(cycle).not.toHaveBeenCalled()
  })
})

describe('runtime asset app service on the desktop', () => {
  it('reports no provided runtime and keeps Codex notify-only', async () => {
    const info = await runtimeAssetInfo('codex-runtime')
    expect(info).not.toHaveProperty('provided')
    expect(info.update?.automatic).toBe(false)
    expect(await imageRuntimeBaseline('claude-code-runtime')).toBeNull()
  })

  it('never starts Claude Code updates and schedules nothing in an unpackaged build', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const start = vi.spyOn(RuntimeUpdateController.prototype, 'start')
    const cycle = vi.spyOn(RuntimeUpdateController.prototype, 'cycle').mockResolvedValue()
    startRuntimeAssetUpdates()
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.contexts[0]).toBe(runtimeUpdates('codex-runtime'))
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000)
    expect(cycle).not.toHaveBeenCalled()
  })
})
