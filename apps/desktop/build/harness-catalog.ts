import { readdirSync, readFileSync, statSync } from 'node:fs'
import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHarnessRegistry } from '../src/main/chat/harness/registry'
import type { HarnessRegistry, HarnessSources } from '../src/main/chat/harness/types'

export const HARNESS_PROFILES_DIR = resolve(__dirname, '../src/main/chat/harness/profiles')

/**
 * Filesystem scanner used by the build and by tests. Runtime never reads from disk: the bundler
 * inlines the same files, and both paths must produce byte-identical sources.
 */
export function readHarnessSources(root: string = HARNESS_PROFILES_DIR): HarnessSources {
  const sources: Record<string, string> = {}
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`[harness] "${entry.name}" must be a real profile directory, not a symlink or file`)
    }
  }
  const folders = entries.map((entry) => entry.name)
  for (const folder of folders) {
    const folderPath = join(root, folder)
    const files = readdirSync(folderPath, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort()
    for (const file of files) {
      const filePath = join(folderPath, file)
      const stats = lstatSync(filePath)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`[harness] ${folder}/${file} must be a regular file`)
      }
      if (file !== 'config.json' && !file.endsWith('.md')) continue
      sources[`profiles/${folder}/${file}`] = readFileSync(filePath, 'utf8')
    }
    if (!sources[`profiles/${folder}/config.json`]) {
      throw new Error(`[harness] profile folder "${folder}" is missing config.json`)
    }
  }
  return sources
}

/** Validates the catalog with the very same pure core the runtime uses. */
export function validateHarnessCatalog(root: string = HARNESS_PROFILES_DIR): HarnessRegistry {
  return createHarnessRegistry(readHarnessSources(root))
}

/** Files and directories the dev server must watch so a new folder triggers a rebuild. */
export function harnessCatalogWatchPaths(root: string = HARNESS_PROFILES_DIR): string[] {
  const paths = [root]
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folderPath = join(root, entry.name)
    paths.push(folderPath)
    for (const file of readdirSync(folderPath)) {
      const filePath = join(folderPath, file)
      if (statSync(filePath).isFile()) paths.push(filePath)
    }
  }
  return paths.sort()
}
