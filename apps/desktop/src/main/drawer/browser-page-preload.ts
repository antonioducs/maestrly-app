import path from 'node:path'
import { app, type Session } from 'electron'

/**
 * Where the preload of the drawer browser's pages ships. It is a plain CommonJS resource, not part of the bundle: a
 * sandboxed preload cannot load modules, and the file must not carry the app bridge of `src/preload`.
 */
export function browserPagePreloadPath(appPath: string = app.getAppPath()): string {
  return path.join(appPath, 'resources', 'browser-page-preload.cjs')
}

/**
 * Runs the preload in every page and popup of the session, before the page's own scripts. It gives them the
 * `window.chrome` members (`app`, `csi`, `loadTimes`) that Electron's Chromium lacks and Google's sign-in requires:
 * without them it answers "This browser or app may not be secure".
 */
export function registerBrowserPagePreload(browserSession: Session, appPath?: string): void {
  browserSession.registerPreloadScript({ type: 'frame', filePath: browserPagePreloadPath(appPath) })
}
