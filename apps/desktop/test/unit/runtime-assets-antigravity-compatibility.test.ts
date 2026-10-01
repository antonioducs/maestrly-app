import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateAntigravityRuntime } from '../../src/main/runtime-assets/antigravity-compatibility'
import { RUNTIME_ASSET_REGISTRY } from '../../src/main/runtime-assets/registry'

let installation: string
beforeEach(async () => {
  installation = await mkdtemp(path.join(os.tmpdir(), 'agy-compatibility-'))
  for (const name of ['agy_acp_server.par', 'localharness_external'])
    await writeFile(path.join(installation, name), 'fixture', { mode: 0o700 })
})
afterEach(async () => {
  await rm(installation, { recursive: true, force: true })
})
const definition = RUNTIME_ASSET_REGISTRY['antigravity-acp-runtime']
const initialize = {
  protocolVersion: 1,
  agentInfo: { name: 'antigravity-acp', version: '1.2.1' },
  authMethods: [{ id: 'oauth-personal', name: 'Google' }],
  agentCapabilities: {
    promptCapabilities: { image: true },
    mcpCapabilities: { http: true },
    sessionCapabilities: { resume: {} },
  },
}

describe('Antigravity isolated compatibility gate', () => {
  it('uses a fresh credential-free home and scratch cwd, closes the process and removes its state', async () => {
    const close = vi.fn(async () => undefined)
    let temporary = ''
    const start = vi.fn(async (options) => {
      temporary = path.dirname(options.cwd)
      expect(options.cwd).not.toBe(installation)
      expect(options.env.HOME).toBe(path.join(temporary, 'home'))
      expect(options.env.GEMINI_HOME).toBe(path.join(temporary, 'home', '.gemini'))
      expect(options.env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
      for (const key of ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'HTTPS_PROXY', 'DISPLAY'])
        expect(options.env[key]).toBeUndefined()
      expect(options.args).toEqual(['--uid='])
      await mkdir(options.env.GEMINI_HOME, { recursive: true })
      await writeFile(path.join(options.env.GEMINI_HOME, 'probe'), 'synthetic state')
      return { client: { close }, initialize }
    })
    await validateAntigravityRuntime(installation, definition, new AbortController().signal, {
      target: 'linux-x64',
      start,
      inheritedEnv: {
        HOME: '/personal',
        GEMINI_HOME: '/credentials',
        GOOGLE_API_KEY: 'synthetic',
        GOOGLE_APPLICATION_CREDENTIALS: '/credentials/key',
        NODE_OPTIONS: '--require=unsafe',
        HTTPS_PROXY: 'http://proxy',
        DISPLAY: ':0',
      },
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(1000)
    await expect(access(temporary)).rejects.toThrow()
  })
  it.each([
    { ...initialize, protocolVersion: 2 },
    { ...initialize, agentInfo: { name: 'antigravity-acp', version: '1.2.2' } },
    { ...initialize, agentCapabilities: {} },
    { ...initialize, authMethods: [] },
    { ...initialize, agentCapabilities: { ...initialize.agentCapabilities, sessionCapabilities: {} } },
    { ...initialize, agentCapabilities: { promptCapabilities: { image: true }, mcpCapabilities: { http: false } } },
  ])('rejects incompatible initialize responses and closes the process', async (result) => {
    const close = vi.fn(async () => undefined)
    await expect(
      validateAntigravityRuntime(installation, definition, new AbortController().signal, {
        target: 'mac-arm64',
        start: async () => ({ client: { close }, initialize: result }),
      })
    ).rejects.toThrow(/Incompatible/)
    expect(close).toHaveBeenCalled()
  })
  it('rejects a missing or non-executable helper before launching', async () => {
    const start = vi.fn()
    await rm(path.join(installation, 'localharness_external'))
    await expect(
      validateAntigravityRuntime(installation, definition, new AbortController().signal, { target: 'mac-arm64', start })
    ).rejects.toThrow()
    if (process.platform !== 'win32') {
      await writeFile(path.join(installation, 'localharness_external'), 'fixture')
      await chmod(path.join(installation, 'localharness_external'), 0o600)
      await expect(
        validateAntigravityRuntime(installation, definition, new AbortController().signal, {
          target: 'mac-arm64',
          start,
        })
      ).rejects.toThrow()
    }
    expect(start).not.toHaveBeenCalled()
  })
  it('passes timeout and caller cancellation to the handshake and cleans up', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController()
      let cwd = ''
      const pending = validateAntigravityRuntime(installation, definition, controller.signal, {
        target: 'mac-arm64',
        timeoutMs: 20,
        start: async (options, signal) => {
          cwd = options.cwd
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            if (cancel) controller.abort(new Error('cancelled'))
          })
        },
      })
      await expect(pending).rejects.toThrow()
      await expect(access(path.dirname(cwd))).rejects.toThrow()
    }
  })
})
