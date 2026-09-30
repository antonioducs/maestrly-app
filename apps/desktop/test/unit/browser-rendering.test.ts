import { describe, expect, it, vi } from 'vitest'
import { refreshUnthrottledBrowserRendering } from '../../src/main/drawer/browser-rendering'

function renderer(throttled = false) {
  const target = {
    isDestroyed: vi.fn(() => false),
    getBackgroundThrottling: vi.fn(() => throttled),
    setBackgroundThrottling: vi.fn((value: boolean) => {
      throttled = value
    }),
  }
  return target
}

describe('browser rendering after navigation', () => {
  it('refreshes an active Linux view and retains its unthrottled policy', () => {
    const target = renderer()
    refreshUnthrottledBrowserRendering(target, 'linux')
    expect(target.setBackgroundThrottling.mock.calls).toEqual([[true], [false]])
    expect(target.getBackgroundThrottling()).toBe(false)
  })

  it('does not wake an idle throttled view', () => {
    const target = renderer(true)
    refreshUnthrottledBrowserRendering(target, 'linux')
    expect(target.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(target.getBackgroundThrottling()).toBe(true)
  })

  it.each(['darwin', 'win32'] as const)('leaves %s rendering unchanged', (platform) => {
    const target = renderer()
    refreshUnthrottledBrowserRendering(target, platform)
    expect(target.setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('ignores destroyed views without inspecting native state', () => {
    const target = renderer()
    target.isDestroyed.mockReturnValue(true)
    refreshUnthrottledBrowserRendering(target, 'linux')
    expect(target.getBackgroundThrottling).not.toHaveBeenCalled()
    expect(target.setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('restores the policy after a native error without taking down navigation', () => {
    const target = renderer()
    target.setBackgroundThrottling.mockImplementationOnce(() => {
      throw new Error('renderer replaced')
    })
    expect(() => refreshUnthrottledBrowserRendering(target, 'linux')).not.toThrow()
    expect(target.setBackgroundThrottling.mock.calls).toEqual([[true], [false]])
    expect(target.getBackgroundThrottling()).toBe(false)
  })

  it('does not call a view destroyed during the transition', () => {
    const target = renderer()
    target.setBackgroundThrottling.mockImplementationOnce(() => {
      target.isDestroyed.mockReturnValue(true)
    })
    expect(() => refreshUnthrottledBrowserRendering(target, 'linux')).not.toThrow()
    expect(target.setBackgroundThrottling.mock.calls).toEqual([[true]])
  })
})
