import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The channel profile folder is created only outside E2E: a test run keeps every write inside AGENTS_USERDATA. */
describe('applyChannelIdentity', () => {
  let root = ''
  let appData = ''

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'channel-identity-'))
    appData = path.join(root, 'appData')
    // channel.ts caches the resolved channel, so every case loads it, and the Electron stub it uses, afresh.
    vi.resetModules()
    vi.stubEnv('AGENTS_CHANNEL', 'dev')
    vi.stubEnv('AGENTS_INSTANCE', 'workspace-1792000000000')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  async function load() {
    const { app } = await import('electron')
    vi.spyOn(app, 'getPath').mockImplementation((name: string) => (name === 'appData' ? appData : root))
    const setPath = vi.spyOn(app, 'setPath')
    const { applyChannelIdentity } = await import('../../src/main/channel')
    return { applyChannelIdentity, setPath }
  }

  it('leaves the channel profile alone in an E2E run and uses its isolated userData', async () => {
    const e2e = path.join(root, 'e2e-user-data')
    vi.stubEnv('AGENTS_E2E', '1')
    vi.stubEnv('AGENTS_USERDATA', e2e)
    const { applyChannelIdentity, setPath } = await load()

    applyChannelIdentity()

    expect(existsSync(path.join(appData, 'maestrly-app-dev-workspace-1792000000000'))).toBe(false)
    expect(existsSync(appData) ? readdirSync(appData) : []).toEqual([])
    expect(existsSync(e2e)).toBe(true)
    expect(setPath.mock.calls).toEqual([['userData', e2e]])
  })

  it('still validates the instance id in an E2E run', async () => {
    vi.stubEnv('AGENTS_E2E', '1')
    vi.stubEnv('AGENTS_USERDATA', path.join(root, 'e2e-user-data'))
    vi.stubEnv('AGENTS_INSTANCE', '../escape')
    const { applyChannelIdentity } = await load()

    expect(() => applyChannelIdentity()).toThrow('Invalid AGENTS_INSTANCE')
  })

  it('creates and selects the instance profile outside E2E', async () => {
    vi.stubEnv('AGENTS_E2E', '')
    const { applyChannelIdentity, setPath } = await load()

    applyChannelIdentity()

    const profile = path.join(appData, 'maestrly-app-dev-workspace-1792000000000')
    expect(existsSync(profile)).toBe(true)
    expect(setPath.mock.calls).toEqual([['userData', profile]])
  })
})
