import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  registered: new Map<string, () => void>(),
  taken: new Set<string>(),
}))
vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (h.taken.has(accelerator)) return false
      h.registered.set(accelerator, callback)
      return true
    },
    unregister: (accelerator: string) => h.registered.delete(accelerator),
  },
}))

import {
  bindingToAccelerator,
  parseAssistantArgv,
  registerAssistantShortcut,
  unregisterAssistantShortcut,
} from '../../src/main/assistant/assistant-shortcut'
import {
  bindingFromKeyPress,
  defaultAssistantShortcut,
  effectiveAssistantShortcut,
  parseAssistantSettings,
} from '../../src/shared/assistant'

beforeEach(() => {
  unregisterAssistantShortcut()
  h.registered.clear()
  h.taken.clear()
})

it.each([
  [{ key: 'space', mods: ['meta', 'shift'] }, 'Super+Shift+Space'],
  [{ key: 'space', mods: ['control', 'shift'] }, 'Control+Shift+Space'],
  [{ key: 'k', mods: ['alt', 'control'] }, 'Control+Alt+K'],
  [{ key: 'f12', mods: ['control'] }, 'Control+F12'],
  [{ key: 'arrowup', mods: ['meta'] }, 'Super+Up'],
  [{ key: '7', mods: ['alt'] }, 'Alt+7'],
  [{ key: 'enter', mods: ['control', 'alt', 'shift', 'meta'] }, 'Super+Control+Alt+Shift+Enter'],
] as const)('turns %j into %s', (binding, accelerator) => {
  expect(bindingToAccelerator({ key: binding.key, mods: [...binding.mods] })).toBe(accelerator)
})

it.each([
  { key: 'é', mods: ['control'] },
  { key: 'f25', mods: ['control'] },
  { key: 'a', mods: ['shift'] },
  { key: 'a', mods: [] },
] as const)('refuses %j', (binding) => {
  expect(bindingToAccelerator({ key: binding.key, mods: [...binding.mods] })).toBeNull()
})

it('uses ⌘⇧Space on macOS and Ctrl+Shift+Space elsewhere unless the person chose another or none', () => {
  expect(defaultAssistantShortcut('mac')).toEqual({ key: 'space', mods: ['meta', 'shift'] })
  expect(defaultAssistantShortcut('win')).toEqual({ key: 'space', mods: ['control', 'shift'] })
  expect(effectiveAssistantShortcut(parseAssistantSettings({}), 'linux')).toEqual({
    key: 'space',
    mods: ['control', 'shift'],
  })
  expect(effectiveAssistantShortcut(parseAssistantSettings({ shortcut: null }), 'mac')).toBeNull()
  const chosen = { key: 'j', mods: ['alt' as const, 'meta' as const] }
  expect(effectiveAssistantShortcut(parseAssistantSettings({ shortcut: chosen }), 'mac')).toEqual(chosen)
})

it('registers the shortcut and calls back on press', () => {
  const pressed = vi.fn()
  expect(registerAssistantShortcut({ key: 'space', mods: ['control', 'shift'] }, pressed)).toEqual({ ok: true })
  h.registered.get('Control+Shift+Space')?.()
  expect(pressed).toHaveBeenCalledOnce()
})

it('keeps the previous shortcut when another app holds the new one', () => {
  registerAssistantShortcut({ key: 'space', mods: ['control', 'shift'] }, () => {})
  h.taken.add('Control+Alt+K')
  expect(registerAssistantShortcut({ key: 'k', mods: ['control', 'alt'] }, () => {})).toEqual({
    ok: false,
    reason: 'conflict',
  })
  expect([...h.registered.keys()]).toEqual(['Control+Shift+Space'])
})

it('replaces the previous shortcut, and turns off with null', () => {
  registerAssistantShortcut({ key: 'space', mods: ['control', 'shift'] }, () => {})
  registerAssistantShortcut({ key: 'k', mods: ['control', 'alt'] }, () => {})
  expect([...h.registered.keys()]).toEqual(['Control+Alt+K'])
  registerAssistantShortcut(null, () => {})
  expect(h.registered.size).toBe(0)
})

it('reports a binding that cannot be a global shortcut', () => {
  expect(registerAssistantShortcut({ key: 'a', mods: ['shift'] }, () => {})).toEqual({
    ok: false,
    reason: 'unsupported',
  })
})

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>>) => ({
  code,
  key: code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

it('records a key press as a binding the accelerator accepts', () => {
  const binding = bindingFromKeyPress(press('Space', { metaKey: true, shiftKey: true }))
  expect(binding).toEqual({ key: 'space', mods: ['meta', 'shift'] })
  expect(bindingToAccelerator(binding as { key: string; mods: ('meta' | 'shift')[] })).toBe('Super+Shift+Space')
  expect(bindingFromKeyPress(press('KeyJ', { ctrlKey: true, altKey: true }))).toEqual({
    key: 'j',
    mods: ['control', 'alt'],
  })
  expect(bindingFromKeyPress(press('F9', { altKey: true }))).toEqual({ key: 'f9', mods: ['alt'] })
})

it('waits while only modifiers are held and refuses presses a global shortcut cannot use', () => {
  expect(bindingFromKeyPress(press('ShiftLeft', { shiftKey: true }))).toBeNull()
  expect(bindingFromKeyPress(press('KeyA', { shiftKey: true }))).toBe('invalid')
  expect(bindingFromKeyPress(press('KeyA', {}))).toBe('invalid')
  expect(bindingFromKeyPress(press('Backquote', { ctrlKey: true }))).toBe('invalid')
})

it('reads the toggle flag from the command line', () => {
  expect(parseAssistantArgv(['/app/maestrly', '--toggle-assistant'])).toEqual({ toggleAssistant: true })
  expect(parseAssistantArgv(['/app/maestrly'])).toEqual({ toggleAssistant: false })
})
