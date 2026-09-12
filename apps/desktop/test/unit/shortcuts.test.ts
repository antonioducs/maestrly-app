import { describe, expect, it } from 'vitest'
import { FLOAT_TABS } from '../../src/shared/tool-tabs'
import {
  defaultShortcuts,
  parseShortcuts,
  mergeShortcuts,
  matchShortcut,
  matchDetachShortcut,
  detachVariant,
  bindingMatchesEvent,
  findConflicts,
  conflictingTabs,
  isValidBinding,
  formatAccelerator,
  eventKey,
  osFromPlatform,
  defaultClosePopup,
  defaultDrawerShortcut,
  parseDrawerShortcut,
  parseClosePopup,
  closePopupMatches,
  type ShortcutBinding,
} from '../../src/shared/shortcuts'

describe('osFromPlatform', () => {
  it('normalizes process.platform', () => {
    expect(osFromPlatform('darwin')).toBe('mac')
    expect(osFromPlatform('win32')).toBe('win')
    expect(osFromPlatform('linux')).toBe('linux')
    expect(osFromPlatform('freebsd')).toBe('linux')
  })
})

describe('defaultShortcuts', () => {
  it('mac uses meta+control; Windows and Linux use control+alt', () => {
    const mac = defaultShortcuts('mac')
    const win = defaultShortcuts('win')
    expect(mac.browser).toEqual({ key: 'b', mods: ['meta', 'control'] })
    expect(win.browser).toEqual({ key: 'b', mods: ['control', 'alt'] })
    expect(defaultShortcuts('linux').notes).toEqual({ key: 'n', mods: ['control', 'alt'] })
    expect(defaultShortcuts('mac').chatgpt).toEqual({ key: 'g', mods: ['meta', 'control'] })
  })

  it('covers all seven tools with distinct letters and at least two OS-safe modifiers', () => {
    const mac = defaultShortcuts('mac')
    expect(Object.keys(mac).sort()).toEqual([...FLOAT_TABS].sort())
    const keys = FLOAT_TABS.map((t) => mac[t]!.key)
    expect(new Set(keys).size).toBe(FLOAT_TABS.length) // No letter collisions.
    for (const t of FLOAT_TABS) expect(isValidBinding(mac[t]!)).toBe(true)
    expect(findConflicts(mac)).toHaveLength(0) // Defaults never conflict.
  })
})

describe('drawer shortcut', () => {
  it('uses D with OS-safe modifiers and parses defensively', () => {
    expect(defaultDrawerShortcut('mac')).toEqual({ key: 'd', mods: ['meta', 'control'] })
    expect(defaultDrawerShortcut('win')).toEqual({ key: 'd', mods: ['control', 'alt'] })
    expect(parseDrawerShortcut({ key: 'X', mods: ['meta', 'control'] }, 'mac')).toEqual({
      key: 'x',
      mods: ['meta', 'control'],
    })
    expect(parseDrawerShortcut(null, 'linux')).toEqual(defaultDrawerShortcut('linux'))
    expect(parseDrawerShortcut({ key: 'x', mods: ['meta'] }, 'mac')).toEqual(defaultDrawerShortcut('mac'))
  })
})

describe('parseShortcuts (defensive)', () => {
  it('invalid values or types return {} for all defaults', () => {
    expect(parseShortcuts(null)).toEqual({})
    expect(parseShortcuts(42)).toEqual({})
    expect(parseShortcuts('nope')).toEqual({})
    expect(parseShortcuts({ browser: { mods: ['meta'] } })).toEqual({}) // Discard entries without a key.
    expect(parseShortcuts({ unknownTool: { key: 'x', mods: [] } })).toEqual({}) // Unknown tool.
  })

  it('preserves null for disabled shortcuts and normalizes invalid modifiers', () => {
    const cfg = parseShortcuts({ terminal: null, browser: { key: 'B', mods: ['meta', 'bogus', 'control'] } })
    expect(cfg.terminal).toBeNull()
    expect(cfg.browser).toEqual({ key: 'b', mods: ['meta', 'control'] }) // Discard bogus and lowercase the key.
  })
})

