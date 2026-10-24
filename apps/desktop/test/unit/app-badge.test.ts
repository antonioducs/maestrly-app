import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  nativeImage: { createFromBitmap: (buffer: Buffer, size: { width: number; height: number }) => ({ buffer, size }) },
}))

import { AppBadge } from '../../src/main/notifications/app-badge'

function setup(platform: NodeJS.Platform) {
  const setBadgeCount = vi.fn()
  const window = { isDestroyed: () => false, setOverlayIcon: vi.fn() }
  let hasWindow = true
  const badge = new AppBadge({
    platform,
    setBadgeCount,
    mainWindow: () => (hasWindow ? (window as never) : null),
    description: (count) => `${count} need you`,
  })
  return { badge, setBadgeCount, window, noWindow: () => void (hasWindow = false) }
}

describe('AppBadge', () => {
  it('counts on the app icon, once per change, ignoring what is not a count', () => {
    const s = setup('darwin')
    s.badge.set(3)
    s.badge.set(3)
    s.badge.set(-1)
    s.badge.set('7')
    s.badge.set(1.5)
    s.badge.set(100_000)
    expect(s.setBadgeCount.mock.calls).toEqual([[3], [0], [9_999]])
    expect(s.window.setOverlayIcon).not.toHaveBeenCalled()
  })

  it('marks the taskbar button on Windows, and marks it again on a new window', () => {
    const s = setup('win32')
    s.badge.set(2)
    const [[image, description]] = s.window.setOverlayIcon.mock.calls
    expect(image).toMatchObject({ size: { width: 16, height: 16 } })
    expect(description).toBe('2 need you')
    s.badge.apply()
    expect(s.window.setOverlayIcon).toHaveBeenCalledTimes(2)
    s.badge.set(0)
    expect(s.window.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    s.noWindow()
    expect(() => s.badge.set(4)).not.toThrow()
    expect(s.setBadgeCount).not.toHaveBeenCalled()
  })
})
