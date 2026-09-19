import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_ORDER,
  closeTabInList,
  mainTabsForFeatures,
  moveOpenTab,
  openTabInList,
  reorderVisibleTabs,
  sanitizeMainOrder,
  sanitizeOpenTabs,
} from '../../src/renderer/lib/drawer-tabs'

describe('on-demand open tabs', () => {
  it('sanitizes persisted open tabs: drops unknown, duplicated and unavailable entries', () => {
    expect(sanitizeOpenTabs(['terminal', 'card', 'terminal', 'chatgpt', 'notes'], { id: 'c' }, false)).toEqual([
      'terminal',
      'notes',
    ])
    expect(sanitizeOpenTabs(['notes'], null)).toEqual([])
    expect(sanitizeOpenTabs(undefined, { id: 'c' })).toEqual([])
  })

  it('opens a tab only once, keeping the array identity when already open', () => {
    const list = ['browser'] as const
    expect(openTabInList([...list], 'terminal')).toEqual(['browser', 'terminal'])
    const same = [...list]
    expect(openTabInList(same, 'browser')).toBe(same)
  })

  it('closing the active tab activates the right neighbour, then the left, then null', () => {
    expect(closeTabInList(['a', 'b', 'c'] as never, 'b' as never, 'b' as never)).toEqual({
      list: ['a', 'c'],
      active: 'c',
    })
    expect(closeTabInList(['a', 'b'] as never, 'b' as never, 'b' as never)).toEqual({ list: ['a'], active: 'a' })
    expect(closeTabInList(['a'] as never, 'a' as never, 'a' as never)).toEqual({ list: [], active: null })
  })

  it('closing an inactive tab keeps the active one', () => {
    expect(closeTabInList(['browser', 'terminal', 'plan'], 'plan', 'browser')).toEqual({
      list: ['browser', 'terminal'],
      active: 'browser',
    })
    expect(closeTabInList(['browser'], 'plan', 'browser')).toEqual({ list: ['browser'], active: 'browser' })
  })

  it('moves open tabs and ignores out-of-range indexes', () => {
    const list = ['browser', 'terminal', 'plan'] as const
    expect(moveOpenTab([...list], 0, 2)).toEqual(['terminal', 'plan', 'browser'])
    const same = [...list]
    expect(moveOpenTab(same, 0, 5)).toBe(same)
    expect(moveOpenTab(same, 1, 1)).toBe(same)
  })
})

describe('conditional drawer tabs', () => {
  it('hides ChatGPT when the feature is disabled and retains it when enabled', () => {
    expect(mainTabsForFeatures(DEFAULT_MAIN_ORDER, false)).not.toContain('chatgpt')
    expect(mainTabsForFeatures(DEFAULT_MAIN_ORDER, true)).toContain('chatgpt')
  })

  it('reorders visible tabs without moving the hidden experimental tab', () => {
    const full = ['browser', 'chatgpt', 'terminal', 'plan'] as const
    const visible = mainTabsForFeatures([...full], false)
    expect(reorderVisibleTabs([...full], visible, 0, 2)).toEqual(['terminal', 'chatgpt', 'plan', 'browser'])
  })

  it('removes the legacy delegations tab from persisted preferences', () => {
    expect(sanitizeMainOrder(['terminal', 'delegations', 'browser'])).not.toContain('delegations')
  })
})
