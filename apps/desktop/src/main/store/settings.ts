import { coerceLocale, normalizeOsLocale, DEFAULT_LOCALE, type SupportedLocale } from '../../shared/locale'
import { coerceSoundSettings, type SoundSettings } from '../../shared/sound'
import {
  parseShortcuts,
  defaultClosePopup,
  parseClosePopup,
  defaultDrawerShortcut,
  parseDrawerShortcut,
  type ShortcutsConfig,
  type ShortcutBinding,
  type ShortcutOs,
} from '../../shared/shortcuts'
import { getDb } from './db'
import { setAppFlag, getAppSetting, setAppSetting } from './app-settings'

// Preferred cross-platform drawer shell terminal (#167).

/** Preferred drawer-shell setting key. */
export const FREE_TERMINAL_SHELL_KEY = 'freeTerminalShell'

/**
 * Preferred shell: auto, cmd, powershell, pwsh, git-bash, or custom path. auto follows the OS;
 * platform.freeTerminalShell interprets it.
 */
export function getFreeTerminalShell(): string {
  return getAppSetting(FREE_TERMINAL_SHELL_KEY) ?? 'auto'
}

/** Persist preferred drawer shell. */
export function setFreeTerminalShellSetting(value: string): void {
  setAppSetting(FREE_TERMINAL_SHELL_KEY, value)
}

// ---- alert sounds: per-event voice and global mute (#315) ----

/** Alert-sound configuration setting key. */
export const SOUND_SETTINGS_KEY = 'soundSettings'

/**
 * Defensively parse sound settings; missing, invalid, or partial values use defaults. Sound
 * configuration must never break startup.
 */
export function getSoundSettings(): SoundSettings {
  const raw = getAppSetting(SOUND_SETTINGS_KEY)
  if (raw == null) return coerceSoundSettings(undefined)
  try {
    return coerceSoundSettings(JSON.parse(raw))
  } catch {
    return coerceSoundSettings(undefined)
  }
}

/** Upsert sound configuration JSON. */
export function setSoundSettings(value: SoundSettings): void {
  setAppSetting(SOUND_SETTINGS_KEY, JSON.stringify(value))
}

// Tool popup shortcuts (#328).

/** Shortcut override JSON key; missing overrides use OS defaults. */
export const SHORTCUTS_KEY = 'shortcuts.config'

/**
 * Defensively parse shortcut overrides to an empty object on failure. The caller merges platform
 * defaults.
 */
