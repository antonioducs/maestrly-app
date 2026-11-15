import path from 'node:path'
import { existsSync } from 'node:fs'

// Not __dirname: electron-vite adds its own to the bundle, which Rolldown does not rename this one around.
const moduleDir = import.meta.dirname

/**
 * Compiled window.api preload path shared by mainWindow and floating windows. A separate module avoids
 * importing the main entry point and exposes the same typed API everywhere.
 */
export function resolvePreload(): string {
  const mjs = path.join(moduleDir, '../preload/index.mjs')
  const js = path.join(moduleDir, '../preload/index.js')
  return existsSync(mjs) ? mjs : js
}
