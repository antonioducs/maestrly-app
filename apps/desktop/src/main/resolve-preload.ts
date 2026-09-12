import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Compiled window.api preload path shared by mainWindow and floating windows. A separate module avoids
 * importing the main entry point and exposes the same typed API everywhere.
 */
export function resolvePreload(): string {
  const mjs = path.join(__dirname, '../preload/index.mjs')
  const js = path.join(__dirname, '../preload/index.js')
  return existsSync(mjs) ? mjs : js
}