describe('mergeShortcuts', () => {
  it('missing override uses default; null disables; binding replaces', () => {
    const eff = mergeShortcuts('mac', {
      vscode: null,
      terminal: { key: 't', mods: ['meta', 'shift'] },
    })
    expect(eff.browser).toEqual(defaultShortcuts('mac').browser) // Missing override uses the default.
    expect(eff.vscode).toBeNull() // Disabled.
    expect(eff.terminal).toEqual({ key: 't', mods: ['meta', 'shift'] }) // Replaced.
  })
})

describe('eventKey', () => {
  it('prefers physical code regardless of keyboard layout or case', () => {
    expect(eventKey({ code: 'KeyB' })).toBe('b')
    expect(eventKey({ code: 'KeyB', key: 'B' })).toBe('b')
    expect(eventKey({ code: 'Digit1' })).toBe('1')
    expect(eventKey({ key: 'b' })).toBe('b') // Fall back when code is absent.
    expect(eventKey({ key: 'Escape' })).toBe('') // Cannot be normalized.
  })
})

describe('matchShortcut / bindingMatchesEvent', () => {
  const eff = defaultShortcuts('mac') // browser = ⌘⌃B

  it('matches exact combinations and rejects extra or missing modifiers', () => {
    expect(matchShortcut({ code: 'KeyB', meta: true, control: true }, eff)).toBe('browser')
    expect(matchShortcut({ code: 'KeyB', meta: true }, eff)).toBeNull() // Missing control modifier.
    expect(matchShortcut({ code: 'KeyB', meta: true, control: true, shift: true }, eff)).toBeNull() // Extra shift modifier.
    expect(matchShortcut({ code: 'KeyX', meta: true, control: true }, eff)).toBeNull() // Wrong key.
  })

  it('disabled null bindings never match', () => {
    expect(bindingMatchesEvent(null, { code: 'KeyB', meta: true, control: true })).toBe(false)
  })

  it('each tool matches its own combination', () => {
    expect(matchShortcut({ code: 'KeyJ', meta: true, control: true }, eff)).toBe('terminal')
    expect(matchShortcut({ code: 'KeyN', meta: true, control: true }, eff)).toBe('notes')
  })
})

describe('matchDetachShortcut / detachVariant (Shift + tool shortcut)', () => {
  const eff = defaultShortcuts('mac') // terminal = ⌘⌃J

  it('the Shift variant matches the correct tool; without Shift, returns null for matchShortcut', () => {
    expect(matchDetachShortcut({ code: 'KeyJ', meta: true, control: true, shift: true }, eff)).toBe('terminal')
    expect(matchDetachShortcut({ code: 'KeyB', meta: true, control: true, shift: true }, eff)).toBe('browser')
    expect(matchDetachShortcut({ code: 'KeyJ', meta: true, control: true }, eff)).toBeNull()
  })

  it('extra or missing modifiers and incorrect keys do not match', () => {
    expect(matchDetachShortcut({ code: 'KeyJ', meta: true, shift: true }, eff)).toBeNull() // Missing control modifier.
    expect(matchDetachShortcut({ code: 'KeyJ', meta: true, control: true, alt: true, shift: true }, eff)).toBeNull()
    expect(matchDetachShortcut({ code: 'KeyX', meta: true, control: true, shift: true }, eff)).toBeNull()
  })

  it('bindings already containing Shift have no variant because the combination opens the tool', () => {
    const custom = mergeShortcuts('mac', { terminal: { key: 'j', mods: ['meta', 'control', 'shift'] } })
    expect(detachVariant(custom.terminal)).toBeNull()
    expect(matchDetachShortcut({ code: 'KeyJ', meta: true, control: true, shift: true }, custom)).toBeNull()
    // Normal opening still matches the custom combination.
    expect(matchShortcut({ code: 'KeyJ', meta: true, control: true, shift: true }, custom)).toBe('terminal')
  })

  it('disabled bindings have no variant', () => {
    const off = mergeShortcuts('mac', { terminal: null })
    expect(detachVariant(off.terminal)).toBeNull()
    expect(matchDetachShortcut({ code: 'KeyJ', meta: true, control: true, shift: true }, off)).toBeNull()
  })

  it('detachVariant returns the binding modifiers plus Shift for the UI tooltip', () => {
    expect(detachVariant({ key: 'j', mods: ['meta', 'control'] })).toEqual({
      key: 'j',
      mods: ['meta', 'control', 'shift'],
    })
  })
})

