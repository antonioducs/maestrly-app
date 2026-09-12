import { describe, expect, it } from 'vitest'
import { TERMINAL_SEARCH_OPTIONS, isTerminalSearchShortcut } from '../../src/renderer/lib/terminal-search'

function key(overrides: Partial<Parameters<typeof isTerminalSearchShortcut>[0]> = {}) {
  return {
    key: 'f',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  }
}

describe('terminal search', () => {
  it('configures highlighting for all matches and distinguishes the active result', () => {
    expect(TERMINAL_SEARCH_OPTIONS.decorations).toEqual(
      expect.objectContaining({
        matchBackground: expect.any(String),
        matchOverviewRuler: expect.any(String),
        activeMatchBackground: expect.any(String),
        activeMatchColorOverviewRuler: expect.any(String),
      })
    )
    expect(TERMINAL_SEARCH_OPTIONS.decorations?.activeMatchBackground).not.toBe(
      TERMINAL_SEARCH_OPTIONS.decorations?.matchBackground
    )
  })

  it('uses Cmd+F on macOS', () => {
    expect(isTerminalSearchShortcut(key({ metaKey: true }), 'mac')).toBe(true)
    expect(isTerminalSearchShortcut(key({ ctrlKey: true }), 'mac')).toBe(false)
  })

  it('uses Ctrl+F on Windows and Linux', () => {
    expect(isTerminalSearchShortcut(key({ ctrlKey: true }), 'win')).toBe(true)
    expect(isTerminalSearchShortcut(key({ ctrlKey: true, key: 'F' }), 'linux')).toBe(true)
    expect(isTerminalSearchShortcut(key({ metaKey: true }), 'linux')).toBe(false)
  })

  it('does not intercept extra modifiers or Ctrl+R', () => {
    expect(isTerminalSearchShortcut(key({ ctrlKey: true, shiftKey: true }), 'linux')).toBe(false)
    expect(isTerminalSearchShortcut(key({ metaKey: true, altKey: true }), 'mac')).toBe(false)
    expect(isTerminalSearchShortcut(key({ ctrlKey: true, key: 'r' }), 'linux')).toBe(false)
  })
})
