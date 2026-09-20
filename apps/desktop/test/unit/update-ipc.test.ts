import { describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

const svc = vi.hoisted(() => ({
  getUpdateState: vi.fn(() => ({ phase: 'idle', mode: 'off', currentVersion: '1.0.0' })),
  checkForUpdates: vi.fn(async (o?: { ignoreSkip?: boolean }) => ({
    phase: 'idle',
    mode: 'off',
    currentVersion: '1.0.0',
    ignoreSkip: o?.ignoreSkip,
  })),
  downloadUpdate: vi.fn(async () => ({ phase: 'downloaded' })),
  installUpdate: vi.fn(),
  skipVersion: vi.fn(async () => ({ phase: 'idle' })),
  openRelease: vi.fn(async () => {}),
}))
vi.mock('../../src/main/update-service', () => svc)
import { registerUpdateIpc } from '../../src/main/update-ipc'

describe('registerUpdateIpc', () => {
  it('registers read state as handle and mutations as mhandle', async () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()
    registerUpdateIpc(reg)
    expect([...handles.keys()]).toEqual(['update:state'])
    expect([...mhandles.keys()].sort()).toEqual([
      'update:check',
      'update:download',
      'update:install',
      'update:open-release',
      'update:skip',
    ])
    expect(ons.size + mons.size).toBe(0)
    await mhandles.get('update:check')!({} as never, { ignoreSkip: true })
    expect(svc.checkForUpdates).toHaveBeenCalledWith({ ignoreSkip: true })
    await mhandles.get('update:check')!({} as never, 'garbage')
    expect(svc.checkForUpdates).toHaveBeenLastCalledWith({ ignoreSkip: false })
  })
})
