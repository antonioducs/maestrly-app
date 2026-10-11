import { app } from 'electron'
import type { DesktopExecutorSettings } from './executor-settings'

/**
 * Marks a launch by the Windows login item. macOS login items take no arguments; Electron reports those
 * launches through `getLoginItemSettings().wasOpenedAtLogin` instead.
 */
export const LOGIN_LAUNCH_ARG = '--maestrly-login-launch'

type LoginItemApp = Pick<typeof app, 'getLoginItemSettings' | 'setLoginItemSettings'>

/** Registers or removes the login item. Hidden startup no longer uses the `openAsHidden` removed in Electron 44. */
export function applyExecutorLoginItem(
  settings: Pick<DesktopExecutorSettings, 'autoStart'>,
  target: LoginItemApp = app,
  platform: NodeJS.Platform = process.platform
): void {
  target.setLoginItemSettings({
    openAtLogin: settings.autoStart,
    ...(platform === 'win32' ? { args: [LOGIN_LAUNCH_ARG] } : {}),
  })
}

export function wasLaunchedAtLogin(
  target: LoginItemApp = app,
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (argv.includes(LOGIN_LAUNCH_ARG)) return true
  return platform === 'darwin' && target.getLoginItemSettings().wasOpenedAtLogin === true
}

/**
 * A background executor started by its login item opens without showing the main window, as `openAsHidden`
 * did on macOS 12. The tray, dock activation, or another launch reveals it; closing it hides it again.
 */
export function shouldStartHidden(
  settings: Pick<DesktopExecutorSettings, 'autoStart' | 'background'>,
  launchedAtLogin: boolean
): boolean {
  return launchedAtLogin && settings.autoStart && settings.background
}
