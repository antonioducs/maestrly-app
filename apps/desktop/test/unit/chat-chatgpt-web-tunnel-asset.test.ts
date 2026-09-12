import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  app: { isPackaged: true, getAppPath: vi.fn(() => '') },
  ensureRuntimeAsset: vi.fn(),
  readyRuntimeAsset: vi.fn(),
}))

vi.mock('electron', () => ({ app: h.app }))
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: h.ensureRuntimeAsset,
  readyRuntimeAsset: h.readyRuntimeAsset,
}))

import { prepareTunnelClient, tunnelClientBinPath } from '../../src/main/chat/chatgpt-web/tunnel-runtime'

const BIN_NAME = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'
const HOST_OS_DIR = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
let temporary = ''

describe('ChatGPT Web managed tunnel asset readiness', () => {
  beforeEach(async () => {
    h.app.isPackaged = true
    h.app.getAppPath.mockReturnValue('')
    h.ensureRuntimeAsset.mockReset()
    h.readyRuntimeAsset.mockReset()
    temporary = await mkdtemp(path.join(os.tmpdir(), 'tunnel-asset-'))
  })

  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true })
  })

  it('clears stale packaged readiness when the executable disappears or a probe fails', async () => {
    const binary = path.join(temporary, BIN_NAME)
    await writeFile(binary, 'binary')
    h.readyRuntimeAsset.mockResolvedValue({ path: temporary })

    await expect(prepareTunnelClient(false)).resolves.toBe(binary)
    expect(tunnelClientBinPath()).toBe(binary)

    await rm(binary)
    expect(tunnelClientBinPath()).toBeNull()

    h.readyRuntimeAsset.mockRejectedValue(new Error('component is corrupt'))
    await expect(prepareTunnelClient(false)).rejects.toThrow('component is corrupt')
    expect(tunnelClientBinPath()).toBeNull()
  })

  it('resolves a locally materialized host runtime in development', async () => {
    h.app.isPackaged = false
    h.app.getAppPath.mockReturnValue(temporary)
    const binary = path.join(temporary, 'resources', 'tunnel-client', `${HOST_OS_DIR}-${process.arch}`, BIN_NAME)
    await mkdir(path.dirname(binary), { recursive: true })
    await writeFile(binary, 'binary')

    expect(tunnelClientBinPath()).toBe(binary)
  })
})
