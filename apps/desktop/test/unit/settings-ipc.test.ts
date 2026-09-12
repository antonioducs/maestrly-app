import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

vi.mock('../../src/main/store', () => ({
  getAppFlag: vi.fn(),
  setAppFlag: vi.fn(),
  ONBOARDING_KEY: 'onboarding',
  getDiagnosticsPromptSeen: vi.fn(),
  setDiagnosticsPromptSeen: vi.fn(),
  getFreeTerminalShell: vi.fn(),
  setFreeTerminalShellSetting: vi.fn(),
  getSoundSettings: vi.fn(),
  setSoundSettings: vi.fn(),
  getShortcutsConfig: vi.fn(),
  setShortcutsConfig: vi.fn(),
  getClosePopupShortcut: vi.fn(),
  setClosePopupShortcut: vi.fn(),
  getDrawerShortcut: vi.fn(() => ({ key: 'd', mods: ['meta', 'control'] })),
  setDrawerShortcut: vi.fn(),
  getShortcutOpenMode: vi.fn(),
  setShortcutOpenMode: vi.fn(),
  getHandoffSettings: vi.fn(),
  setHandoffSettings: vi.fn(),
  getDelegateTimeouts: vi.fn(),
  setDelegateTimeouts: vi.fn(),
  getDefaultMainTabOrder: vi.fn(),
  setDefaultMainTabOrder: vi.fn(),
  getLocale: vi.fn(),
  setLocaleSetting: vi.fn(),
}))

vi.mock('../../src/main/hotkeys', () => ({
  setActiveShortcuts: vi.fn(),
  setActiveCloseShortcut: vi.fn(),
  setActiveDrawerShortcut: vi.fn(),
}))

vi.mock('../../src/main/platform', () => ({
  probeFreeTerminalShell: vi.fn(),
  playSound: vi.fn(),
}))

vi.mock('../../src/main/i18n', () => ({
  setMainLocale: vi.fn(),
}))


vi.mock('../../src/main/floating-manager', () => ({
  refreshFloatingTitles: vi.fn(),
}))

vi.mock('../../src/main/window-ipc', () => ({
  broadcast: vi.fn(),
}))

import { playSound } from '../../src/main/platform'
import { setSoundSettings } from '../../src/main/store'
import { registerSettingsIpc } from '../../src/main/settings-ipc'
import { DEFAULT_SOUND_SETTINGS } from '../../src/shared/sound'

function setup() {
  const registrar = createTestRegistrar()
  const deps = {
    getYoloEnabled: vi.fn(),
    setYoloEnabled: vi.fn(),
    applySoundSettings: vi.fn(),
    isPreventSleepEnabled: vi.fn(),
    setPreventSleepEnabled: vi.fn(),
  }
  registerSettingsIpc(registrar.reg, deps)
  return { ...registrar, deps }
}

beforeEach(() => vi.clearAllMocks())

describe('registerSettingsIpc', () => {
  it('keeps power:prevent-sleep in the settings registrars', () => {
    const { handles, ons } = setup()
    expect(handles.has('power:prevent-sleep-get')).toBe(true)
    expect(ons.has('power:prevent-sleep-set')).toBe(true)
  })

  it('valid previews use the runtime facade with coerced volume', () => {
    const { ons } = setup()
    ons.get('settings:sound-preview')!({} as never, 'glass', 2)
    ons.get('settings:sound-preview')!({} as never, 'ping', -1)
    expect(playSound).toHaveBeenNthCalledWith(1, 'glass', 1)
    expect(playSound).toHaveBeenNthCalledWith(2, 'ping', 0)
  })

  it('ignores invalid previews and normalizes raw settings before persistence/application', () => {
    const { ons, deps } = setup()
    ons.get('settings:sound-preview')!({} as never, 'nope', 1)
    expect(playSound).not.toHaveBeenCalled()

    ons.get('settings:sound-set')!({} as never, { events: { ready: 'nope', plan: 'tink' } })
    expect(setSoundSettings).toHaveBeenCalledWith({
      ...DEFAULT_SOUND_SETTINGS,
      events: { ...DEFAULT_SOUND_SETTINGS.events, plan: 'tink' },
    })
    expect(deps.applySoundSettings).toHaveBeenCalledWith({
      ...DEFAULT_SOUND_SETTINGS,
      events: { ...DEFAULT_SOUND_SETTINGS.events, plan: 'tink' },
    })
  })
})
