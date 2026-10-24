import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, type Session } from 'electron'

const PRELOAD_FILE = path.join('resources', 'browser-page-preload.cjs')

/**
 * Where the preload of the drawer browser's pages ships. It is a plain CommonJS resource, not part of the bundle: a
 * sandboxed preload cannot load modules, and the file must not carry the app bridge of `src/preload`. The app path is
 * the project folder when run from it and the archive when packaged, but the bundled entry itself (`out/main`) when it
 * is launched by file, as the E2E tests do: the resource then sits two folders up.
 */
export function browserPagePreloadPath(appPath: string = app.getAppPath()): string {
  const roots = [appPath, path.resolve(appPath, '..', '..')]
  const root = roots.find((candidate) => existsSync(path.join(candidate, PRELOAD_FILE))) ?? appPath
  return path.join(root, PRELOAD_FILE)
}

/**
 * Runs the preload in every page and popup of the session, before the page's own scripts. It gives them the
 * `window.chrome` members (`app`, `csi`, `loadTimes`) that Electron's Chromium lacks and Google's sign-in requires:
 * without them it answers "This browser or app may not be secure".
 */
export function registerBrowserPagePreload(browserSession: Session, appPath?: string): void {
  browserSession.registerPreloadScript({ type: 'frame', filePath: browserPagePreloadPath(appPath) })
}
