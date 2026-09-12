import { ipcRenderer } from 'electron'
import type { ShortcutBinding, ShortcutsConfig, ShortcutOs, EffectiveShortcuts } from '../shared/shortcuts'
import type { SupportedLocale } from '../shared/locale'
import type { SoundSettings, SoundVoice } from '../shared/sound'
import type { ChatPermMode } from '../shared/chat'

export type ShortcutOpenMode = 'popup' | 'floating'

export interface ShortcutsState {
  os: ShortcutOs
  shortcuts: EffectiveShortcuts
  /** Shortcut to close the central popup (Escape plus modifiers; default ⌃+Esc). */
  close: ShortcutBinding
  /** Shortcut to toggle the docked drawer. */
  drawer: ShortcutBinding

  openMode: ShortcutOpenMode
}

export const settingsApi = {
  getPreventSleepEnabled: (): Promise<boolean> => ipcRenderer.invoke('power:prevent-sleep-get'),
  setPreventSleepEnabled: (enabled: boolean): void => ipcRenderer.send('power:prevent-sleep-set', enabled),

  getDefaultPermissionMode: (): Promise<ChatPermMode> => ipcRenderer.invoke('chat:default-permission-mode-get'),
  setDefaultPermissionMode: (mode: ChatPermMode): void => ipcRenderer.send('chat:default-permission-mode-set', mode),

  getOnboardingDone: (): Promise<boolean> => ipcRenderer.invoke('settings:onboarding-get'),

  setOnboardingDone: (done: boolean): void => ipcRenderer.send('settings:onboarding-set', done),

  getFreeTerminalShell: (): Promise<string> => ipcRenderer.invoke('settings:free-terminal-shell-get'),

  setFreeTerminalShell: (value: string): void => ipcRenderer.send('settings:free-terminal-shell-set', value),

  testFreeTerminalShell: (value: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:free-terminal-shell-test', value),

  getSoundSettings: (): Promise<SoundSettings> => ipcRenderer.invoke('settings:sound-get'),

  setSoundSettings: (settings: SoundSettings): void => ipcRenderer.send('settings:sound-set', settings),

  previewSound: (voice: SoundVoice, volume = 1): void => ipcRenderer.send('settings:sound-preview', voice, volume),

  getShortcuts: (): Promise<ShortcutsState> => ipcRenderer.invoke('settings:shortcuts-get'),

  setShortcuts: (overrides: ShortcutsConfig): void => ipcRenderer.send('settings:shortcuts-set', overrides),

  setCloseShortcut: (binding: ShortcutBinding): void => ipcRenderer.send('settings:close-shortcut-set', binding),

  setDrawerShortcut: (binding: ShortcutBinding): void => ipcRenderer.send('settings:drawer-shortcut-set', binding),

  setShortcutOpenMode: (mode: ShortcutOpenMode): void => ipcRenderer.send('settings:shortcut-open-mode-set', mode),

  onShortcutsChanged: (cb: (s: ShortcutsState) => void): (() => void) => {
    const listener = (_e: unknown, s: ShortcutsState) => cb(s)
    ipcRenderer.on('settings:shortcuts-changed', listener)
    return () => ipcRenderer.removeListener('settings:shortcuts-changed', listener)
  },

  getDefaultMainTabOrder: (): Promise<string[] | null> => ipcRenderer.invoke('settings:default-main-tab-order-get'),

  setDefaultMainTabOrder: (order: string[]): void => ipcRenderer.send('settings:default-main-tab-order-set', order),

  getLocale: (): Promise<SupportedLocale> => ipcRenderer.invoke('settings:locale-get'),

  setLocale: (value: SupportedLocale): void => ipcRenderer.send('settings:locale-set', value),

  onLocaleChanged: (cb: (locale: SupportedLocale) => void): (() => void) => {
    const listener = (_e: unknown, locale: SupportedLocale) => cb(locale)
    ipcRenderer.on('settings:locale-changed', listener)
    return () => ipcRenderer.removeListener('settings:locale-changed', listener)
  },
}
