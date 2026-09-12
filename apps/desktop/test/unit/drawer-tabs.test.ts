import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_ORDER,
  mainTabsForFeatures,
  reorderVisibleTabs,
  sanitizeMainOrder,
} from '../../src/renderer/lib/drawer-tabs'

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
