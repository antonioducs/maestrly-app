import {
  getAppFlag,
  setAppFlag,
  getAppSetting,
  setAppSetting,
  ONBOARDING_KEY,
  getFreeTerminalShell,
  setFreeTerminalShellSetting,
  getSoundSettings,
  setSoundSettings,
  getShortcutsConfig,
  setShortcutsConfig,
  getClosePopupShortcut,
  setClosePopupShortcut,
  getDrawerShortcut,
  setDrawerShortcut,
  getShortcutOpenMode,
  setShortcutOpenMode,
  type ShortcutOpenMode,
  getDefaultMainTabOrder,
  setDefaultMainTabOrder,
  getLocale,
  setLocaleSetting,
} from './store'
import { setActiveShortcuts, setActiveCloseShortcut, setActiveDrawerShortcut } from './hotkeys'
import { probeFreeTerminalShell, playSound } from './platform'
import { setMainLocale } from './i18n'

import { refreshFloatingTitles } from './floating-manager'
import { broadcast } from './window-ipc'
import {
  mergeShortcuts,
  osFromPlatform,
  type ShortcutsConfig,
  type EffectiveShortcuts,
  type ShortcutBinding,
  parseDrawerShortcut,
} from '../shared/shortcuts'
import { coerceSoundSettings, coerceVolume, SOUND_VOICES, type SoundSettings, type SoundVoice } from '../shared/sound'
import type { IpcRegistrar } from './ipc-registrar'
import type { ChatPermMode } from '../shared/chat'

export interface SettingsIpcDeps {
  applySoundSettings: (s: SoundSettings) => void
  isPreventSleepEnabled: () => boolean
  setPreventSleepEnabled: (enabled: boolean) => void
}

function effectiveShortcuts(): EffectiveShortcuts {
  return mergeShortcuts(osFromPlatform(process.platform), getShortcutsConfig())
}

function effectiveCloseShortcut(): ShortcutBinding {
  return getClosePopupShortcut(osFromPlatform(process.platform))
}
function effectiveDrawerShortcut(): ShortcutBinding {
  return getDrawerShortcut(osFromPlatform(process.platform))
}

export function reloadShortcuts(): void {
  setActiveShortcuts(effectiveShortcuts())
  setActiveCloseShortcut(effectiveCloseShortcut())
  setActiveDrawerShortcut(effectiveDrawerShortcut())
}

export function registerSettingsIpc(reg: IpcRegistrar, deps: SettingsIpcDeps): void {
  const permissionKey = 'chat.defaultPermissionMode'
  const getDefaultPermissionMode = (): ChatPermMode => {
    const current = getAppSetting(permissionKey)
    if (current === 'ask' || current === 'auto' || current === 'full') return current
    const migrated: ChatPermMode = getAppFlag('yoloMode', true) ? 'full' : 'ask'
    setAppSetting(permissionKey, migrated)
    return migrated
  }
  reg.handle('chat:default-permission-mode-get', getDefaultPermissionMode)
  reg.on('chat:default-permission-mode-set', (_e, mode: ChatPermMode) => {
    if (mode === 'ask' || mode === 'auto' || mode === 'full') setAppSetting(permissionKey, mode)
  })

  reg.handle('power:prevent-sleep-get', () => deps.isPreventSleepEnabled())
  reg.on('power:prevent-sleep-set', (_e, enabled: boolean) => deps.setPreventSleepEnabled(enabled))

  reg.handle('settings:onboarding-get', () => getAppFlag(ONBOARDING_KEY, false))
  reg.on('settings:onboarding-set', (_e, done: boolean) => setAppFlag(ONBOARDING_KEY, done))

  reg.handle('settings:free-terminal-shell-get', () => getFreeTerminalShell())
  reg.on('settings:free-terminal-shell-set', (_e, value: string) => setFreeTerminalShellSetting(value))
  reg.handle('settings:free-terminal-shell-test', (_e, value: string) => probeFreeTerminalShell(value))

  reg.handle('settings:sound-get', () => getSoundSettings())
  reg.on('settings:sound-set', (_e, s: SoundSettings) => {
    const next = coerceSoundSettings(s)
    setSoundSettings(next)
    deps.applySoundSettings(next)
  })
  reg.on('settings:sound-preview', (_e, voice: SoundVoice, volume?: number) => {
    if ((SOUND_VOICES as readonly string[]).includes(voice)) playSound(voice, coerceVolume(volume))
  })

  const shortcutsState = () => ({
    os: osFromPlatform(process.platform),
    shortcuts: effectiveShortcuts(),
    close: effectiveCloseShortcut(),
    drawer: effectiveDrawerShortcut(),
    openMode: getShortcutOpenMode(),
  })
  reg.handle('settings:shortcuts-get', () => shortcutsState())
  reg.on('settings:shortcuts-set', (_e, overrides: ShortcutsConfig) => {
    setShortcutsConfig(overrides)
    reloadShortcuts() // Apply the new bindings to native keyboard capture.
    broadcast('settings:shortcuts-changed', shortcutsState())
  })

  reg.on('settings:close-shortcut-set', (_e, binding: ShortcutBinding) => {
    setClosePopupShortcut({ key: 'escape', mods: Array.isArray(binding?.mods) ? binding.mods : [] })
    reloadShortcuts()
    broadcast('settings:shortcuts-changed', shortcutsState())
  })
  reg.on('settings:drawer-shortcut-set', (_e, binding: ShortcutBinding) => {
    setDrawerShortcut(parseDrawerShortcut(binding, osFromPlatform(process.platform)))
    reloadShortcuts()
    broadcast('settings:shortcuts-changed', shortcutsState())
  })

  reg.on('settings:shortcut-open-mode-set', (_e, mode: ShortcutOpenMode) => {
    setShortcutOpenMode(mode === 'floating' ? 'floating' : 'popup')
    broadcast('settings:shortcuts-changed', shortcutsState())
  })

  reg.handle('settings:default-main-tab-order-get', () => getDefaultMainTabOrder())
  reg.on('settings:default-main-tab-order-set', (_e, order: string[]) => {
    if (Array.isArray(order)) setDefaultMainTabOrder(order.filter((t): t is string => typeof t === 'string'))
  })

  reg.handle('settings:locale-get', () => getLocale())
  reg.on('settings:locale-set', (_e, value: string) => {
    const locale = setLocaleSetting(value)
    setMainLocale(locale)
    refreshFloatingTitles()
    broadcast('settings:locale-changed', locale)
  })
}
