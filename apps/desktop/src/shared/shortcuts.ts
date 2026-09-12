import { FLOAT_TABS, type FloatTab } from './tool-tabs'

export type ShortcutMod = 'meta' | 'control' | 'alt' | 'shift'
const MOD_ORDER: ShortcutMod[] = ['meta', 'control', 'alt', 'shift']
const MOD_SET = new Set<ShortcutMod>(MOD_ORDER)

/** Normalized OS for shortcut defaults (macOS uses ⌘⌃; Windows/Linux use Ctrl+Alt). */
export type ShortcutOs = 'mac' | 'win' | 'linux'

export interface ShortcutBinding {
  key: string
  mods: ShortcutMod[]
}

export type ShortcutsConfig = Partial<Record<FloatTab, ShortcutBinding | null>>

export type EffectiveShortcuts = Record<FloatTab, ShortcutBinding | null>

export interface KeyEventLike {
  key?: string
  code?: string
  meta?: boolean
  control?: boolean
  alt?: boolean
  shift?: boolean
}

/** Maps process.platform to the normalized OS. */
export function osFromPlatform(platform: string): ShortcutOs {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'win'
  return 'linux'
}

const DEFAULT_KEYS: Record<FloatTab, string> = {
  browser: 'b',
  vscode: 'e',
  terminal: 'j',
  plan: 'p',
  review: 'r',
  notes: 'n',
  chatgpt: 'g',
}

function defaultMods(os: ShortcutOs): ShortcutMod[] {
  return os === 'mac' ? ['meta', 'control'] : ['control', 'alt']
}

export function defaultShortcuts(os: ShortcutOs): EffectiveShortcuts {
  const mods = defaultMods(os)
  const out = {} as EffectiveShortcuts
  for (const tab of FLOAT_TABS) out[tab] = { key: DEFAULT_KEYS[tab], mods: [...mods] }
  return out
}

export function defaultDrawerShortcut(os: ShortcutOs): ShortcutBinding {
  return { key: 'd', mods: [...defaultMods(os)] }
}

function normMods(mods: unknown): ShortcutMod[] {
  if (!Array.isArray(mods)) return []
  const present = new Set<ShortcutMod>()
  for (const m of mods) if (typeof m === 'string' && MOD_SET.has(m as ShortcutMod)) present.add(m as ShortcutMod)
  return MOD_ORDER.filter((m) => present.has(m))
}

function normBinding(raw: unknown): ShortcutBinding | null {
  if (!raw || typeof raw !== 'object') return null
  const key = (raw as { key?: unknown }).key
  if (typeof key !== 'string' || key.length === 0) return null
  return { key: key.toLowerCase(), mods: normMods((raw as { mods?: unknown }).mods) }
}

export function parseDrawerShortcut(raw: unknown, os: ShortcutOs): ShortcutBinding {
  const binding = normBinding(raw)
  return binding && isValidBinding(binding) ? binding : defaultDrawerShortcut(os)
}

export function parseShortcuts(raw: unknown): ShortcutsConfig {
  if (!raw || typeof raw !== 'object') return {}
  const out: ShortcutsConfig = {}
  for (const tab of FLOAT_TABS) {
    if (!(tab in (raw as Record<string, unknown>))) continue
    const v = (raw as Record<string, unknown>)[tab]
    if (v === null) {
      out[tab] = null
      continue
    }
    const b = normBinding(v)
    if (b) out[tab] = b
  }
  return out
}

export function mergeShortcuts(os: ShortcutOs, overrides: ShortcutsConfig | undefined): EffectiveShortcuts {
  const base = defaultShortcuts(os)
  if (!overrides) return base
  for (const tab of FLOAT_TABS) {
    if (!(tab in overrides)) continue
    base[tab] = overrides[tab] ?? null
  }
  return base
}

export function eventKey(e: KeyEventLike): string {
  const code = e.code ?? ''
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase()
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  const k = e.key ?? ''
  if (k.length === 1) return k.toLowerCase()
  return ''
}

function modsMatch(e: KeyEventLike, mods: ShortcutMod[]): boolean {
  const need = new Set(mods)
  return (
    !!e.meta === need.has('meta') &&
    !!e.control === need.has('control') &&
    !!e.alt === need.has('alt') &&
    !!e.shift === need.has('shift')
  )
}

export function bindingMatchesEvent(binding: ShortcutBinding | null, e: KeyEventLike): boolean {
  if (!binding) return false
  if (binding.key.toLowerCase() !== eventKey(e)) return false
  return modsMatch(e, binding.mods)
}

export function matchShortcut(e: KeyEventLike, effective: EffectiveShortcuts): FloatTab | null {
  for (const tab of FLOAT_TABS) {
    if (bindingMatchesEvent(effective[tab], e)) return tab
  }
  return null
}

export function detachVariant(binding: ShortcutBinding | null): ShortcutBinding | null {
  if (!binding || binding.mods.includes('shift')) return null
  return { key: binding.key, mods: [...binding.mods, 'shift'] }
}

export function matchDetachShortcut(e: KeyEventLike, effective: EffectiveShortcuts): FloatTab | null {
  for (const tab of FLOAT_TABS) {
    if (bindingMatchesEvent(detachVariant(effective[tab]), e)) return tab
  }
  return null
}

export function bindingKey(binding: ShortcutBinding): string {
  return `${[...binding.mods].sort().join('+')}|${binding.key.toLowerCase()}`
}

export function findConflicts(effective: EffectiveShortcuts): FloatTab[][] {
  const byCombo = new Map<string, FloatTab[]>()
  for (const tab of FLOAT_TABS) {
    const b = effective[tab]
    if (!b) continue
    const k = bindingKey(b)
    const arr = byCombo.get(k)
    if (arr) arr.push(tab)
    else byCombo.set(k, [tab])
  }
  return [...byCombo.values()].filter((g) => g.length > 1)
}

export function conflictingTabs(effective: EffectiveShortcuts): Set<FloatTab> {
  const out = new Set<FloatTab>()
  for (const group of findConflicts(effective)) for (const tab of group) out.add(tab)
  return out
}

export function isValidBinding(binding: ShortcutBinding): boolean {
  return binding.key.length > 0 && binding.mods.length >= 2
}

const MAC_SYMBOL: Record<ShortcutMod, string> = { meta: '⌘', control: '⌃', alt: '⌥', shift: '⇧' }
const PC_LABEL: Record<ShortcutMod, string> = { meta: 'Win', control: 'Ctrl', alt: 'Alt', shift: 'Shift' }

const KEY_LABEL: Record<string, string> = { escape: 'Esc' }

export function formatAccelerator(binding: ShortcutBinding, os: ShortcutOs): string {
  const ordered = MOD_ORDER.filter((m) => binding.mods.includes(m))
  const key = KEY_LABEL[binding.key] ?? binding.key.toUpperCase()
  if (os === 'mac') return ordered.map((m) => MAC_SYMBOL[m]).join('') + key
  return [...ordered.map((m) => PC_LABEL[m]), key].join('+')
}

export function defaultClosePopup(_os: ShortcutOs): ShortcutBinding {
  return { key: 'escape', mods: ['control'] }
}

export function parseClosePopup(raw: unknown, os: ShortcutOs): ShortcutBinding {
  if (raw && typeof raw === 'object') {
    return { key: 'escape', mods: normMods((raw as { mods?: unknown }).mods) }
  }
  return defaultClosePopup(os)
}

export function closePopupMatches(binding: ShortcutBinding, e: KeyEventLike): boolean {
  if (e.key !== 'Escape' && e.code !== 'Escape') return false
  return modsMatch(e, binding.mods)
}
