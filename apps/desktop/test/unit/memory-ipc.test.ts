import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { onPersonalMemorySettingsChanged } from '../../src/main/memory/personal-memory-settings'
import { registerPanelTarget, setBroadcastMainWindow, unregisterPanelTarget } from '../../src/main/window-ipc'
import { createTestRegistrar } from './ipc-registrar-test-utils'

vi.mock('electron', async (importOriginal) => {
  const electron = await importOriginal<typeof import('electron')>()
  return { ...electron, BrowserWindow: { getAllWindows: vi.fn(() => []) } }
})

vi.mock('../../src/main/memory/personal-memory-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/memory/personal-memory-settings')>()),
  onPersonalMemorySettingsChanged: vi.fn(),
}))

vi.mock('../../src/main/memory-service', () => ({
  readMemory: vi.fn(),
  watchMemory: vi.fn(),
  writeMemory: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  getMemoryEnabled: vi.fn(),
  setMemoryEnabled: vi.fn(),
}))

import { registerMemoryIpc } from '../../src/main/memory-ipc'

describe('registerMemoryIpc', () => {
  afterEach(() => {
    setBroadcastMainWindow(null)
    vi.clearAllMocks()
  })

  it('delivers personal settings through trusted renderers without exposing them to other windows', () => {
    const contents = () => ({ send: vi.fn(), isDestroyed: () => false, once: vi.fn() })
    const main = { webContents: contents(), isDestroyed: () => false }
    // Detached chats retain the main renderer's subscriptions; their blank windows have no preload.
    const detached = { webContents: contents(), isDestroyed: () => false }
    const unrelated = { webContents: contents(), isDestroyed: () => false }
    const globalTarget = contents()
    const scopedPanel = contents()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([main, detached, unrelated] as never)
    setBroadcastMainWindow(main as never)
    registerPanelTarget(globalTarget as never, { global: true })
    registerPanelTarget(scopedPanel as never, { convId: 'synthetic-conversation', panel: 'terminal' })
    try {
      const { reg } = createTestRegistrar()
      registerMemoryIpc(reg)
      const notify = vi.mocked(onPersonalMemorySettingsChanged).mock.calls.at(-1)![0]
      const settings = { enabled: false, autoRecall: false, extraction: { enabled: false, selection: null } }
      notify(settings)
      expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith('personal-memory:settings-changed', settings)
      expect(globalTarget.send).toHaveBeenCalledExactlyOnceWith('personal-memory:settings-changed', settings)
      expect(detached.webContents.send).not.toHaveBeenCalled()
      expect(unrelated.webContents.send).not.toHaveBeenCalled()
      expect(scopedPanel.send).not.toHaveBeenCalled()
    } finally {
      unregisterPanelTarget(globalTarget as never)
      unregisterPanelTarget(scopedPanel as never)
    }
  })

  it('validates personal settings before writing them', () => {
    const { reg, mhandles } = createTestRegistrar()
    registerMemoryIpc(reg)
    const set = mhandles.get('personal-memory:settings-set')!
    expect(() => set({} as never, { enabled: 'yes' })).toThrow('Invalid personal memory settings')
    expect(() =>
      set({} as never, { enabled: true, autoRecall: true, extraction: { enabled: true, selection: null } })
    ).toThrow('memory-model-required')
  })

  it('registers memory channels with the expected registrars', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerMemoryIpc(reg)

    expect([...handles.keys()].sort()).toEqual([
      'memory:enabled-get',
      'memory:export',
      'memory:get',
      'memory:index-status-get',
      'memory:legacy-backups',
      'memory:list',
      'memory:promotion-preview',
      'memory:read',
      'memory:search',
      'memory:shared-list',
      'personal-memory:export',
      'personal-memory:get',
      'personal-memory:index-status-get',
      'personal-memory:list',
      'personal-memory:search',
      'personal-memory:settings-get',
    ])
    expect([...mhandles.keys()].sort()).toEqual([
      'memory:archive',
      'memory:create',
      'memory:forget',
      'memory:index-rebuild',
      'memory:legacy-backup-remove',
      'memory:promote',
      'memory:restore',
      'memory:shared-open',
      'memory:update',
      'personal-memory:archive',
      'personal-memory:create',
      'personal-memory:forget',
      'personal-memory:index-rebuild',
      'personal-memory:restore',
      'personal-memory:settings-set',
      'personal-memory:update',
    ])
    expect([...ons.keys()]).toEqual([])
    expect([...mons.keys()].sort()).toEqual(['memory:enabled-set', 'memory:write'])
  })
})
