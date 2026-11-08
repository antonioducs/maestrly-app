import { globalShortcut } from 'electron'
import { ASSISTANT_TOGGLE_FLAG } from '../../shared/assistant'
import type { ShortcutBinding, ShortcutMod } from '../../shared/shortcuts'

// Electron maps Super to Cmd on macOS and to the Windows/Super key elsewhere.
const MODIFIER: Record<ShortcutMod, string> = { meta: 'Super', control: 'Control', alt: 'Alt', shift: 'Shift' }
const MOD_ORDER: ShortcutMod[] = ['meta', 'control', 'alt', 'shift']
const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
}

function acceleratorKey(key: string): string | null {
  const k = key.trim().toLowerCase()
  if (/^[a-z]$/.test(k)) return k.toUpperCase()
  if (/^[0-9]$/.test(k)) return k
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(k)
  if (fn) return `F${fn[1]}`
  return NAMED_KEYS[k] ?? null
}

/**
 * Electron accelerator for a binding, or null when it cannot be one. A global shortcut needs a modifier other than
 * Shift: Shift and a letter would take that letter from every application.
 */
export function bindingToAccelerator(binding: ShortcutBinding): string | null {
  const key = acceleratorKey(binding.key)
  if (!key) return null
  const mods = MOD_ORDER.filter((mod) => binding.mods.includes(mod))
  if (!mods.some((mod) => mod !== 'shift')) return null
  return [...mods.map((mod) => MODIFIER[mod]), key].join('+')
}

let current: string | null = null

export type AssistantShortcutResult = { ok: true } | { ok: false; reason: 'conflict' | 'unsupported' }

/**
 * Register the assistant's global shortcut, replacing the previous one. A shortcut that cannot be registered (another
 * app holds it) or expressed keeps the previous one working. Null turns it off.
 */
export function registerAssistantShortcut(
  binding: ShortcutBinding | null,
  onPress: () => void
): AssistantShortcutResult {
  if (!binding) {
    unregisterAssistantShortcut()
    return { ok: true }
  }
  const accelerator = bindingToAccelerator(binding)
  if (!accelerator) return { ok: false, reason: 'unsupported' }
  if (accelerator === current) {
    globalShortcut.unregister(accelerator)
    if (!globalShortcut.register(accelerator, onPress)) {
      current = null
      return { ok: false, reason: 'conflict' }
    }
    return { ok: true }
  }
  let registered = false
  try {
    registered = globalShortcut.register(accelerator, onPress)
  } catch {
    return { ok: false, reason: 'unsupported' }
  }
  if (!registered) return { ok: false, reason: 'conflict' }
  if (current) globalShortcut.unregister(current)
  current = accelerator
  return { ok: true }
}

export function unregisterAssistantShortcut(): void {
  if (current) globalShortcut.unregister(current)
  current = null
}

export function parseAssistantArgv(argv: readonly string[]): { toggleAssistant: boolean } {
  return { toggleAssistant: argv.includes(ASSISTANT_TOGGLE_FLAG) }
}