describe('findConflicts / conflictingTabs', () => {
  it('detects two tools sharing a combination', () => {
    const b: ShortcutBinding = { key: 'b', mods: ['meta', 'control'] }
    const eff = mergeShortcuts('mac', { browser: b, terminal: { ...b } })
    const groups = findConflicts(eff)
    expect(groups).toHaveLength(1)
    expect(new Set(groups[0])).toEqual(new Set(['browser', 'terminal']))
    expect(conflictingTabs(eff)).toEqual(new Set(['browser', 'terminal']))
  })
})

describe('isValidBinding', () => {
  it('requires at least two modifiers and a key', () => {
    expect(isValidBinding({ key: 'b', mods: ['meta', 'control'] })).toBe(true)
    expect(isValidBinding({ key: 'b', mods: ['meta'] })).toBe(false) // One modifier.
    expect(isValidBinding({ key: '', mods: ['meta', 'control'] })).toBe(false) // No key.
  })
})

describe('formatAccelerator', () => {
  it('mac uses symbols; Windows and Linux use Ctrl+Alt+Key', () => {
    const b: ShortcutBinding = { key: 'b', mods: ['control', 'meta'] }
    expect(formatAccelerator(b, 'mac')).toBe('⌘⌃B') // Canonical order: meta, control.
    expect(formatAccelerator({ key: 'b', mods: ['control', 'alt'] }, 'win')).toBe('Ctrl+Alt+B')
  })

  it('formats the escape key as Esc for the close shortcut', () => {
    expect(formatAccelerator({ key: 'escape', mods: ['meta'] }, 'mac')).toBe('⌘Esc')
    expect(formatAccelerator({ key: 'escape', mods: [] }, 'mac')).toBe('Esc')
    expect(formatAccelerator({ key: 'escape', mods: ['control'] }, 'win')).toBe('Ctrl+Esc')
  })
})

describe('popup close shortcut (Esc + modifiers)', () => {
  it('defaults to Ctrl+Esc on every OS; macOS intercepts Cmd+Esc before before-input-event', () => {
    expect(defaultClosePopup('mac')).toEqual({ key: 'escape', mods: ['control'] })
    expect(defaultClosePopup('win')).toEqual({ key: 'escape', mods: ['control'] })
    expect(defaultClosePopup('linux')).toEqual({ key: 'escape', mods: ['control'] })
  })

  it('parsing uses only modifiers and forces Escape; invalid input uses defaults', () => {
    expect(parseClosePopup({ key: 'x', mods: ['alt'] }, 'mac')).toEqual({ key: 'escape', mods: ['alt'] })
    expect(parseClosePopup({ mods: [] }, 'mac')).toEqual({ key: 'escape', mods: [] }) // Unmodified Escape is valid.
    expect(parseClosePopup(null, 'mac')).toEqual({ key: 'escape', mods: ['control'] }) // default
  })

  it('matches Escape with exactly the binding modifiers', () => {
    const b = defaultClosePopup('mac') // ⌃+Esc
    expect(closePopupMatches(b, { key: 'Escape', control: true })).toBe(true)
    expect(closePopupMatches(b, { key: 'Escape' })).toBe(false) // Unmodified Escape does not match and reaches the modal.
    expect(closePopupMatches(b, { key: 'Escape', control: true, shift: true })).toBe(false) // Extra modifier.
    expect(closePopupMatches(b, { key: 'b', control: true })).toBe(false) // Different key.
    expect(closePopupMatches({ key: 'escape', mods: [] }, { key: 'Escape' })).toBe(true) // Configured unmodified Escape.
  })
})
