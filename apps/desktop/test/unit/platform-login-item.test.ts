import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  applyExecutorLoginItem,
  LOGIN_LAUNCH_ARG,
  shouldStartHidden,
  wasLaunchedAtLogin,
} from '../../src/main/platform/login-item'

type LoginItemApp = NonNullable<Parameters<typeof applyExecutorLoginItem>[1]>

function fakeApp(wasOpenedAtLogin = false) {
  return {
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ wasOpenedAtLogin })),
  } as unknown as LoginItemApp & {
    setLoginItemSettings: ReturnType<typeof vi.fn>
    getLoginItemSettings: ReturnType<typeof vi.fn>
  }
}

describe('executor login item', () => {
  it('registers without the removed openAsHidden attribute and marks Windows login launches', () => {
    const mac = fakeApp()
    applyExecutorLoginItem({ autoStart: true }, mac, 'darwin')
    expect(mac.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    const windows = fakeApp()
    applyExecutorLoginItem({ autoStart: true }, windows, 'win32')
    applyExecutorLoginItem({ autoStart: false }, windows, 'win32')
    expect(windows.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, args: [LOGIN_LAUNCH_ARG] }],
      [{ openAtLogin: false, args: [LOGIN_LAUNCH_ARG] }],
    ])
    for (const [settings] of [...mac.setLoginItemSettings.mock.calls, ...windows.setLoginItemSettings.mock.calls])
      expect(settings).not.toHaveProperty('openAsHidden')
  })

  it('detects login launches from macOS login item state or the Windows login argument', () => {
    expect(wasLaunchedAtLogin(fakeApp(true), ['/Applications/Maestrly App'], 'darwin')).toBe(true)
    expect(wasLaunchedAtLogin(fakeApp(false), ['/Applications/Maestrly App'], 'darwin')).toBe(false)
    expect(wasLaunchedAtLogin(fakeApp(), ['Maestrly App.exe', LOGIN_LAUNCH_ARG], 'win32')).toBe(true)
    const windows = fakeApp(true)
    expect(wasLaunchedAtLogin(windows, ['Maestrly App.exe'], 'win32')).toBe(false)
    expect(windows.getLoginItemSettings).not.toHaveBeenCalled()
    expect(wasLaunchedAtLogin(fakeApp(true), ['maestrly-app'], 'linux')).toBe(false)
  })

  it('starts hidden only for a background executor launched by its login item', () => {
    expect(shouldStartHidden({ autoStart: true, background: true }, true)).toBe(true)
    expect(shouldStartHidden({ autoStart: true, background: true }, false)).toBe(false)
    expect(shouldStartHidden({ autoStart: true, background: false }, true)).toBe(false)
    expect(shouldStartHidden({ autoStart: false, background: true }, true)).toBe(false)
  })

  it('applies the hidden decision to the first main window only', () => {
    const index = readFileSync('src/main/index.ts', 'utf8')
    const platformIpc = readFileSync('src/main/platform/platform-ipc.ts', 'utf8')
    expect(index).toContain(
      'startHiddenAtLogin = !isBotMode() && shouldStartHidden(executorSettings(), wasLaunchedAtLogin())'
    )
    expect(index).toContain('show: !isBotMode() && !startHidden')
    expect(index).toContain('if (!win.isVisible()) win.show()')
    expect(platformIpc).toContain('if (app.isPackaged && !isE2E()) applyExecutorLoginItem(value)')
    expect(platformIpc).not.toContain('openAsHidden')
  })
})