export function getShortcutsConfig(): ShortcutsConfig {
  const raw = getAppSetting(SHORTCUTS_KEY)
  if (raw == null) return {}
  try {
    return parseShortcuts(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** Upsert shortcut overrides already validated through parseShortcuts. */
export function setShortcutsConfig(value: ShortcutsConfig): void {
  setAppSetting(SHORTCUTS_KEY, JSON.stringify(value))
}

export const CLOSE_POPUP_KEY = 'shortcuts.closePopup'

/** Popup close binding; missing/invalid values use OS defaults parsed by the caller. */
export function getClosePopupShortcut(os: ShortcutOs): ShortcutBinding {
  const raw = getAppSetting(CLOSE_POPUP_KEY)
  if (raw == null) return defaultClosePopup(os)
  try {
    return parseClosePopup(JSON.parse(raw), os)
  } catch {
    return defaultClosePopup(os)
  }
}

/** Persist close modifiers; the key remains Escape. */
export function setClosePopupShortcut(binding: ShortcutBinding): void {
  setAppSetting(CLOSE_POPUP_KEY, JSON.stringify({ key: 'escape', mods: binding.mods }))
}

export const DRAWER_SHORTCUT_KEY = 'shortcuts.toggleDrawer'

/** Drawer toggle binding; missing/invalid values use the platform default. */
export function getDrawerShortcut(os: ShortcutOs): ShortcutBinding {
  const raw = getAppSetting(DRAWER_SHORTCUT_KEY)
  if (raw == null) return defaultDrawerShortcut(os)
  try {
    return parseDrawerShortcut(JSON.parse(raw), os)
  } catch {
    return defaultDrawerShortcut(os)
  }
}

export function setDrawerShortcut(binding: ShortcutBinding): void {
  setAppSetting(DRAWER_SHORTCUT_KEY, JSON.stringify(binding))
}

export const SHORTCUT_OPEN_MODE_KEY = 'shortcuts.openMode'
export type ShortcutOpenMode = 'popup' | 'floating'

/** Tool shortcuts open centered popups by default or native floating windows. */
export function getShortcutOpenMode(): ShortcutOpenMode {
  return getAppSetting(SHORTCUT_OPEN_MODE_KEY) === 'floating' ? 'floating' : 'popup'
}
export function setShortcutOpenMode(mode: ShortcutOpenMode): void {
  setAppSetting(SHORTCUT_OPEN_MODE_KEY, mode === 'floating' ? 'floating' : 'popup')
}

// ---- provider model visibility filters for the Chat selector ----

/** Store hidden model IDs by provider so newly introduced models remain visible by default. */
export const CHAT_HIDDEN_MODELS_KEY = 'chat.hiddenModels'

/** Defensively parse provider-to-hidden-model lists; missing/invalid data means nothing hidden. */
export function getHiddenChatModels(): Record<string, string[]> {
  const raw = getAppSetting(CHAT_HIDDEN_MODELS_KEY)
  if (raw == null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!providerId || !Array.isArray(value)) continue
      const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
      if (ids.length > 0) out[providerId] = [...new Set(ids)]
    }
    return out
  } catch {
    return {}
  }
}

/** Hidden models for one provider; empty means unfiltered. */
export function getHiddenChatModelsFor(providerId: string): string[] {
  return getHiddenChatModels()[providerId] ?? []
}

/** Persist one provider's hidden models. Empty removes the entry and also supports provider cleanup. */
export function setHiddenChatModels(providerId: string, hidden: readonly string[]): void {
  if (typeof providerId !== 'string' || !providerId) return
  const map = getHiddenChatModels()
  const ids = [...new Set((hidden ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (ids.length > 0) map[providerId] = ids
  else delete map[providerId]
  setAppSetting(CHAT_HIDDEN_MODELS_KEY, JSON.stringify(map))
}

// ---- global app locale (#114) ----

/** Global locale setting key shared by renderer, main, MCP, and prompts. */
export const LOCALE_KEY = 'locale'

/**
 * Persisted global supported locale, default English. If store is not initialized, return English so
 * pure prompt/dialog construction remains usable in tests.
 */
export function getLocale(): SupportedLocale {
  try {
    return coerceLocale(getAppSetting(LOCALE_KEY))
  } catch {
    return DEFAULT_LOCALE
  }
}

/** Normalize, validate, and persist global locale; return the stored value. */
export function setLocaleSetting(value: string): SupportedLocale {
  const locale = coerceLocale(value)
  setAppSetting(LOCALE_KEY, locale)
  return locale
}

/**
 * On first run only, derive locale from caller-supplied OS locale: pt variants become pt-BR and others
 * become English. Preserve any existing user choice; the injected OS value keeps store tests
 * independent of Electron.
 */
export function initLocaleOnFirstRun(osLocale: string): void {
  if (getAppSetting(LOCALE_KEY) !== null) return // already decided by the user or an earlier first run
  setAppSetting(LOCALE_KEY, normalizeOsLocale(osLocale))
}

// ---- onboarding / first-run (#145) ----

/** Welcome-tour completed/skipped flag. */
export const ONBOARDING_KEY = 'onboarding.completed'

/**
 * Idempotently backfill onboarding completion for existing databases with workspaces and no flag,
 * preventing upgrade-time onboarding. Fresh empty stores leave it absent so onboarding appears. Never
 * overwrite an existing decision.
 */
export function initOnboardingFlag(): void {
  if (getAppSetting(ONBOARDING_KEY) !== null) return // already decided by the user or an earlier backfill
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }
  if (row.n > 0) setAppFlag(ONBOARDING_KEY, true)
}

// Global default drawer-tab order applied only to new conversations (#319).

/** Default drawer-tab order JSON setting key. */
export const DEFAULT_MAIN_TAB_ORDER_KEY = 'defaultMainTabOrder'

/**
 * Global tab order or null if unconfigured/invalid. Do not throw; per-conversation sanitizeMainOrder
 * validates keys against the canonical tab list during hydration.
 */
export function getDefaultMainTabOrder(): string[] | null {
  const raw = getAppSetting(DEFAULT_MAIN_TAB_ORDER_KEY)
  if (raw == null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) return parsed as string[]
  } catch {
    /* Corrupt JSON is treated as unconfigured. */
  }
  return null
}

/** Upsert global default drawer-tab order JSON. */
export function setDefaultMainTabOrder(order: string[]): void {
  setAppSetting(DEFAULT_MAIN_TAB_ORDER_KEY, JSON.stringify(order))
}
